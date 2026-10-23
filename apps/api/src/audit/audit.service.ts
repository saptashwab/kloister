import { Injectable } from '@nestjs/common';
import type { AuditAction, AuditEntryDto, Page } from '@kloister/shared';
import { type PageQueryDto, pageArgs, toPage } from '../common/pagination.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import { notFound } from '../common/api-exception.js';

/** What to record in one audit entry. */
export interface AuditRecord {
  /** Acting user, or null for anonymous/CLI actions. */
  actorId: string | null;
  /** What happened. */
  action: AuditAction;
  /** Kind of entity affected, e.g. `User`. */
  entityType: string;
  /** Id of the affected entity, if any. */
  entityId?: string | null;
  /** Project the action belongs to, if any. */
  projectId?: string | null;
  /** Extra detail. Must never contain passwords, tokens or hashes. */
  meta?: Prisma.InputJsonObject;
}

/** Filters accepted by {@link AuditService.list}. */
export interface AuditFilter {
  /** Only entries by this actor. */
  actorId?: string;
  /** Only entries with this action. */
  action?: string;
  /** Only entries about this entity type. */
  entityType?: string;
  /** Only entries about this entity id. */
  entityId?: string;
  /** Only entries in this project. */
  projectId?: string;
  /** Only entries at or after this time. */
  from?: Date;
  /** Only entries before this time. */
  to?: Date;
}

/** How long one cross-project visit entry covers further reads (SPEC §3.1). */
export const VISIT_WINDOW_MINUTES = 30;

/** A Prisma client or an interactive transaction client. */
export type DbClient = Prisma.TransactionClient | PrismaService;

/**
 * Writes and reads the append-only audit log (SPEC §4 AuditLog).
 */
@Injectable()
export class AuditService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   */
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Appends one entry.
   *
   * @param record What to record.
   * @param db Pass a transaction client to write atomically with the change
   *   being audited; defaults to the shared client.
   * @returns Resolves once written.
   */
  async record(record: AuditRecord, db: DbClient = this.prisma): Promise<void> {
    await db.auditLog.create({
      data: {
        actorId: record.actorId,
        action: record.action,
        entityType: record.entityType,
        entityId: record.entityId ?? null,
        projectId: record.projectId ?? null,
        meta: record.meta ?? {},
      },
    });
  }

  /**
   * Appends one entry unless the same actor already has an entry with this
   * action, project and session within the visit window (SPEC §3.1, M8.5).
   * Entries are never updated, so a long visit leaves one entry per window.
   * An advisory transaction lock on (actor, project) keeps parallel first
   * requests of one page from writing duplicates.
   *
   * @param record What to record; needs an actor and a project.
   * @param sessionId Session the visit belongs to; stored in `meta.sessionId`.
   * @param windowMinutes How long one recorded entry covers further requests.
   * @returns True when a new entry was written.
   */
  async recordVisit(
    record: AuditRecord & { actorId: string; projectId: string },
    sessionId: string,
    windowMinutes = VISIT_WINDOW_MINUTES,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // pg_advisory_xact_lock returns void, which the client cannot read; select a constant instead.
      await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`${record.actorId}:${record.projectId}`}, 0))) AS l`;
      const recent = await tx.auditLog.findFirst({
        where: {
          actorId: record.actorId,
          action: record.action,
          projectId: record.projectId,
          createdAt: { gte: new Date(Date.now() - windowMinutes * 60_000) },
          meta: { path: ['sessionId'], equals: sessionId },
        },
        select: { id: true },
      });
      if (recent !== null) return false;
      await this.record({ ...record, meta: { ...record.meta, sessionId } }, tx);
      return true;
    });
  }

  /**
   * Lists entries newest first.
   *
   * Permissions: callers must restrict this to admins (SPEC §3.1).
   *
   * @param filter Optional filters.
   * @param page Cursor and page size.
   * @returns One page of entries.
   */
  async list(filter: AuditFilter, page: PageQueryDto): Promise<Page<AuditEntryDto>> {
    return this.read(filter, page, false);
  }

  /**
   * Reads history for an already-visible item; personal history stays owner-only.
   * @param access Access resolved by the project guard.
   * @param itemId Item id already checked by ItemsService.findVisible.
   * @param page Pagination.
   * @returns The item's activity, including its owner's personal entries.
   */
  async listItemHistory(
    access: ProjectAccess,
    itemId: string,
    page: PageQueryDto,
  ): Promise<Page<AuditEntryDto>> {
    if (access.project.ownerId !== null && access.project.ownerId !== access.userId)
      throw notFound('Project');
    return this.read(
      { projectId: access.project.id, entityType: 'WorkItem', entityId: itemId },
      page,
      true,
    );
  }

  /**
   * Reads the requested history with separate admin and item privacy paths.
   * @param filter Filters fixed by the public entry point.
   * @param page Pagination.
   * @param itemHistory True only for an authorized, project-scoped item read.
   * @returns The page.
   */
  private async read(
    filter: AuditFilter,
    page: PageQueryDto,
    itemHistory: boolean,
  ): Promise<Page<AuditEntryDto>> {
    const createdAt: Prisma.DateTimeFilter = {};
    if (filter.from !== undefined) createdAt.gte = filter.from;
    if (filter.to !== undefined) createdAt.lt = filter.to;

    const personal = itemHistory
      ? []
      : await this.prisma.project.findMany({
          where: { ownerId: { not: null } },
          select: { id: true },
        });
    const privacy: Prisma.AuditLogWhereInput = itemHistory
      ? {}
      : {
          OR: [{ projectId: null }, { projectId: { notIn: personal.map((p) => p.id) } }],
        };
    if (
      page.cursor !== undefined &&
      (await this.prisma.auditLog.count({
        where: {
          AND: [
            privacy,
            {
              projectId: filter.projectId,
              entityType: filter.entityType,
              entityId: filter.entityId,
              actorId: filter.actorId,
              action: filter.action,
              createdAt,
            },
            { id: page.cursor },
          ],
        },
      })) === 0
    )
      return { items: [], nextCursor: null };
    const rows = await this.prisma.auditLog.findMany({
      where: {
        AND: [privacy],
        actorId: filter.actorId,
        action: filter.action,
        entityType: filter.entityType,
        entityId: filter.entityId,
        projectId: filter.projectId,
        ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { actor: { select: { email: true, displayName: true } } },
      ...pageArgs(page),
    });
    const names = await this.names(rows);

    return toPage(rows, page, (row) => ({
      id: row.id,
      actorId: row.actorId,
      actorEmail: row.actor?.email ?? null,
      actorName: row.actor?.displayName ?? null,
      projectKey: names.projects.get(row.projectId ?? '')?.key ?? null,
      projectName: names.projects.get(row.projectId ?? '')?.name ?? null,
      entityLabel: names.entities.get(`${row.entityType}:${row.entityId ?? ''}`) ?? null,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      projectId: row.projectId,
      meta:
        typeof row.meta === 'object' && row.meta !== null && !Array.isArray(row.meta)
          ? (row.meta as Record<string, unknown>)
          : {},
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Resolves readable names for one page of entries at read time; stored
   * rows never change (M8.5). Items resolve to their key only, never their
   * current title, and members to the member's display name.
   *
   * @param rows Entries of the page.
   * @returns Project keys/names by id and entity labels by `type:id`.
   */
  private async names(
    rows: { projectId: string | null; entityType: string; entityId: string | null }[],
  ): Promise<{
    projects: Map<string, { key: string | null; name: string }>;
    entities: Map<string, string>;
  }> {
    const ids = (type: string): string[] => [
      ...new Set(
        rows
          .filter((r) => r.entityType === type && r.entityId !== null && isUuid(r.entityId))
          .map((r) => r.entityId!),
      ),
    ];
    const projectIds = [
      ...new Set([
        ...rows.flatMap((r) => (r.projectId === null ? [] : [r.projectId])),
        ...ids('Project'),
      ]),
    ];
    const [projects, items, users, members, buckets, labels, sprints, teams] = await Promise.all([
      this.prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, key: true, name: true },
      }),
      this.prisma.workItem.findMany({
        where: { id: { in: ids('WorkItem') } },
        select: { id: true, number: true, project: { select: { key: true } } },
      }),
      this.prisma.user.findMany({
        where: { id: { in: ids('User') } },
        select: { id: true, displayName: true },
      }),
      this.prisma.projectMember.findMany({
        where: { id: { in: ids('ProjectMember') } },
        select: { id: true, user: { select: { displayName: true } } },
      }),
      this.prisma.bucket.findMany({ where: { id: { in: ids('Bucket') } }, select: NAME }),
      this.prisma.label.findMany({ where: { id: { in: ids('Label') } }, select: NAME }),
      this.prisma.sprint.findMany({ where: { id: { in: ids('Sprint') } }, select: NAME }),
      this.prisma.team.findMany({ where: { id: { in: ids('Team') } }, select: NAME }),
    ]);
    const entities = new Map<string, string>();
    for (const p of projects) entities.set(`Project:${p.id}`, p.key ?? p.name);
    for (const i of items)
      entities.set(
        `WorkItem:${i.id}`,
        i.project.key === null ? `#${i.number}` : `${i.project.key}-${i.number}`,
      );
    for (const u of users) entities.set(`User:${u.id}`, u.displayName);
    for (const m of members) entities.set(`ProjectMember:${m.id}`, m.user.displayName);
    for (const [type, list] of [
      ['Bucket', buckets],
      ['Label', labels],
      ['Sprint', sprints],
      ['Team', teams],
    ] as const)
      for (const row of list) entities.set(`${type}:${row.id}`, row.name);
    return { projects: new Map(projects.map((p) => [p.id, p])), entities };
  }
}

/** Columns read for entities shown by name. */
const NAME = { id: true, name: true } as const;

/**
 * Whether a stored entity id is a uuid; other ids (setting keys, file names)
 * are never looked up.
 *
 * @param value Stored entity id.
 * @returns True for a uuid.
 */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
