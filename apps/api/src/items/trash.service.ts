import { Injectable } from '@nestjs/common';
import {
  AuditAction,
  isAllowedParent,
  ProjectPermission as P,
  type RestoreBatchResult,
  type TrashBatchDto,
  type TrashItemDto,
} from '@kloister/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { forbidden, notFound } from '../common/api-exception.js';
import { serializable } from '../common/transactions.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type ItemFacts,
  type ProjectAccess,
  ProjectAccessService,
} from '../projects/project-access.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { FileStoreService } from '../storage/file-store.service.js';
import { toItemRef } from './item.mapper.js';
import { ItemsService } from './items.service.js';

/** Most trashed items listed at once; older batches show once newer ones are gone. */
export const TRASH_LIST_MAX = 1_000;

/** One day in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The columns of a trashed item the trash needs. */
const TRASH_SELECT = {
  id: true,
  number: true,
  type: true,
  title: true,
  parentId: true,
  createdById: true,
  bucketId: true,
  teamId: true,
  deletedAt: true,
  deletedById: true,
  deleteBatchId: true,
  assignees: { select: { userId: true } },
  deletedBy: { select: { id: true, displayName: true } },
} as const satisfies Prisma.WorkItemSelect;

/** A trashed item row loaded with {@link TRASH_SELECT}. */
type TrashRow = Prisma.WorkItemGetPayload<{ select: typeof TRASH_SELECT }>;

/**
 * The visibility facts of a trashed item.
 *
 * @param row The item.
 * @returns The facts; trashed items have no active children.
 */
function trashFacts(row: TrashRow): ItemFacts {
  return {
    createdById: row.createdById,
    assigneeIds: row.assignees.map((a) => a.userId),
    bucketId: row.bucketId,
    teamId: row.teamId,
    hasChildren: false,
  };
}

/**
 * The item a batch was deleted through: the one whose parent is not in the
 * batch (a cascade's top item), else the lowest number.
 *
 * @param rows The batch's items, by number.
 * @returns The deleted item.
 */
function batchRoot<T extends { id: string; parentId: string | null }>(rows: readonly T[]): T {
  const ids = new Set(rows.map((r) => r.id));
  return rows.find((r) => r.parentId === null || !ids.has(r.parentId)) ?? rows[0];
}

/**
 * The project trash (M12 plan section 5): deleted items grouped by delete
 * batch, restore and permanent delete, and the nightly purge after the
 * admin's retention (default 30 days).
 *
 * Authorization (SPEC §3.4): `ProjectAccessGuard` checks the role-level
 * permission and refuses writes to archived projects. The trash lists only
 * items the caller could see if they were active
 * ({@link ProjectAccessService.itemVisibilityFilter}); a batch without a
 * visible item is 404. Restoring follows
 * {@link ProjectAccessService.canRestoreBatch}; permanent deletion is for PMs.
 * Personal spaces have their own trash, which only their owner reaches.
 */
@Injectable()
export class TrashService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param items Item audit entries.
   * @param access Visibility and restore rules.
   * @param audit Audit log, for purges without a person.
   * @param files Attachment files, removed with purged items.
   * @param settings The trash retention.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly access: ProjectAccessService,
    private readonly audit: AuditService,
    private readonly files: FileStoreService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Lists the project's delete batches, newest first, with the items of each
   * that the caller could see.
   *
   * Permissions: `DELETE_ANY_ITEM` or `DELETE_OWN_ITEMS` (guard); items
   * outside the caller's visibility are left out, batches without a visible
   * item too.
   *
   * @param access The caller's access.
   * @returns The batches.
   */
  async list(access: ProjectAccess): Promise<TrashBatchDto[]> {
    const rows = await this.prisma.workItem.findMany({
      where: {
        AND: [
          { projectId: access.project.id, deletedAt: { not: null } },
          this.access.itemVisibilityFilter(access),
        ],
      },
      select: TRASH_SELECT,
      orderBy: [{ deletedAt: 'desc' }, { number: 'asc' }],
      // The oldest batch shown may be cut short; it lists fully once newer ones are gone.
      take: TRASH_LIST_MAX,
    });
    const batchIds = [...new Set(rows.map((r) => r.deleteBatchId!))];
    // Whole batch sizes, hidden items included: only the restore rule reads them.
    const sizes = await this.prisma.workItem.groupBy({
      by: ['deleteBatchId'],
      where: { projectId: access.project.id, deleteBatchId: { in: batchIds } },
      _count: { _all: true },
    });
    const sizeOf = new Map(sizes.map((s) => [s.deleteBatchId, s._count._all]));
    const { trashRetentionDays } = await this.settings.getStorage();
    const canPurge = this.access.has(access, P.MANAGE_PROJECT);
    return batchIds.map((batchId) => {
      const batch = rows.filter((r) => r.deleteBatchId === batchId);
      const root = batchRoot(batch);
      const items: TrashItemDto[] = [root, ...batch.filter((r) => r !== root)].map((r) => ({
        ...toItemRef(access.project.key, r),
        parentId: r.parentId,
      }));
      const deletedAt = root.deletedAt!;
      return {
        id: batchId,
        deletedAt: deletedAt.toISOString(),
        deletedBy: root.deletedBy,
        purgeAfter: new Date(deletedAt.getTime() + trashRetentionDays * DAY_MS).toISOString(),
        items,
        canRestore: this.access.canRestoreBatch(
          access,
          trashFacts(root),
          root.deletedById,
          sizeOf.get(batchId) ?? batch.length,
        ),
        canPurge,
      };
    });
  }

  /**
   * Restores a delete batch: its items come back with their number, notes,
   * files and links (dependency links show again once both ends are
   * active). When the deleted item's parent is still in the trash, it is
   * restored without a parent.
   *
   * Permissions: `DELETE_ANY_ITEM` or `DELETE_OWN_ITEMS` (guard); 404 unless
   * the batch's deleted item is visible to the caller; 403 unless
   * {@link ProjectAccessService.canRestoreBatch} allows it.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param batchId The delete batch.
   * @returns How many items came back.
   */
  async restore(
    auth: AuthContext,
    access: ProjectAccess,
    batchId: string,
  ): Promise<RestoreBatchResult> {
    const projectId = access.project.id;
    return serializable(this.prisma, async (tx) => {
      const rows = await tx.workItem.findMany({
        where: { projectId, deleteBatchId: batchId, deletedAt: { not: null } },
        select: TRASH_SELECT,
        orderBy: { number: 'asc' },
      });
      if (rows.length === 0) throw notFound('Trash batch');
      const root = batchRoot(rows);
      const facts = trashFacts(root);
      if (!this.access.canViewItem(access, facts)) throw notFound('Trash batch');
      if (!this.access.canRestoreBatch(access, facts, root.deletedById, rows.length))
        throw forbidden();
      // Unscoped on purpose: only whether the parent is still active and still
      // a type that may hold this item is read (its type may have changed).
      const parent =
        root.parentId === null
          ? null
          : await tx.workItem.findUnique({
              where: { id: root.parentId },
              select: { deletedAt: true, type: true },
            });
      const parentDropped =
        root.parentId !== null &&
        (parent === null || parent.deletedAt !== null || !isAllowedParent(root.type, parent.type));
      await tx.workItem.updateMany({
        where: { projectId, deleteBatchId: batchId },
        data: { deletedAt: null, deletedById: null, deleteBatchId: null, updatedAt: new Date() },
      });
      if (parentDropped)
        await tx.workItem.update({ where: { id: root.id }, data: { parentId: null } });
      // A partner that became ad hoc meanwhile takes no links (M12).
      const ids = rows.map((r) => r.id);
      await tx.workItemDependency.deleteMany({
        where: {
          OR: [{ blockedItemId: { in: ids } }, { blockingItemId: { in: ids } }],
          AND: [{ OR: [{ blockedItem: { adHoc: true } }, { blockingItem: { adHoc: true } }] }],
        },
      });
      await this.items.record(tx, auth, access, AuditAction.ITEM_RESTORED, root.id, {
        number: root.number,
        type: root.type,
        title: root.title,
        batchId,
        ...(rows.length > 1 ? { cascade: true, descendants: rows.length - 1 } : {}),
        ...(parentDropped ? { changes: { parentId: { from: root.parentId, to: null } } } : {}),
      });
      return { restored: rows.length, parentDropped };
    });
  }

  /**
   * Deletes a batch for good at once, with its notes, files and links.
   *
   * Permissions: PM only (`MANAGE_PROJECT`, guard); 404 unless the batch
   * exists in the project.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param batchId The delete batch.
   * @returns Resolves once removed (204).
   */
  async purge(auth: AuthContext, access: ProjectAccess, batchId: string): Promise<void> {
    const removed = await this.purgeBatch(access.project.id, batchId, auth.user.id, false);
    if (removed === 0) throw notFound('Trash batch');
  }

  /**
   * The nightly purge: removes every batch deleted longer ago than the
   * retention, one transaction per batch, with one `ITEM_PURGED` entry each.
   *
   * @param now When the purge runs.
   * @returns How many batches were removed.
   */
  async purgeExpired(now: Date): Promise<number> {
    const { trashRetentionDays } = await this.settings.getStorage();
    const cutoff = new Date(now.getTime() - trashRetentionDays * DAY_MS);
    const batches = await this.prisma.workItem.findMany({
      where: { deletedAt: { lt: cutoff }, deleteBatchId: { not: null } },
      distinct: ['deleteBatchId'],
      select: { projectId: true, deleteBatchId: true },
    });
    let purged = 0;
    for (const batch of batches) {
      // One failing batch must not keep the others; it is retried the next night.
      try {
        if ((await this.purgeBatch(batch.projectId, batch.deleteBatchId!, null, true)) > 0)
          purged++;
      } catch {
        continue;
      }
    }
    return purged;
  }

  /**
   * Removes one batch's rows for good; their notes, attachments, references,
   * links and notifications go with them (database cascades). ADO links are
   * tombstoned so the remote identity is never reused. Files are removed
   * only once the rows are gone.
   *
   * @param projectId Project id.
   * @param batchId The delete batch.
   * @param actorId Who asked, or null for the nightly purge.
   * @param automatic Whether the retention expired.
   * @returns How many items were removed.
   */
  private async purgeBatch(
    projectId: string,
    batchId: string,
    actorId: string | null,
    automatic: boolean,
  ): Promise<number> {
    const result = await serializable(this.prisma, async (tx) => {
      const rows = await tx.workItem.findMany({
        where: { projectId, deleteBatchId: batchId, deletedAt: { not: null } },
        select: { id: true, number: true, type: true, title: true, parentId: true },
        orderBy: { number: 'asc' },
      });
      if (rows.length === 0) return { count: 0, files: [] };
      const ids = rows.map((r) => r.id);
      const root = batchRoot(rows);
      const files = await tx.attachment.findMany({
        where: { workItemId: { in: ids } },
        select: { storedName: true },
      });
      await tx.adoItemLink.updateMany({
        where: { projectId, itemId: { in: ids }, tombstonedAt: null },
        data: { tombstonedAt: new Date() },
      });
      // Items of other batches deleted earlier from under these lose their parent.
      await tx.workItem.updateMany({
        where: { projectId, parentId: { in: ids }, id: { notIn: ids } },
        data: { parentId: null },
      });
      // One statement, so the parent links are checked only once all rows are gone.
      await tx.workItem.deleteMany({ where: { projectId, id: { in: ids } } });
      await this.audit.record(
        {
          actorId,
          action: AuditAction.ITEM_PURGED,
          entityType: 'WorkItem',
          entityId: root.id,
          projectId,
          meta: {
            number: root.number,
            type: root.type,
            title: root.title,
            batchId,
            count: rows.length,
            ...(automatic ? { automatic: true } : {}),
          },
        },
        tx,
      );
      return { count: rows.length, files };
    });
    await this.files.remove(result.files.map((f) => ({ projectId, storedName: f.storedName })));
    return result.count;
  }
}
