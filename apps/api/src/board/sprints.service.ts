import { Injectable } from '@nestjs/common';
import {
  AuditAction,
  type CloseSprintResult,
  ItemStatus,
  type Page,
  type SprintDto,
  SprintState,
} from '@kloister/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { conflict, invalidField, notFound } from '../common/api-exception.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import { type PageQueryDto, pageArgs, toPage } from '../common/pagination.js';
import { serializable } from '../common/transactions.js';
import type { Prisma, Sprint } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import { toSprintDto } from './board.mapper.js';
import type { CloseSprintDto, CreateSprintDto, UpdateSprintDto } from './board.dto.js';

/** A JSON-safe before/after pair for audit entries. */
type Change = { from: string | null; to: string | null };

/**
 * Sprints (SPEC §4, §6 "Sprints", §8 `sprints`): planning, starting and
 * closing. A project has at most one active sprint; closed sprints accept
 * no new items and cannot be restarted.
 *
 * Permissions: any member (or admin) lists sprints; changes need
 * `MANAGE_BOARD` (PM and Lead), checked by `ProjectAccessGuard`.
 */
@Injectable()
export class SprintsService {
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
   * Lists sprints by start date.
   *
   * Permissions: any member; any admin (audited if not a member).
   *
   * @param access The caller's access.
   * @param page Cursor and page size.
   * @returns One page of sprints.
   */
  async list(access: ProjectAccess, page: PageQueryDto): Promise<Page<SprintDto>> {
    const rows = await this.prisma.sprint.findMany({
      where: { projectId: access.project.id },
      orderBy: [{ startDate: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      ...pageArgs(page),
    });
    return toPage(rows, page, toSprintDto);
  }

  /**
   * Plans a sprint.
   *
   * Permissions: `MANAGE_BOARD`. The end date may not be before the start.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param dto Name, dates and iteration path.
   * @returns The new sprint (201).
   */
  async create(auth: AuthContext, access: ProjectAccess, dto: CreateSprintDto): Promise<SprintDto> {
    assertDateOrder(dto.startDate, dto.endDate);
    const projectId = access.project.id;
    return serializable(this.prisma, async (tx) => {
      const sprint = await tx.sprint.create({
        data: {
          projectId,
          name: dto.name,
          startDate: toDbDate(dto.startDate),
          endDate: toDbDate(dto.endDate),
          adoIterationPath: dto.adoIterationPath ?? null,
        },
      });
      await this.record(tx, auth, projectId, AuditAction.SPRINT_CREATED, sprint.id, {
        name: sprint.name,
        startDate: dto.startDate,
        endDate: dto.endDate,
      });
      return toSprintDto(sprint);
    });
  }

  /**
   * Renames a sprint or changes its dates or iteration path.
   *
   * Permissions: `MANAGE_BOARD`; 404 for sprints of other projects.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param sprintId Sprint id.
   * @param dto Fields to change.
   * @returns The updated sprint.
   */
  async update(
    auth: AuthContext,
    access: ProjectAccess,
    sprintId: string,
    dto: UpdateSprintDto,
  ): Promise<SprintDto> {
    const projectId = access.project.id;
    return serializable(this.prisma, async (tx) => {
      const current = await findSprint(tx, projectId, sprintId);
      const next = {
        name: dto.name ?? current.name,
        startDate: dto.startDate ?? fromDbDate(current.startDate) ?? '',
        endDate: dto.endDate ?? fromDbDate(current.endDate) ?? '',
        adoIterationPath:
          dto.adoIterationPath === undefined ? current.adoIterationPath : dto.adoIterationPath,
      };
      assertDateOrder(next.startDate, next.endDate);
      const before = {
        name: current.name,
        startDate: fromDbDate(current.startDate),
        endDate: fromDbDate(current.endDate),
        adoIterationPath: current.adoIterationPath,
      };
      const changes: Record<string, Change> = {};
      for (const key of Object.keys(before) as (keyof typeof before)[]) {
        if (before[key] !== next[key]) changes[key] = { from: before[key], to: next[key] };
      }
      if (Object.keys(changes).length === 0) return toSprintDto(current);
      const sprint = await tx.sprint.update({
        where: { id: sprintId },
        data: {
          name: next.name,
          startDate: toDbDate(next.startDate),
          endDate: toDbDate(next.endDate),
          adoIterationPath: next.adoIterationPath,
        },
      });
      await this.record(tx, auth, projectId, AuditAction.SPRINT_UPDATED, sprintId, { changes });
      return toSprintDto(sprint);
    });
  }

  /**
   * Makes a planned sprint the active one.
   *
   * Permissions: `MANAGE_BOARD`. 409 `CONFLICT` when another sprint is
   * active or this one is closed.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param sprintId Sprint id.
   * @returns The started sprint.
   */
  async start(auth: AuthContext, access: ProjectAccess, sprintId: string): Promise<SprintDto> {
    const projectId = access.project.id;
    return serializable(this.prisma, async (tx) => {
      const sprint = await findSprint(tx, projectId, sprintId);
      if (sprint.state === SprintState.ACTIVE) return toSprintDto(sprint);
      if (sprint.state === SprintState.CLOSED)
        throw conflict('A closed sprint cannot be restarted');
      const active = await tx.sprint.count({ where: { projectId, state: SprintState.ACTIVE } });
      if (active > 0) throw conflict('Another sprint is already active; close it first');
      const started = await tx.sprint.update({
        where: { id: sprintId },
        data: { state: SprintState.ACTIVE },
      });
      await this.record(tx, auth, projectId, AuditAction.SPRINT_STARTED, sprintId, {
        name: sprint.name,
      });
      return toSprintDto(started);
    });
  }

  /**
   * Closes a planned or active sprint, optionally moving its unfinished
   * (not DONE) items to another open sprint or to the backlog (no sprint).
   *
   * Permissions: `MANAGE_BOARD`. 409 `CONFLICT` when already closed; 400
   * when the target sprint is not an open sprint of the project.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param sprintId Sprint id.
   * @param dto Where unfinished items go.
   * @returns The closed sprint and how many items moved.
   */
  async close(
    auth: AuthContext,
    access: ProjectAccess,
    sprintId: string,
    dto: CloseSprintDto,
  ): Promise<CloseSprintResult> {
    const projectId = access.project.id;
    return serializable(this.prisma, async (tx) => {
      const sprint = await findSprint(tx, projectId, sprintId);
      if (sprint.state === SprintState.CLOSED) throw conflict('This sprint is already closed');
      let movedItems = 0;
      if (dto.moveUnfinishedTo !== undefined) {
        const targetId = dto.moveUnfinishedTo;
        if (targetId !== null) {
          const target = await tx.sprint.findFirst({ where: { id: targetId, projectId } });
          if (target === null || target.id === sprintId || target.state === SprintState.CLOSED) {
            throw invalidField('moveUnfinishedTo', 'Choose another open sprint of this project');
          }
        }
        const moved = await tx.workItem.updateMany({
          where: { projectId, sprintId, status: { not: ItemStatus.DONE } },
          data: { sprintId: targetId },
        });
        movedItems = moved.count;
      }
      const closed = await tx.sprint.update({
        where: { id: sprintId },
        data: { state: SprintState.CLOSED },
      });
      await this.record(tx, auth, projectId, AuditAction.SPRINT_CLOSED, sprintId, {
        name: sprint.name,
        movedItems,
        ...(dto.moveUnfinishedTo === undefined ? {} : { movedTo: dto.moveUnfinishedTo }),
      });
      return { sprint: toSprintDto(closed), movedItems };
    });
  }

  /**
   * Deletes a sprint; its items stay, without a sprint (database `SET NULL`).
   *
   * Permissions: `MANAGE_BOARD`.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param sprintId Sprint id.
   * @returns Resolves once deleted (204).
   */
  async remove(auth: AuthContext, access: ProjectAccess, sprintId: string): Promise<void> {
    const projectId = access.project.id;
    await serializable(this.prisma, async (tx) => {
      const sprint = await findSprint(tx, projectId, sprintId);
      const items = await tx.workItem.count({ where: { sprintId } });
      await tx.sprint.delete({ where: { id: sprintId } });
      await this.record(tx, auth, projectId, AuditAction.SPRINT_DELETED, sprintId, {
        name: sprint.name,
        items,
      });
    });
  }

  /**
   * Writes a sprint audit entry.
   *
   * @param tx Transaction client.
   * @param auth The caller.
   * @param projectId Project id.
   * @param action What happened.
   * @param sprintId Sprint id.
   * @param meta Extra detail.
   * @returns Resolves once written.
   */
  private record(
    tx: Prisma.TransactionClient,
    auth: AuthContext,
    projectId: string,
    action: AuditAction,
    sprintId: string,
    meta: Prisma.InputJsonObject,
  ): Promise<void> {
    return this.audit.record(
      { actorId: auth.user.id, action, entityType: 'Sprint', entityId: sprintId, projectId, meta },
      tx,
    );
  }
}

/**
 * Throws 400 unless the end date is on or after the start date.
 *
 * @param startDate `YYYY-MM-DD`.
 * @param endDate `YYYY-MM-DD`.
 */
function assertDateOrder(startDate: string, endDate: string): void {
  // ISO calendar dates compare correctly as strings.
  if (endDate < startDate) throw invalidField('endDate', 'The end date is before the start date');
}

/**
 * Loads a sprint of the project, or throws 404.
 *
 * @param tx Transaction client.
 * @param projectId Project id.
 * @param sprintId Sprint id.
 * @returns The sprint.
 */
async function findSprint(
  tx: Prisma.TransactionClient,
  projectId: string,
  sprintId: string,
): Promise<Sprint> {
  const sprint = await tx.sprint.findFirst({ where: { id: sprintId, projectId } });
  if (sprint === null) throw notFound('Sprint');
  return sprint;
}
