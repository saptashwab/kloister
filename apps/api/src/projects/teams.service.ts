import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AuditAction,
  ErrorCode,
  type Page,
  ProjectRole,
  type TeamDto,
  TeamRole,
} from '@kloister/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { ApiException } from '../common/api-exception.js';
import { type PageQueryDto, pageArgs, toPage } from '../common/pagination.js';
import { isUniqueViolation, mapTransactionConflict } from '../common/prisma-errors.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MEMBER_USER_SELECT } from './project.mapper.js';
import type { ProjectAccess } from './project-access.service.js';
import type { CreateTeamDto, SetTeamMemberDto, UpdateTeamDto } from './teams.dto.js';
import { assertStillPm } from './transaction-checks.js';

/** Prisma include that loads a team's members with their user details. */
const TEAM_INCLUDE = {
  members: { include: { projectMember: { include: { user: { select: MEMBER_USER_SELECT } } } } },
} as const;

/** Conflict message for a duplicate team name. */
const DUPLICATE_NAME = 'A team with this name already exists in the project';

/** A team row loaded with {@link TEAM_INCLUDE}. */
type TeamWithMembers = Prisma.TeamGetPayload<{ include: typeof TEAM_INCLUDE }>;

/**
 * Optional project teams (SPEC §3.5, §8 `projects/:id/teams`): listing,
 * creating, renaming and deleting teams, and setting who is in them with
 * which team role.
 *
 * Every change is made by a PM (checked by the guard and again inside a
 * serializable transaction). Team members must be project members, which
 * the database enforces too; project Viewers can only be team Members.
 */
@Injectable()
export class TeamsService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param audit Audit log.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lists the project's teams by name, each with its members.
   *
   * Permissions: any member, or an admin (audited by the access check).
   *
   * @param access The caller's access.
   * @param page Cursor and page size.
   * @returns One page of teams.
   */
  async list(access: ProjectAccess, page: PageQueryDto): Promise<Page<TeamDto>> {
    const rows = await this.prisma.team.findMany({
      where: { projectId: access.project.id },
      include: TEAM_INCLUDE,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      ...pageArgs(page),
    });
    return toPage(rows, page, toTeamDto);
  }

  /**
   * Creates a team.
   *
   * Permissions: PM only (`MANAGE_MEMBERS`); names are unique per project
   * (409 `CONFLICT`).
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param dto Name and description.
   * @returns The new team (201).
   */
  async create(auth: AuthContext, access: ProjectAccess, dto: CreateTeamDto): Promise<TeamDto> {
    const projectId = access.project.id;
    return this.change(async (tx) => {
      await assertStillPm(tx, projectId, auth.user.id);
      const team = await tx.team.create({
        data: { projectId, name: dto.name, description: dto.description ?? '' },
        include: TEAM_INCLUDE,
      });
      await this.record(tx, auth, projectId, AuditAction.TEAM_CREATED, team.id, {
        name: team.name,
      });
      return toTeamDto(team);
    }, DUPLICATE_NAME);
  }

  /**
   * Renames a team or changes its description.
   *
   * Permissions: PM only (`MANAGE_MEMBERS`); 404 for teams of other projects.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param teamId Team id.
   * @param dto Fields to change.
   * @returns The updated team.
   */
  async update(
    auth: AuthContext,
    access: ProjectAccess,
    teamId: string,
    dto: UpdateTeamDto,
  ): Promise<TeamDto> {
    const projectId = access.project.id;
    return this.change(async (tx) => {
      await assertStillPm(tx, projectId, auth.user.id);
      const current = await findTeam(tx, projectId, teamId);
      const changes: Record<string, { from: string; to: string }> = {};
      const data: Prisma.TeamUpdateInput = {};
      if (dto.name !== undefined && dto.name !== current.name) {
        changes['name'] = { from: current.name, to: dto.name };
        data.name = dto.name;
      }
      if (dto.description !== undefined && dto.description !== current.description) {
        changes['description'] = { from: current.description, to: dto.description };
        data.description = dto.description;
      }
      if (Object.keys(changes).length === 0) return toTeamDto(current);
      const team = await tx.team.update({ where: { id: teamId }, data, include: TEAM_INCLUDE });
      await this.record(tx, auth, projectId, AuditAction.TEAM_UPDATED, teamId, { changes });
      return toTeamDto(team);
    }, DUPLICATE_NAME);
  }

  /**
   * Deletes a team and its memberships. Users stay project members. (From
   * M3, the team's items are left without a team.)
   *
   * Permissions: PM only (`MANAGE_MEMBERS`).
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param teamId Team id.
   * @returns Resolves once deleted (204).
   */
  async remove(auth: AuthContext, access: ProjectAccess, teamId: string): Promise<void> {
    const projectId = access.project.id;
    await this.change(async (tx) => {
      await assertStillPm(tx, projectId, auth.user.id);
      const team = await findTeam(tx, projectId, teamId);
      await tx.team.delete({ where: { id: teamId } });
      await this.record(tx, auth, projectId, AuditAction.TEAM_DELETED, teamId, {
        name: team.name,
        members: team.members.length,
      });
    });
  }

  /**
   * Adds a project member to a team or changes their team role.
   *
   * Permissions: PM only (`MANAGE_MEMBERS`). The user must be a project
   * member and a project Viewer may not be a team Lead (400
   * `VALIDATION_FAILED` in both cases).
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param teamId Team id.
   * @param userId The user's id.
   * @param dto Team role.
   * @returns The updated team.
   */
  async setMember(
    auth: AuthContext,
    access: ProjectAccess,
    teamId: string,
    userId: string,
    dto: SetTeamMemberDto,
  ): Promise<TeamDto> {
    const projectId = access.project.id;
    return this.change(async (tx) => {
      await assertStillPm(tx, projectId, auth.user.id);
      const team = await findTeam(tx, projectId, teamId);
      const member = await tx.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId } },
        include: { user: { select: { email: true } } },
      });
      if (member === null) {
        throw invalid('userId', 'Only project members can join a team');
      }
      if (dto.role === TeamRole.LEAD && member.role === ProjectRole.VIEWER) {
        throw invalid('role', 'Project Viewers cannot lead a team');
      }
      const previous = team.members.find((m) => m.userId === userId)?.role ?? null;
      if (previous === dto.role) return toTeamDto(team);
      await tx.teamMember.upsert({
        where: { teamId_userId: { teamId, userId } },
        create: { teamId, projectId, userId, role: dto.role },
        update: { role: dto.role },
      });
      await this.record(tx, auth, projectId, AuditAction.TEAM_MEMBER_SET, teamId, {
        userId,
        email: member.user.email,
        role: dto.role,
        previousRole: previous,
      });
      return toTeamDto(await findTeam(tx, projectId, teamId));
    });
  }

  /**
   * Removes a user from a team. They stay a project member.
   *
   * Permissions: PM only (`MANAGE_MEMBERS`); 404 when the user is not in the
   * team.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param teamId Team id.
   * @param userId The user's id.
   * @returns The updated team.
   */
  async removeMember(
    auth: AuthContext,
    access: ProjectAccess,
    teamId: string,
    userId: string,
  ): Promise<TeamDto> {
    const projectId = access.project.id;
    return this.change(async (tx) => {
      await assertStillPm(tx, projectId, auth.user.id);
      const team = await findTeam(tx, projectId, teamId);
      const entry = team.members.find((m) => m.userId === userId);
      if (entry === undefined) {
        throw new ApiException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Team member not found');
      }
      await tx.teamMember.delete({ where: { id: entry.id } });
      await this.record(tx, auth, projectId, AuditAction.TEAM_MEMBER_REMOVED, teamId, {
        userId,
        email: entry.projectMember.user.email,
        role: entry.role,
      });
      return toTeamDto(await findTeam(tx, projectId, teamId));
    });
  }

  /**
   * Runs a team change in a serializable transaction. Serialization failures
   * and unique-constraint violations both become 409 `CONFLICT`: the latter
   * means a duplicate team name for create and rename, and a simultaneous
   * identical change otherwise.
   *
   * @param work The transaction body.
   * @param duplicateMessage Message for a unique-constraint violation.
   * @returns The body's result.
   */
  private async change<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    duplicateMessage = 'Another change was made at the same time; please try again',
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(work, { isolationLevel: 'Serializable' });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(HttpStatus.CONFLICT, ErrorCode.CONFLICT, duplicateMessage);
      }
      throw mapTransactionConflict(error);
    }
  }

  /**
   * Writes a team audit entry.
   *
   * @param tx Transaction client.
   * @param auth The caller.
   * @param projectId Project id.
   * @param action What happened.
   * @param teamId Team id.
   * @param meta Extra detail.
   * @returns Resolves once written.
   */
  private record(
    tx: Prisma.TransactionClient,
    auth: AuthContext,
    projectId: string,
    action: AuditAction,
    teamId: string,
    meta: Prisma.InputJsonObject,
  ): Promise<void> {
    return this.audit.record(
      { actorId: auth.user.id, action, entityType: 'Team', entityId: teamId, projectId, meta },
      tx,
    );
  }
}

/**
 * Loads a team of the project with its members, or throws 404 (also for
 * teams of other projects).
 *
 * @param tx Transaction client.
 * @param projectId Project id.
 * @param teamId Team id.
 * @returns The team.
 */
async function findTeam(
  tx: Prisma.TransactionClient,
  projectId: string,
  teamId: string,
): Promise<TeamWithMembers> {
  const team = await tx.team.findFirst({ where: { id: teamId, projectId }, include: TEAM_INCLUDE });
  if (team === null) {
    throw new ApiException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Team not found');
  }
  return team;
}

/**
 * Builds a 400 for one invalid field.
 *
 * @param field The field.
 * @param message The message.
 * @returns The exception to throw.
 */
function invalid(field: string, message: string): ApiException {
  return new ApiException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, message, [
    { field, messages: [message] },
  ]);
}

/**
 * Converts a team with its members to the API shape, members ordered by name.
 *
 * @param team The team row.
 * @returns The DTO.
 */
export function toTeamDto(team: TeamWithMembers): TeamDto {
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    members: team.members
      .map((m) => ({
        userId: m.userId,
        email: m.projectMember.user.email,
        displayName: m.projectMember.user.displayName,
        isActive: m.projectMember.user.isActive,
        role: m.role,
      }))
      .sort(
        (a, b) => a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId),
      ),
    createdAt: team.createdAt.toISOString(),
  };
}
