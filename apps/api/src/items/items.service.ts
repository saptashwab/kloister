import { Injectable } from '@nestjs/common';
import {
  type AuditEntryDto,
  AuditAction,
  ErrorCode,
  type ItemCapabilitiesDto,
  type ItemRefDto,
  ItemStatus,
  type ItemType,
  NotificationType,
  type Page,
  requiresBucket,
  SprintState,
  type WorkItemDetailDto,
  type WorkItemDto,
} from '@kloister/shared';
import { AuditService, type DbClient } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { statusOnEnter } from '../board/bucket-rules.js';
import { conflict, forbidden, invalidField, notFound } from '../common/api-exception.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import { type PageQueryDto, pageArgs, toPage } from '../common/pagination.js';
import { placeAfter, POSITION_STEP } from '../common/positions.js';
import { isForeignKeyViolation } from '../common/prisma-errors.js';
import { sanitizeRichText } from '../common/sanitize-html.js';
import { serializable } from '../common/transactions.js';
import type { Bucket, Prisma } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type ItemFacts,
  type ProjectAccess,
  ProjectAccessService,
} from '../projects/project-access.service.js';
import { FileStoreService } from '../storage/file-store.service.js';
import {
  assertChildrenFit,
  assertParentType,
  closesCycle,
  type ItemLookup,
  MAX_HIERARCHY_DEPTH,
  parseItemRef,
} from './hierarchy.js';
import {
  itemInclude,
  type ItemRow,
  itemFacts,
  REF_SELECT,
  type RefRow,
  toChecklistItemDto,
  toItemDto,
  toItemRef,
} from './item.mapper.js';
import { sanitizeItemText } from './item-rich-text.js';
import {
  type CreateItemDto,
  type ListItemsQueryDto,
  type MoveItemDto,
  NONE,
  type UpdateItemDto,
} from './items.dto.js';

/** A JSON-safe before/after pair for audit entries. */
type Change = { from: Prisma.InputJsonValue | null; to: Prisma.InputJsonValue | null };

/**
 * Work items (SPEC §4, §4.1, §4.2, §8 `items`): listing, reading, creating,
 * editing, moving and deleting items, with the hierarchy and bucket/status
 * rules applied server-side in one transaction.
 *
 * Authorization (SPEC §3.4): `ProjectAccessGuard` checks the role-level
 * permission and refuses writes to archived projects; this service applies
 * {@link ProjectAccessService.itemScopeFilter} to every query that returns
 * items, so items outside the caller's scope are 404, and checks the
 * per-item rules (own items, team leadership) with the access service,
 * answering 403 for visible items the caller may not change.
 *
 * Some internal queries are deliberately unscoped and return no item
 * content: ancestor titles (shown read-only whatever the scope, SPEC §3.3),
 * card positions, child types and cycle checks.
 *
 * Assigning someone else and changing the status of an item someone else
 * created notify those people (SPEC §6), if they can see the item.
 */
@Injectable()
export class ItemsService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param audit Audit log; item entries form the activity history.
   * @param access Item permission rules and the visibility filter.
   * @param notifications Notifications for assignees and creators.
   * @param files Attachment files, removed with deleted items.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: ProjectAccessService,
    private readonly notifications: NotificationsService,
    private readonly files: FileStoreService,
  ) {}

  /**
   * Lists the items visible to the caller, filtered and ordered.
   *
   * Permissions: any member and any admin, limited to the caller's
   * visibility scope plus the items of teams they lead.
   *
   * @param access The caller's access.
   * @param query Filters, order and pagination.
   * @returns One page of items.
   */
  async list(access: ProjectAccess, query: ListItemsQueryDto): Promise<Page<WorkItemDto>> {
    if (!(await this.cursorVisible(access, query))) return { items: [], nextCursor: null };
    const rows = await this.prisma.workItem.findMany({
      where: this.scoped(access, listFilter(query)),
      include: this.include(access),
      orderBy:
        query.sort === 'position'
          ? [{ position: 'asc' }, { id: 'asc' }]
          : [{ number: 'asc' }, { id: 'asc' }],
      ...pageArgs(query),
    });
    return this.toPageDtos(this.prisma, access, rows, query);
  }

  /**
   * Returns one item with its checklist and visible dependencies.
   *
   * Permissions: 404 unless the item is visible to the caller.
   *
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @returns The item.
   */
  async get(access: ProjectAccess, ref: string): Promise<WorkItemDetailDto> {
    const row = await this.findVisible(this.prisma, access, ref);
    return this.detail(this.prisma, access, row);
  }

  /**
   * Lists an item's children that are visible to the caller.
   *
   * Permissions: 404 unless the parent is visible; children outside the
   * caller's scope are left out.
   *
   * @param access The caller's access.
   * @param ref Parent item uuid or number.
   * @param page Cursor and page size.
   * @returns One page of children, by number.
   */
  async children(
    access: ProjectAccess,
    ref: string,
    page: PageQueryDto,
  ): Promise<Page<WorkItemDto>> {
    const parent = await this.findVisible(this.prisma, access, ref);
    if (!(await this.cursorVisible(access, page))) return { items: [], nextCursor: null };
    const rows = await this.prisma.workItem.findMany({
      where: this.scoped(access, { parentId: parent.id }),
      include: this.include(access),
      orderBy: [{ number: 'asc' }, { id: 'asc' }],
      ...pageArgs(page),
    });
    return this.toPageDtos(this.prisma, access, rows, page);
  }

  /**
   * Returns an item's activity history: the audit entries about the item,
   * newest first (SPEC §6 item detail).
   *
   * Permissions: 404 unless the item is visible to the caller. For callers
   * with a restricted scope, references to items they cannot see (blockers,
   * former or new parents) are replaced by null and marked `redacted`.
   *
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @param page Cursor and page size.
   * @returns One page of audit entries.
   */
  async activity(
    access: ProjectAccess,
    ref: string,
    page: PageQueryDto,
  ): Promise<Page<AuditEntryDto>> {
    const item = await this.findVisible(this.prisma, access, ref);
    const entries = await this.audit.listItemHistory(access, item.id, page);
    if (!this.access.ancestorsAreTitleOnly(access)) return entries;
    const refs = [...new Set(entries.items.flatMap((e) => itemRefsIn(e.meta)))];
    if (refs.length === 0) return entries;
    const visible = await this.prisma.workItem.findMany({
      where: this.scoped(access, { id: { in: refs } }),
      select: { id: true },
    });
    const shown = new Set(visible.map((v) => v.id));
    return {
      ...entries,
      items: entries.items.map((e) => ({ ...e, meta: redactItemRefs(e.meta, shown) })),
    };
  }

  /**
   * Creates an item at the top of its bucket. Without an explicit status,
   * the bucket's entry rule decides it, as for a card moved in (SPEC §4.2).
   *
   * Permissions: `CREATE_ITEMS` (guard). Assigning anyone but yourself needs
   * `ASSIGN_OTHERS` or leading the item's team; putting it in a team follows
   * {@link ProjectAccessService.canSetTeam}. The new item must be visible to
   * its creator (400 otherwise), so nobody creates items they cannot see.
   * The parent must be visible too.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param dto The item.
   * @returns The new item (201).
   */
  async create(
    auth: AuthContext,
    access: ProjectAccess,
    dto: CreateItemDto,
  ): Promise<WorkItemDetailDto> {
    const projectId = access.project.id;
    const teamId = dto.teamId ?? null;
    const assigneeIds = dto.assigneeIds ?? [];
    if (access.project.ownerId !== null && (assigneeIds.length > 0 || teamId !== null))
      throw invalidField(
        'assigneeIds',
        'Personal tasks belong to their owner and cannot have assignments or teams',
      );
    if (!this.access.canSetTeam(access, null, teamId, true)) {
      throw forbidden('You cannot put items into this team');
    }
    if (!this.access.canAssign(access, assigneeIds, { teamId })) {
      throw forbidden('Your project role does not allow assigning items to others');
    }
    // A new item has no inline images yet, so any image is dropped.
    const description = sanitizeRichText(dto.description ?? '');
    const startDate = dto.startDate ?? null;
    const dueDate = dto.dueDate ?? null;
    assertDateOrder(startDate, dueDate);

    // Read committed: taking the next number locks the project row, which
    // serializes creates without making concurrent creates fail. References
    // deleted meanwhile surface as a foreign-key violation, mapped to 409.
    const row = await this.withForeignKeyConflict(() =>
      this.prisma.$transaction(async (tx) => {
        const parentId = dto.parentId ?? null;
        if (parentId !== null) {
          const parent = await this.findVisibleRef(tx, access, parentId, 'parentId', 'Parent');
          assertParentType(dto.type, parent.type);
        }
        const bucket = await findBucketFor(tx, projectId, dto.type, dto.bucketId ?? null);
        await assertOpenSprint(tx, projectId, dto.sprintId ?? null);
        await assertTeam(tx, projectId, teamId);
        await assertMembers(tx, projectId, assigneeIds);
        await assertLabels(tx, projectId, dto.labelIds ?? []);

        const facts: ItemFacts = {
          createdById: auth.user.id,
          assigneeIds,
          bucketId: bucket?.id ?? null,
          teamId,
          hasChildren: false,
        };
        if (!this.access.canViewItem(access, facts)) {
          throw invalidField(
            bucket === null ? 'teamId' : 'bucketId',
            'You could not see an item created here; choose a bucket or team in your scope',
          );
        }
        const status =
          dto.status ??
          (bucket === null
            ? ItemStatus.NOT_STARTED
            : statusOnEnter(bucket, ItemStatus.NOT_STARTED));
        // Take the number first: the row lock it holds until commit makes
        // concurrent creates read the top position one after another. Raw
        // SQL, so the project's updatedAt (and its settings edits) are untouched.
        const [counter] = await tx.$queryRaw<{ lastItemNumber: number }[]>`
          UPDATE "Project" SET "lastItemNumber" = "lastItemNumber" + 1
          WHERE "id" = ${projectId}::uuid RETURNING "lastItemNumber"`;
        if (counter === undefined) throw notFound('Project');
        const number = counter.lastItemNumber;
        const first = await tx.workItem.findFirst({
          where: { projectId, bucketId: bucket?.id ?? null },
          orderBy: { position: 'asc' },
          select: { position: true },
        });
        const item = await tx.workItem.create({
          data: {
            projectId,
            number,
            type: dto.type,
            parentId,
            title: dto.title,
            description,
            status,
            priority: dto.priority ?? undefined,
            bucketId: bucket?.id ?? null,
            sprintId: dto.sprintId ?? null,
            teamId,
            startDate: startDate === null ? null : toDbDate(startDate),
            dueDate: dueDate === null ? null : toDbDate(dueDate),
            position: first === null ? POSITION_STEP : first.position - POSITION_STEP,
            createdById: auth.user.id,
            completedAt: status === ItemStatus.DONE ? new Date() : null,
          },
        });
        await setAssignees(tx, projectId, item.id, [], assigneeIds);
        await setLabels(tx, projectId, item.id, [], dto.labelIds ?? []);
        await this.record(tx, auth, access, AuditAction.ITEM_CREATED, item.id, {
          number,
          type: item.type,
          title: item.title,
        });
        await this.notifications.notify(tx, {
          type: NotificationType.ASSIGNED,
          actorId: auth.user.id,
          projectId,
          itemId: item.id,
          facts,
          recipients: assigneeIds,
        });
        return tx.workItem.findUniqueOrThrow({
          where: { id: item.id },
          include: this.include(access),
        });
      }),
    );
    return this.detail(this.prisma, access, row);
  }

  /**
   * Changes an item's fields. A status change sets or clears `completedAt`
   * and, when the project maps the new status to a bucket and the item is
   * on the board, moves the card to the top of that bucket (SPEC §4.2); the
   * target bucket's entry rule does not run then, so the chosen status
   * stands.
   *
   * Permissions: 404 unless visible; 403 unless the caller may edit it
   * (`EDIT_ANY_ITEM`, own items with `EDIT_OWN_ITEMS`, or leading its
   * team). Changing assignees other than yourself needs `ASSIGN_OTHERS` or
   * leading the item's team; changing the team follows
   * {@link ProjectAccessService.canSetTeam}; a new parent must be visible.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @param dto Fields to change.
   * @returns The updated item.
   */
  async update(
    auth: AuthContext,
    access: ProjectAccess,
    ref: string,
    dto: UpdateItemDto,
  ): Promise<WorkItemDetailDto> {
    const projectId = access.project.id;
    const row = await serializable(this.prisma, async (tx) => {
      const current = await this.findVisible(tx, access, ref);
      if (!this.access.canEditItem(access, itemFacts(current))) throw forbidden();

      const changes: Record<string, Change> = {};
      const data: Prisma.WorkItemUncheckedUpdateInput = {};
      const note = (field: string, from: Change['from'], to: Change['to']): void => {
        changes[field] = { from, to };
      };

      // Permission-type rules first, so a forbidden change is a 403 even if
      // other fields are invalid.
      const teamId = dto.teamId === undefined ? current.teamId : dto.teamId;
      if (!this.access.canSetTeam(access, current.teamId, teamId, false)) {
        throw forbidden('You cannot move items into or out of this team');
      }
      const before = current.assignees.map((a) => a.userId);
      const after = dto.assigneeIds ?? before;
      if (access.project.ownerId !== null && (after.length > 0 || teamId !== null))
        throw invalidField('assigneeIds', 'Personal tasks cannot have assignments or teams');
      const touched = [
        ...after.filter((id) => !before.includes(id)),
        ...before.filter((id) => !after.includes(id)),
      ];
      if (!this.access.canAssign(access, touched, { teamId })) {
        throw forbidden('Your project role does not allow assigning items to others');
      }

      const type = dto.type ?? current.type;
      if (type !== current.type) {
        const children = await tx.workItem.findMany({
          where: { parentId: current.id },
          select: { type: true },
          distinct: ['type'],
        });
        assertChildrenFit(
          type,
          children.map((c) => c.type),
        );
        if (requiresBucket(type) && current.bucketId === null) {
          throw invalidField('type', 'Move the item onto the board before making it a ' + type);
        }
        note('type', current.type, type);
        data.type = type;
      }
      const parentId = dto.parentId === undefined ? current.parentId : dto.parentId;
      if (parentId !== current.parentId) {
        if (parentId !== null) {
          const parent = await this.findVisibleRef(tx, access, parentId, 'parentId', 'Parent');
          assertParentType(type, parent.type);
          if (closesCycle(current.id, await ancestorChain(tx, projectId, parent))) {
            throw invalidField('parentId', 'An item cannot sit under its own descendant');
          }
        }
        note('parentId', current.parentId, parentId);
        data.parentId = parentId;
      } else if (type !== current.type && parentId !== null) {
        // Unscoped on purpose: only the parent's type is read, and the
        // caller already sees the parent's title as an ancestor.
        const parent = await tx.workItem.findUniqueOrThrow({
          where: { id: parentId },
          select: { type: true },
        });
        assertParentType(type, parent.type);
      }

      if (dto.title !== undefined && dto.title !== current.title) {
        note('title', current.title, dto.title);
        data.title = dto.title;
      }
      if (dto.description !== undefined) {
        const { html: description } = await sanitizeItemText(
          tx,
          projectId,
          current.id,
          dto.description,
        );
        if (description !== current.description) {
          // The text itself stays out of the audit log; it can be long.
          note('description', null, null);
          data.description = description;
        }
      }
      if (dto.priority !== undefined && dto.priority !== current.priority) {
        note('priority', current.priority, dto.priority);
        data.priority = dto.priority;
      }
      const startDate = dto.startDate === undefined ? fromDbDate(current.startDate) : dto.startDate;
      const dueDate = dto.dueDate === undefined ? fromDbDate(current.dueDate) : dto.dueDate;
      assertDateOrder(startDate, dueDate);
      if (startDate !== fromDbDate(current.startDate)) {
        note('startDate', fromDbDate(current.startDate), startDate);
        data.startDate = startDate === null ? null : toDbDate(startDate);
      }
      if (dueDate !== fromDbDate(current.dueDate)) {
        note('dueDate', fromDbDate(current.dueDate), dueDate);
        data.dueDate = dueDate === null ? null : toDbDate(dueDate);
      }
      const sprintId = dto.sprintId === undefined ? current.sprintId : dto.sprintId;
      if (sprintId !== current.sprintId) {
        await assertOpenSprint(tx, projectId, sprintId);
        note('sprintId', current.sprintId, sprintId);
        data.sprintId = sprintId;
      }
      if (teamId !== current.teamId) {
        await assertTeam(tx, projectId, teamId);
        note('teamId', current.teamId, teamId);
        data.teamId = teamId;
      }
      if (dto.status !== undefined && dto.status !== current.status) {
        note('status', current.status, dto.status);
        data.status = dto.status;
        data.completedAt = dto.status === ItemStatus.DONE ? new Date() : null;
        const mapped = access.settings.statusToBucket[dto.status];
        if (current.bucketId !== null && mapped !== undefined && mapped !== current.bucketId) {
          const target = await tx.bucket.findFirst({ where: { id: mapped, projectId } });
          // The card only moves where the caller can still see it.
          const visibleThere =
            target !== null &&
            this.access.canViewItem(access, {
              ...itemFacts(current),
              bucketId: target.id,
              teamId,
            });
          if (target !== null && visibleThere) {
            note('bucketId', current.bucketId, target.id);
            data.bucketId = target.id;
            data.position = await topPosition(tx, projectId, target.id);
          }
        }
      }
      if (touched.length > 0) {
        await assertMembers(
          tx,
          projectId,
          after.filter((id) => !before.includes(id)),
        );
        await setAssignees(tx, projectId, current.id, before, after);
        note('assigneeIds', before, after);
      }
      if (dto.labelIds !== undefined) {
        const labelsBefore = current.labels.map((l) => l.labelId);
        if (!sameIds(labelsBefore, dto.labelIds)) {
          await assertLabels(
            tx,
            projectId,
            dto.labelIds.filter((id) => !labelsBefore.includes(id)),
          );
          await setLabels(tx, projectId, current.id, labelsBefore, dto.labelIds);
          note('labelIds', labelsBefore, dto.labelIds);
        }
      }

      if (Object.keys(changes).length === 0) return current;
      // Always bump updatedAt, also when only assignees or labels changed.
      await tx.workItem.update({
        where: { id: current.id },
        data: { ...data, updatedAt: new Date() },
      });
      await this.record(tx, auth, access, AuditAction.ITEM_UPDATED, current.id, {
        number: current.number,
        changes,
      });
      const updated = await tx.workItem.findUniqueOrThrow({
        where: { id: current.id },
        include: this.include(access),
      });
      await this.notifications.notify(tx, {
        type: NotificationType.ASSIGNED,
        actorId: auth.user.id,
        projectId,
        itemId: current.id,
        facts: itemFacts(updated),
        recipients: after.filter((id) => !before.includes(id)),
      });
      if (changes['status'] !== undefined) {
        await this.notifyStatusChange(tx, auth, access, updated);
      }
      return updated;
    });
    return this.detail(this.prisma, access, row);
  }

  /**
   * Moves a card into a bucket (or within its bucket), right after another
   * card or at the top. Entering a different bucket applies that bucket's
   * entry rule to the status (SPEC §4.2); the status → bucket map does not
   * run again for that change. Reordering within a bucket is not audited.
   *
   * Permissions: 404 unless visible; 403 unless the caller may move it
   * (`MOVE_ANY_ITEM`, own cards with `MOVE_OWN_ITEMS`, or leading its
   * team). The neighbour card must be visible too, and the caller may not
   * move a card to a bucket outside their scope (400).
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @param dto Target bucket and neighbour.
   * @returns The moved item with its final bucket and status.
   */
  async move(
    auth: AuthContext,
    access: ProjectAccess,
    ref: string,
    dto: MoveItemDto,
  ): Promise<WorkItemDetailDto> {
    const projectId = access.project.id;
    const row = await serializable(this.prisma, async (tx) => {
      const current = await this.findVisible(tx, access, ref);
      const facts = itemFacts(current);
      if (!this.access.canMoveItem(access, facts)) throw forbidden();

      const bucketId = dto.bucketId === undefined ? current.bucketId : dto.bucketId;
      const bucket = await findBucketFor(tx, projectId, current.type, bucketId);
      const bucketChanged = bucketId !== current.bucketId;
      if (bucketChanged && !this.access.canViewItem(access, { ...facts, bucketId })) {
        throw invalidField('bucketId', 'You cannot move cards to a bucket outside your scope');
      }
      const afterId = dto.afterId ?? null;
      if (afterId !== null) {
        const neighbour =
          afterId === current.id
            ? null
            : await tx.workItem.findFirst({
                where: this.scoped(access, { id: afterId, bucketId }),
                select: { id: true },
              });
        if (neighbour === null) throw invalidField('afterId', 'Card not found in that bucket');
      }
      // Unscoped on purpose: only ids and positions are read, to keep the
      // order consistent for everyone.
      const siblings = await tx.workItem.findMany({
        where: { projectId, bucketId, id: { not: current.id } },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: { id: true, position: true },
      });
      const placement = placeAfter(siblings, afterId);
      for (const sibling of placement.renumber) {
        await tx.workItem.update({
          where: { id: sibling.id },
          data: { position: sibling.position },
        });
      }
      const status =
        bucketChanged && bucket !== null ? statusOnEnter(bucket, current.status) : current.status;
      await tx.workItem.update({
        where: { id: current.id },
        data: {
          bucketId,
          position: placement.position,
          status,
          ...(status === current.status
            ? {}
            : { completedAt: status === ItemStatus.DONE ? new Date() : null }),
        },
      });
      if (bucketChanged) {
        await this.record(tx, auth, access, AuditAction.ITEM_MOVED, current.id, {
          number: current.number,
          from: current.bucketId,
          to: bucketId,
          ...(status === current.status ? {} : { status: { from: current.status, to: status } }),
        });
      }
      const moved = await tx.workItem.findUniqueOrThrow({
        where: { id: current.id },
        include: this.include(access),
      });
      if (status !== current.status) await this.notifyStatusChange(tx, auth, access, moved);
      return moved;
    });
    return this.detail(this.prisma, access, row);
  }

  /**
   * Deletes an item. An item with children is only deleted with
   * `cascade=true`, which deletes its whole subtree (SPEC §4.1).
   *
   * Permissions: 404 unless visible; then project PMs and Leads may delete
   * any item, with or without cascade; team Leads their team's items without
   * cascade; Members items they created that have no children (403
   * otherwise). 409 `HAS_CHILDREN` for a non-cascade delete of a parent.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @param cascade Whether to delete the subtree.
   * @returns Resolves once deleted (204).
   */
  async remove(
    auth: AuthContext,
    access: ProjectAccess,
    ref: string,
    cascade: boolean,
  ): Promise<void> {
    const projectId = access.project.id;
    const files = await serializable(this.prisma, async (tx) => {
      const current = await this.findVisible(tx, access, ref);
      // Every child counts here, also those the caller cannot see.
      const children = await tx.workItem.count({ where: { parentId: current.id } });
      const facts = { ...itemFacts(current), hasChildren: children > 0 };
      if (!this.access.canDeleteItem(access, facts, cascade)) throw forbidden();
      if (children > 0 && !cascade) {
        throw conflict(
          'This item has child items; delete them first or delete with cascade',
          ErrorCode.HAS_CHILDREN,
        );
      }
      // Unscoped on purpose: cascades are for PMs and Leads, who see every item.
      const ids = [current.id];
      for (let frontier = [current.id]; frontier.length > 0;) {
        const children = await tx.workItem.findMany({
          where: { projectId, parentId: { in: frontier } },
          select: { id: true },
        });
        frontier = children.map((c) => c.id);
        ids.push(...frontier);
      }
      // Their notes, attachments and notifications go with the rows.
      const files = await tx.attachment.findMany({
        where: { workItemId: { in: ids } },
        select: { storedName: true },
      });
      // One statement, so the parent links are checked only once all rows are gone.
      await tx.workItem.deleteMany({ where: { projectId, id: { in: ids } } });
      await this.record(tx, auth, access, AuditAction.ITEM_DELETED, current.id, {
        number: current.number,
        type: current.type,
        title: current.title,
        ...(cascade ? { cascade: true, descendants: ids.length - 1 } : {}),
      });
      return files;
    });
    // Only once the rows are gone for good; a rolled-back delete keeps its files.
    await this.files.remove(files.map((f) => ({ projectId, storedName: f.storedName })));
  }

  /**
   * Loads an item by uuid or number through the caller's visibility filter.
   *
   * Permissions: 404 for malformed refs, unknown items and items outside the
   * caller's scope alike (SPEC §3.4).
   *
   * @param db Database or transaction client.
   * @param access The caller's access.
   * @param ref Item uuid or number from the URL.
   * @returns The item.
   */
  async findVisible(db: DbClient, access: ProjectAccess, ref: string): Promise<ItemRow> {
    const lookup: ItemLookup | null = parseItemRef(ref);
    if (lookup === null) throw notFound('Item');
    const row = await db.workItem.findFirst({
      where: this.scoped(access, lookup),
      include: this.include(access),
    });
    if (row === null) throw notFound('Item');
    return row;
  }

  /**
   * Builds the full item response: ancestors, checklist, the caller's
   * capabilities and the dependencies the caller can see.
   *
   * @param db Database or transaction client.
   * @param access The caller's access.
   * @param row The item.
   * @returns The DTO.
   */
  async detail(db: DbClient, access: ProjectAccess, row: ItemRow): Promise<WorkItemDetailDto> {
    const key = access.project.key;
    const [ancestors] = await this.ancestors(db, access, [row]);
    const [checklist, blockedBy, blocks] = await Promise.all([
      db.checklistItem.findMany({
        where: { workItemId: row.id },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      }),
      db.workItem.findMany({
        where: this.scoped(access, { blocks: { some: { blockedItemId: row.id } } }),
        select: REF_SELECT,
        orderBy: { number: 'asc' },
      }),
      db.workItem.findMany({
        where: this.scoped(access, { blockedBy: { some: { blockingItemId: row.id } } }),
        select: REF_SELECT,
        orderBy: { number: 'asc' },
      }),
    ]);
    return {
      ...toItemDto(key, row, ancestors ?? [], this.capabilities(access, row)),
      checklistItems: checklist.map(toChecklistItemDto),
      blockedBy: blockedBy.map((r) => toItemRef(key, r)),
      blocks: blocks.map((r) => toItemRef(key, r)),
    };
  }

  /**
   * The relations loaded with every item for this caller.
   *
   * @param access The caller's access.
   * @returns The Prisma include.
   */
  include(access: ProjectAccess): ReturnType<typeof itemInclude> {
    return itemInclude(this.access.itemScopeFilter(access));
  }

  /**
   * Restricts an item query to the project and the caller's visibility.
   *
   * @param access The caller's access.
   * @param where Further conditions.
   * @returns The combined condition.
   */
  scoped(access: ProjectAccess, where: Prisma.WorkItemWhereInput): Prisma.WorkItemWhereInput {
    return { AND: [{ projectId: access.project.id }, this.access.itemScopeFilter(access), where] };
  }

  /**
   * Restricts an item query to several projects at once, each with the
   * caller's visibility there: the cross-project counterpart of
   * {@link scoped}, for lists that span projects ("all their work").
   *
   * @param accesses The caller's access to each project.
   * @param where Further conditions.
   * @returns The combined condition; matches nothing for an empty list.
   */
  scopedAcross(
    accesses: readonly ProjectAccess[],
    where: Prisma.WorkItemWhereInput,
  ): Prisma.WorkItemWhereInput {
    const perProject = accesses.map((access) => ({
      AND: [{ projectId: access.project.id }, this.access.itemScopeFilter(access)],
    }));
    return { AND: [{ OR: perProject }, where] };
  }

  /**
   * Writes an audit entry about an item; these entries are its activity
   * history.
   *
   * @param db Transaction client.
   * @param auth The caller.
   * @param access The caller's access.
   * @param action What happened.
   * @param itemId Item id.
   * @param meta Extra detail.
   * @returns Resolves once written.
   */
  record(
    db: DbClient,
    auth: AuthContext,
    access: ProjectAccess,
    action: AuditAction,
    itemId: string,
    meta: Prisma.InputJsonObject,
  ): Promise<void> {
    return this.audit.record(
      {
        actorId: auth.user.id,
        action,
        entityType: 'WorkItem',
        entityId: itemId,
        projectId: access.project.id,
        meta,
      },
      db,
    );
  }

  /**
   * Tells an item's creator that someone else changed its status (SPEC §6).
   *
   * @param db Transaction client.
   * @param auth The caller.
   * @param access The caller's access.
   * @param row The item after the change.
   * @returns Resolves once recorded.
   */
  private async notifyStatusChange(
    db: DbClient,
    auth: AuthContext,
    access: ProjectAccess,
    row: ItemRow,
  ): Promise<void> {
    await this.notifications.notify(db, {
      type: NotificationType.STATUS_CHANGED,
      actorId: auth.user.id,
      projectId: access.project.id,
      itemId: row.id,
      facts: itemFacts(row),
      recipients: [row.createdById],
    });
  }

  /**
   * Loads a referenced item (a parent) through the caller's visibility
   * filter. Unknown and invisible items get the same 400, so a body
   * reference reveals nothing.
   *
   * @param db Transaction client.
   * @param access The caller's access.
   * @param id Item id.
   * @param field Request field, for the error.
   * @param what Name for the error message.
   * @returns The item's reference columns.
   */
  private async findVisibleRef(
    db: DbClient,
    access: ProjectAccess,
    id: string,
    field: string,
    what: string,
  ): Promise<RefRow> {
    const row = await db.workItem.findFirst({
      where: this.scoped(access, { id }),
      select: REF_SELECT,
    });
    if (row === null) throw invalidField(field, `${what} not found`);
    return row;
  }

  /**
   * Reports whether a list cursor names an item the caller can see. An
   * unknown or hidden cursor gives an empty page either way, so the cursor
   * cannot be used to probe for hidden items.
   *
   * @param access The caller's access.
   * @param page The page query.
   * @returns True when there is no cursor or it is visible.
   */
  private async cursorVisible(access: ProjectAccess, page: PageQueryDto): Promise<boolean> {
    if (page.cursor === undefined) return true;
    const row = await this.prisma.workItem.findFirst({
      where: this.scoped(access, { id: page.cursor }),
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * What the caller may do with an item.
   *
   * @param access The caller's access.
   * @param row The item.
   * @returns The capabilities.
   */
  private capabilities(access: ProjectAccess, row: ItemRow): ItemCapabilitiesDto {
    const facts = itemFacts(row);
    return {
      edit: this.access.canEditItem(access, facts),
      move: this.access.canMoveItem(access, facts),
      delete: this.access.canDeleteItem(access, facts, false),
      deleteCascade: this.access.canDeleteItem(access, facts, true),
      annotate: this.access.canAnnotateItem(access, facts),
    };
  }

  /**
   * Builds a page of item DTOs with their ancestors.
   *
   * @param db Database client.
   * @param access The caller's access.
   * @param rows Rows from a paginated query.
   * @param page The page query.
   * @returns The page.
   */
  private async toPageDtos(
    db: DbClient,
    access: ProjectAccess,
    rows: ItemRow[],
    page: PageQueryDto,
  ): Promise<Page<WorkItemDto>> {
    const result = toPage(rows, page, (row) => row);
    const chains = await this.ancestors(db, access, result.items);
    return {
      items: result.items.map((row, i) =>
        toItemDto(access.project.key, row, chains[i] ?? [], this.capabilities(access, row)),
      ),
      nextCursor: result.nextCursor,
    };
  }

  /**
   * Loads the ancestor chains of several items, root first, as read-only
   * titles (SPEC §3.3). Unscoped on purpose: ancestors are shown as titles
   * whatever the caller's scope. One query per hierarchy level.
   *
   * @param db Database client.
   * @param access The caller's access.
   * @param rows The items.
   * @returns One chain per item, in the same order.
   */
  private async ancestors(
    db: DbClient,
    access: ProjectAccess,
    rows: readonly RefRow[],
  ): Promise<ItemRefDto[][]> {
    const { id: projectId, key } = access.project;
    const known = new Map<string, RefRow>(rows.map((r) => [r.id, r]));
    const unknown = (ids: (string | null)[]): string[] => [
      ...new Set(ids.filter((id): id is string => id !== null && !known.has(id))),
    ];
    let missing = unknown(rows.map((r) => r.parentId));
    for (let depth = 0; missing.length > 0 && depth < MAX_HIERARCHY_DEPTH; depth++) {
      const found = await db.workItem.findMany({
        where: { projectId, id: { in: missing } },
        select: REF_SELECT,
      });
      for (const row of found) known.set(row.id, row);
      missing = unknown(found.map((r) => r.parentId));
    }
    return rows.map((row) => {
      const chain: ItemRefDto[] = [];
      for (
        let parent = row.parentId === null ? undefined : known.get(row.parentId);
        parent !== undefined && chain.length < MAX_HIERARCHY_DEPTH;
        parent = parent.parentId === null ? undefined : known.get(parent.parentId)
      ) {
        chain.unshift(toItemRef(key, parent));
      }
      return chain;
    });
  }

  /**
   * Runs work, converting a foreign-key violation (a referenced row deleted
   * concurrently) to 409 `CONFLICT`.
   *
   * @param work The work.
   * @returns Its result.
   */
  private async withForeignKeyConflict<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw conflict('Something this item refers to was just changed; please try again');
      }
      throw error;
    }
  }
}

/**
 * Narrows an unknown JSON value to an object.
 *
 * @param value Any value.
 * @returns True for non-array objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The `parentId` change recorded in an `ITEM_UPDATED` entry, if any.
 *
 * @param meta Audit entry detail.
 * @returns The change, or null.
 */
function parentChange(meta: Record<string, unknown>): Record<string, unknown> | null {
  const changes = meta['changes'];
  if (!isRecord(changes)) return null;
  const change = changes['parentId'];
  return isRecord(change) ? change : null;
}

/**
 * Ids of other items an activity entry refers to: a blocker, or a former
 * or new parent.
 *
 * @param meta Audit entry detail.
 * @returns Item ids.
 */
function itemRefsIn(meta: Record<string, unknown>): string[] {
  const parent = parentChange(meta);
  return [meta['blockingItemId'], parent?.['from'], parent?.['to']].filter(
    (id): id is string => typeof id === 'string',
  );
}

/**
 * Replaces references to items the caller cannot see with null.
 *
 * @param meta Audit entry detail.
 * @param shown Ids of the referenced items the caller can see.
 * @returns The detail to return.
 */
function redactItemRefs(
  meta: Record<string, unknown>,
  shown: ReadonlySet<string>,
): Record<string, unknown> {
  const hidden = (id: unknown): boolean => typeof id === 'string' && !shown.has(id);
  const out: Record<string, unknown> = { ...meta };
  if (hidden(meta['blockingItemId'])) {
    out['blockingItemId'] = null;
    out['blockingNumber'] = null;
    out['redacted'] = true;
  }
  const parent = parentChange(meta);
  if (parent !== null && (hidden(parent['from']) || hidden(parent['to']))) {
    out['changes'] = {
      ...(meta['changes'] as Record<string, unknown>),
      parentId: {
        from: hidden(parent['from']) ? null : parent['from'],
        to: hidden(parent['to']) ? null : parent['to'],
      },
    };
    out['redacted'] = true;
  }
  return out;
}

/**
 * Builds the filter part of an item list query.
 *
 * @param query The validated query.
 * @returns Conditions to combine with the scope.
 */
function listFilter(query: ListItemsQueryDto): Prisma.WorkItemWhereInput {
  const orNone = (value: string | undefined): string | null | undefined =>
    value === NONE ? null : value;
  const where: Prisma.WorkItemWhereInput = {
    type: query.type,
    status: query.status,
    bucketId: orNone(query.bucketId),
    sprintId: orNone(query.sprintId),
    teamId: orNone(query.teamId),
    parentId: orNone(query.parentId),
  };
  if (query.assigneeId !== undefined) where.assignees = { some: { userId: query.assigneeId } };
  if (query.labelId !== undefined) where.labels = { some: { labelId: query.labelId } };
  if (query.dueFrom !== undefined || query.dueTo !== undefined) {
    where.dueDate = {
      ...(query.dueFrom === undefined ? {} : { gte: toDbDate(query.dueFrom) }),
      ...(query.dueTo === undefined ? {} : { lte: toDbDate(query.dueTo) }),
    };
  }
  const q = query.q?.trim();
  if (q !== undefined && q !== '') {
    const number = /^\d{1,9}$/.test(q) ? Number(q) : null;
    where.OR = [
      { title: { contains: q, mode: 'insensitive' } },
      ...(number === null ? [] : [{ number }]),
    ];
  }
  return where;
}

/**
 * Checks the bucket an item goes into: it must belong to the project, and
 * Stories, Tasks and Bugs must have one (SPEC §4).
 *
 * @param db Transaction client.
 * @param projectId Project id.
 * @param type The item's type.
 * @param bucketId Requested bucket, or null.
 * @returns The bucket, or null.
 */
async function findBucketFor(
  db: DbClient,
  projectId: string,
  type: ItemType,
  bucketId: string | null,
): Promise<Bucket | null> {
  if (bucketId === null) {
    if (requiresBucket(type)) throw invalidField('bucketId', `A ${type} must be in a bucket`);
    return null;
  }
  const bucket = await db.bucket.findFirst({ where: { id: bucketId, projectId } });
  if (bucket === null) throw invalidField('bucketId', 'Bucket not found');
  return bucket;
}

/**
 * Checks that a sprint belongs to the project and is not closed.
 *
 * @param db Transaction client.
 * @param projectId Project id.
 * @param sprintId Sprint id, or null for none.
 */
async function assertOpenSprint(
  db: DbClient,
  projectId: string,
  sprintId: string | null,
): Promise<void> {
  if (sprintId === null) return;
  const sprint = await db.sprint.findFirst({ where: { id: sprintId, projectId } });
  if (sprint === null) throw invalidField('sprintId', 'Sprint not found');
  if (sprint.state === SprintState.CLOSED) {
    throw invalidField('sprintId', 'Items cannot be added to a closed sprint');
  }
}

/**
 * Checks that a team belongs to the project.
 *
 * @param db Transaction client.
 * @param projectId Project id.
 * @param teamId Team id, or null for none.
 */
async function assertTeam(db: DbClient, projectId: string, teamId: string | null): Promise<void> {
  if (teamId === null) return;
  if ((await db.team.count({ where: { id: teamId, projectId } })) === 0) {
    throw invalidField('teamId', 'Team not found');
  }
}

/**
 * Checks that every user is a member of the project (assignees).
 *
 * @param db Transaction client.
 * @param projectId Project id.
 * @param userIds User ids.
 */
async function assertMembers(
  db: DbClient,
  projectId: string,
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const count = await db.projectMember.count({
    where: { projectId, userId: { in: [...userIds] } },
  });
  if (count !== userIds.length) {
    throw invalidField('assigneeIds', 'Items can only be assigned to project members');
  }
}

/**
 * Checks that every label belongs to the project.
 *
 * @param db Transaction client.
 * @param projectId Project id.
 * @param labelIds Label ids.
 */
async function assertLabels(
  db: DbClient,
  projectId: string,
  labelIds: readonly string[],
): Promise<void> {
  if (labelIds.length === 0) return;
  const count = await db.label.count({ where: { projectId, id: { in: [...labelIds] } } });
  if (count !== labelIds.length) throw invalidField('labelIds', 'Label not found');
}

/**
 * Throws 400 if the due date is before the start date.
 *
 * @param startDate `YYYY-MM-DD` or null.
 * @param dueDate `YYYY-MM-DD` or null.
 */
function assertDateOrder(startDate: string | null, dueDate: string | null): void {
  // ISO calendar dates compare correctly as strings.
  if (startDate !== null && dueDate !== null && dueDate < startDate) {
    throw invalidField('dueDate', 'The due date is before the start date');
  }
}

/**
 * Replaces an item's assignees.
 *
 * @param db Transaction client.
 * @param projectId Project id.
 * @param itemId Item id.
 * @param before Current assignee ids.
 * @param after New assignee ids.
 * @returns Resolves once written.
 */
async function setAssignees(
  db: DbClient,
  projectId: string,
  itemId: string,
  before: readonly string[],
  after: readonly string[],
): Promise<void> {
  const removed = before.filter((id) => !after.includes(id));
  const added = after.filter((id) => !before.includes(id));
  if (removed.length > 0) {
    await db.workItemAssignee.deleteMany({
      where: { workItemId: itemId, userId: { in: removed } },
    });
  }
  if (added.length > 0) {
    await db.workItemAssignee.createMany({
      data: added.map((userId) => ({ workItemId: itemId, projectId, userId })),
    });
  }
}

/**
 * Replaces an item's labels.
 *
 * @param db Transaction client.
 * @param projectId Project id.
 * @param itemId Item id.
 * @param before Current label ids.
 * @param after New label ids.
 * @returns Resolves once written.
 */
async function setLabels(
  db: DbClient,
  projectId: string,
  itemId: string,
  before: readonly string[],
  after: readonly string[],
): Promise<void> {
  const removed = before.filter((id) => !after.includes(id));
  const added = after.filter((id) => !before.includes(id));
  if (removed.length > 0) {
    await db.workItemLabel.deleteMany({ where: { workItemId: itemId, labelId: { in: removed } } });
  }
  if (added.length > 0) {
    await db.workItemLabel.createMany({
      data: added.map((labelId) => ({ workItemId: itemId, projectId, labelId })),
    });
  }
}

/**
 * Position at the top of a bucket.
 *
 * @param db Transaction client.
 * @param projectId Project id.
 * @param bucketId Bucket id.
 * @returns A position before every card in the bucket.
 */
async function topPosition(db: DbClient, projectId: string, bucketId: string): Promise<number> {
  const first = await db.workItem.findFirst({
    where: { projectId, bucketId },
    orderBy: { position: 'asc' },
    select: { position: true },
  });
  return first === null ? POSITION_STEP : first.position - POSITION_STEP;
}

/**
 * The ids of an item and its ancestors, nearest first. Unscoped on purpose:
 * used only to detect hierarchy cycles.
 *
 * @param db Transaction client.
 * @param projectId Project id.
 * @param start The first item of the chain.
 * @returns The ids.
 */
async function ancestorChain(db: DbClient, projectId: string, start: RefRow): Promise<string[]> {
  const chain = [start.id];
  let parentId = start.parentId;
  while (parentId !== null && chain.length <= MAX_HIERARCHY_DEPTH) {
    chain.push(parentId);
    const parent = await db.workItem.findFirst({
      where: { id: parentId, projectId },
      select: { parentId: true },
    });
    parentId = parent?.parentId ?? null;
  }
  return chain;
}

/**
 * Compares two id lists as sets.
 *
 * @param a First list.
 * @param b Second list.
 * @returns True if both hold the same ids.
 */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}
