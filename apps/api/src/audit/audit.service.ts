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
      include: { actor: { select: { email: true } } },
      ...pageArgs(page),
    });

    return toPage(rows, page, (row) => ({
      id: row.id,
      actorId: row.actorId,
      actorEmail: row.actor?.email ?? null,
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
}
