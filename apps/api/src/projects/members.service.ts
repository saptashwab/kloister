import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AuditAction,
  ErrorCode,
  isScopedRole,
  type MemberCandidateDto,
  type Page,
  type ProjectMemberDto,
  ProjectRole,
  SystemRole,
  Visibility,
} from '@kloister/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { ApiException } from '../common/api-exception.js';
import { type PageQueryDto, pageArgs, toPage } from '../common/pagination.js';
import { isUniqueViolation, mapTransactionConflict } from '../common/prisma-errors.js';
import type { Prisma, ProjectMember } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MEMBER_USER_SELECT, toMemberDto } from './project.mapper.js';
import { type ProjectAccess, pmAssignmentOnly, projectArchived } from './project-access.service.js';
import type { AddMemberDto, MemberCandidatesQueryDto, UpdateMemberDto } from './projects.dto.js';

/** Most candidates returned by one search. */
const CANDIDATE_LIMIT = 20;

/** Role, visibility and buckets as they will be stored. */
interface Placement {
  role: ProjectRole;
  visibility: Visibility;
  allowedBucketIds: string[];
}

/**
 * Normalises a membership before storing it: PM and Lead always see
 * everything (SPEC §3.3), and a bucket list is kept only for `BUCKETS` scope.
 *
 * @param placement Requested role, visibility and buckets.
 * @returns What to store.
 */
export function normalizePlacement(placement: Placement): Placement {
  if (!isScopedRole(placement.role)) {
    return { role: placement.role, visibility: Visibility.ALL, allowedBucketIds: [] };
  }
  return {
    role: placement.role,
    visibility: placement.visibility,
    allowedBucketIds:
      placement.visibility === Visibility.BUCKETS ? [...new Set(placement.allowedBucketIds)] : [],
  };
}

/**
 * Project membership: listing, adding, changing role and visibility, and
 * removing members (SPEC §3.2 "Manage members, roles, visibility", §8
 * `projects/:id/members`). System admins may also grant and take away the
 * PM role in any project (SPEC §3.1).
 *
 * A project must always keep at least one active PM: removing or demoting
 * the last one is rejected with 409 `LAST_PM`. Changes run in serializable
 * transactions so two PMs demoting each other cannot both succeed; the loser
 * gets 409 `CONFLICT` and may retry.
 */
@Injectable()
export class MembersService {
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
   * Lists members in the order they were added.
   *
   * Permissions: any member (they need it to pick assignees), or an admin
   * (audited by the access check).
   *
   * @param access The caller's access.
   * @param page Cursor and page size.
   * @returns One page of members.
   */
  async list(access: ProjectAccess, page: PageQueryDto): Promise<Page<ProjectMemberDto>> {
    const rows = await this.prisma.projectMember.findMany({
      where: { projectId: access.project.id },
      include: { user: { select: MEMBER_USER_SELECT } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      ...pageArgs(page),
    });
    return toPage(rows, page, toMemberDto);
  }

  /**
   * Searches active users who are not yet members, to add them.
   *
   * Permissions: PMs and system admins (`MANAGE_MEMBERS` or `ASSIGN_PMS`,
   * checked by the guard). This is the only user directory open to
   * non-admins, and only to PMs.
   *
   * @param access The caller's access.
   * @param query Search text.
   * @returns Up to 20 users ordered by name.
   */
  async candidates(
    access: ProjectAccess,
    query: MemberCandidatesQueryDto,
  ): Promise<MemberCandidateDto[]> {
    const q = query.q?.trim();
    const rows = await this.prisma.user.findMany({
      where: {
        isActive: true,
        memberships: { none: { projectId: access.project.id } },
        ...(q === undefined || q === ''
          ? {}
          : {
              OR: [
                { email: { contains: q, mode: 'insensitive' } },
                { displayName: { contains: q, mode: 'insensitive' } },
              ],
            }),
      },
      select: { id: true, email: true, displayName: true },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: CANDIDATE_LIMIT,
    });
    return rows;
  }

  /**
   * Adds an active user to the project.
   *
   * Permissions: PMs (`MANAGE_MEMBERS`); system admins who are not PMs
   * (`ASSIGN_PMS`) may only add users as PM (403 otherwise).
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param dto User, role and visibility.
   * @returns The new member (201).
   */
  async add(
    auth: AuthContext,
    access: ProjectAccess,
    dto: AddMemberDto,
  ): Promise<ProjectMemberDto> {
    const projectId = access.project.id;
    const pmOnly = pmAssignmentOnly(access);
    if (pmOnly && dto.role !== ProjectRole.PM) throw pmRoleOnly();
    const placement = normalizePlacement({
      role: dto.role,
      visibility: dto.visibility ?? Visibility.ALL,
      allowedBucketIds: dto.allowedBucketIds ?? [],
    });
    try {
      return await this.serializable(async (tx) => {
        await this.assertMayChange(tx, projectId, auth.user.id, pmOnly);
        const user = await tx.user.findUnique({ where: { id: dto.userId } });
        if (user === null || !user.isActive) {
          throw new ApiException(
            HttpStatus.BAD_REQUEST,
            ErrorCode.VALIDATION_FAILED,
            'Only active users can be added',
            [{ field: 'userId', messages: ['must be an active user'] }],
          );
        }
        const member = await tx.projectMember.create({
          data: { projectId, userId: user.id, ...placement },
          include: { user: { select: MEMBER_USER_SELECT } },
        });
        await this.audit.record(
          {
            actorId: auth.user.id,
            action: AuditAction.MEMBER_ADDED,
            entityType: 'ProjectMember',
            entityId: member.id,
            projectId,
            meta: { userId: user.id, email: user.email, ...placement, ...asAdmin(pmOnly) },
          },
          tx,
        );
        return toMemberDto(member);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          ErrorCode.CONFLICT,
          'This user is already a member of the project',
        );
      }
      throw error;
    }
  }

  /**
   * Changes a member's role, visibility or bucket list.
   *
   * Permissions: PMs (`MANAGE_MEMBERS`); system admins who are not PMs
   * (`ASSIGN_PMS`) only to promote a member to PM or demote a PM (403
   * otherwise). Demoting the last active PM is rejected with 409 `LAST_PM`.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param userId The member's user id.
   * @param dto Fields to change.
   * @returns The updated member.
   */
  async update(
    auth: AuthContext,
    access: ProjectAccess,
    userId: string,
    dto: UpdateMemberDto,
  ): Promise<ProjectMemberDto> {
    const projectId = access.project.id;
    const pmOnly = pmAssignmentOnly(access);
    // Admins change the PM role only, nothing else about a membership.
    if (pmOnly && (dto.visibility !== undefined || dto.allowedBucketIds !== undefined)) {
      throw pmRoleOnly();
    }
    return this.serializable(async (tx) => {
      await this.assertMayChange(tx, projectId, auth.user.id, pmOnly);
      const current = await this.findMember(tx, projectId, userId);
      const next = normalizePlacement({
        role: dto.role ?? current.role,
        visibility: dto.visibility ?? current.visibility,
        allowedBucketIds: dto.allowedBucketIds ?? current.allowedBucketIds,
      });
      if (pmOnly && current.role !== ProjectRole.PM && next.role !== ProjectRole.PM) {
        throw pmRoleOnly();
      }
      const changes: Record<string, { from: Prisma.InputJsonValue; to: Prisma.InputJsonValue }> =
        {};
      if (next.role !== current.role) changes['role'] = { from: current.role, to: next.role };
      if (next.visibility !== current.visibility) {
        changes['visibility'] = { from: current.visibility, to: next.visibility };
      }
      if (!sameIds(next.allowedBucketIds, current.allowedBucketIds)) {
        changes['allowedBucketIds'] = { from: current.allowedBucketIds, to: next.allowedBucketIds };
      }
      if (Object.keys(changes).length === 0) return toMemberDto(current);

      if (current.role === ProjectRole.PM && next.role !== ProjectRole.PM) {
        await this.assertAnotherActivePm(tx, projectId, userId);
      }
      const member = await tx.projectMember.update({
        where: { id: current.id },
        data: next,
        include: { user: { select: MEMBER_USER_SELECT } },
      });
      await this.audit.record(
        {
          actorId: auth.user.id,
          action: AuditAction.MEMBER_UPDATED,
          entityType: 'ProjectMember',
          entityId: current.id,
          projectId,
          meta: { userId, email: current.user.email, changes, ...asAdmin(pmOnly) },
        },
        tx,
      );
      return toMemberDto(member);
    });
  }

  /**
   * Removes a member. PMs may remove themselves while another active PM
   * remains.
   *
   * Permissions: PMs (`MANAGE_MEMBERS`); system admins who are not PMs
   * (`ASSIGN_PMS`) may only remove PMs (403 otherwise). Removing the last
   * active PM is rejected with 409 `LAST_PM`.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param userId The member's user id.
   * @returns Resolves once removed (204).
   */
  async remove(auth: AuthContext, access: ProjectAccess, userId: string): Promise<void> {
    const projectId = access.project.id;
    const pmOnly = pmAssignmentOnly(access);
    await this.serializable(async (tx) => {
      await this.assertMayChange(tx, projectId, auth.user.id, pmOnly);
      const current = await this.findMember(tx, projectId, userId);
      if (pmOnly && current.role !== ProjectRole.PM) throw pmRoleOnly();
      if (current.role === ProjectRole.PM) {
        await this.assertAnotherActivePm(tx, projectId, userId);
      }
      await tx.projectMember.delete({ where: { id: current.id } });
      await this.audit.record(
        {
          actorId: auth.user.id,
          action: AuditAction.MEMBER_REMOVED,
          entityType: 'ProjectMember',
          entityId: current.id,
          projectId,
          meta: { userId, email: current.user.email, role: current.role, ...asAdmin(pmOnly) },
        },
        tx,
      );
    });
  }

  /**
   * Runs a membership change in a serializable transaction, mapping
   * serialization failures to 409 `CONFLICT`.
   *
   * @param work The transaction body.
   * @returns The body's result.
   */
  private async serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(work, { isolationLevel: 'Serializable' });
    } catch (error) {
      throw mapTransactionConflict(error);
    }
  }

  /**
   * Re-checks inside the transaction that the caller may still make the
   * change, so a concurrent demotion or archive cannot be bypassed: the
   * changes conflict instead of both committing.
   *
   * - PMs must still be PM and the project must not be archived.
   * - Admins assigning PMs must still be active admins; archived projects are
   *   allowed so a project without an active PM can always be recovered.
   *
   * @param tx Transaction client.
   * @param projectId Project id.
   * @param actorId The caller's user id.
   * @param pmOnly True when the caller acts as an admin assigning PMs.
   */
  private async assertMayChange(
    tx: Prisma.TransactionClient,
    projectId: string,
    actorId: string,
    pmOnly: boolean,
  ): Promise<void> {
    if (pmOnly) {
      const admin = await tx.user.findUnique({ where: { id: actorId } });
      if (admin?.systemRole !== SystemRole.ADMIN || !admin.isActive) {
        throw new ApiException(
          HttpStatus.FORBIDDEN,
          ErrorCode.FORBIDDEN,
          'Administrator access required',
        );
      }
      return;
    }
    const actor = await tx.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: actorId } },
      include: { project: { select: { archivedAt: true } } },
    });
    if (actor?.role !== ProjectRole.PM) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Your project role does not allow this',
      );
    }
    if (actor.project.archivedAt !== null) throw projectArchived();
  }

  /**
   * Loads a membership with its user, or throws 404.
   *
   * @param tx Transaction client.
   * @param projectId Project id.
   * @param userId The member's user id.
   * @returns The membership.
   */
  private async findMember(
    tx: Prisma.TransactionClient,
    projectId: string,
    userId: string,
  ): Promise<ProjectMember & { user: { email: string; displayName: string; isActive: boolean } }> {
    const member = await tx.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      include: { user: { select: MEMBER_USER_SELECT } },
    });
    if (member === null) {
      throw new ApiException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Member not found');
    }
    return member;
  }

  /**
   * Throws 409 `LAST_PM` unless an active PM other than `userId` remains.
   * Deactivated PMs do not count: a project whose only PM is deactivated
   * could no longer be managed.
   *
   * @param tx Transaction client.
   * @param projectId Project id.
   * @param userId The PM being demoted or removed.
   */
  private async assertAnotherActivePm(
    tx: Prisma.TransactionClient,
    projectId: string,
    userId: string,
  ): Promise<void> {
    const others = await tx.projectMember.count({
      where: { projectId, role: ProjectRole.PM, userId: { not: userId }, user: { isActive: true } },
    });
    if (others === 0) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        ErrorCode.LAST_PM,
        'A project must keep at least one active Project Manager',
      );
    }
  }
}

/**
 * The 403 for admins (who are not PMs) attempting a change that does not
 * involve the PM role.
 *
 * @returns The exception to throw.
 */
function pmRoleOnly(): ApiException {
  return new ApiException(
    HttpStatus.FORBIDDEN,
    ErrorCode.FORBIDDEN,
    'Administrators can only grant or remove the Project Manager role here',
  );
}

/**
 * Audit detail marking a change made through the admin PM-assignment right.
 *
 * @param pmOnly True when the caller acted as an admin assigning PMs.
 * @returns `{ asAdmin: true }` or nothing.
 */
function asAdmin(pmOnly: boolean): { asAdmin?: true } {
  return pmOnly ? { asAdmin: true } : {};
}

/**
 * Compares two id lists as sets.
 *
 * @param a First list.
 * @param b Second list.
 * @returns True if both hold the same ids.
 */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
}
