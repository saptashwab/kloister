import { Injectable } from '@nestjs/common';
import type { AuditAction, AuditEntryDto, Page } from '@kloister/shared';
import { type PageQueryDto, pageArgs, toPage } from '../common/pagination.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

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
    const createdAt: Prisma.DateTimeFilter = {};
    if (filter.from !== undefined) createdAt.gte = filter.from;
    if (filter.to !== undefined) createdAt.lt = filter.to;

    const rows = await this.prisma.auditLog.findMany({
      where: {
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
