import {
  fitTypeUnder,
  hasOwnSprint,
  isAllowedParent,
  type ItemType,
  type MoveItemRequest,
  type UpdateItemRequest,
  type WorkItemDto,
} from '@kloister/shared';
import { errorMessage } from './api';
import { revertFields, revertMove, undoFields } from './item-changes';
import { TYPE_LABELS } from './labels';
import { NONE } from './board-logic';
import { shareOf, sharesOf, withShareFor } from './shares';

// Backlog and timeline bulk edits (SPEC §6: set sprint, bucket or assignee
// for many items; §6.4 adds status, priority, labels and adding an
// assignee). They run as one ordinary request per item (PATCH or move), so
// every item goes through exactly the same API checks as a single edit, and
// one refused item does not undo the others. Items whose capabilities rule
// the change out are skipped without a request; the API remains the
// authority for the rest.

/** What a bulk edit sets. */
export type BulkField =
  | 'sprint'
  | 'bucket'
  | 'assignee'
  | 'assigneeAdd'
  | 'status'
  | 'priority'
  | 'labelAdd'
  | 'labelRemove'
  | 'share'
  | 'type'
  | 'parent';

/** One request of a bulk edit. */
export type BulkStep =
  | { item: WorkItemDto; kind: 'move'; request: MoveItemRequest }
  | { item: WorkItemDto; kind: 'update'; request: UpdateItemRequest };

/** What the caller is allowed, for skipping items up front. */
export interface BulkRights {
  /** The caller's user id. */
  userId: string;
  /** Whether the caller may assign others on an item of this team. */
  canAssignOthers(teamId: string | null): boolean;
  /** Types of an item's visible children (for `type` and `parent`, v1.3.1). */
  childTypes?(itemId: string): ItemType[];
  /** A visible item by id (the new parent for `parent`). */
  itemById?(itemId: string): WorkItemDto | undefined;
}

/** The requests to send and the items left out. */
export interface BulkPlan {
  /** Requests, in selection order. */
  steps: BulkStep[];
  /** Items the caller may not change this way. */
  skipped: WorkItemDto[];
  /** Items that already have the value. */
  unchanged: WorkItemDto[];
  /** Why a skipped item was left out, when there is more to say than "not allowed". */
  reasons: Map<string, string>;
}

/** Result of a bulk edit. */
export interface BulkResult {
  /** Items as the API returned them. */
  updated: WorkItemDto[];
  /** Refused items with the API's message. */
  failed: { item: WorkItemDto; message: string }[];
}

/**
 * Plans a bulk edit.
 *
 * @param items Selected items.
 * @param field What to set.
 * @param value Sprint, bucket or user id, or {@link NONE} for "no sprint" /
 *   "unassigned"; for `share`, `userId:percent` (M13).
 * @param rights What the caller may do.
 * @returns The requests to send and the items left out.
 */
export function planBulk(
  items: WorkItemDto[],
  field: BulkField,
  value: string,
  rights: BulkRights,
): BulkPlan {
  const plan: BulkPlan = { steps: [], skipped: [], unchanged: [], reasons: new Map() };
  const skip = (item: WorkItemDto, reason?: string): void => {
    plan.skipped.push(item);
    if (reason !== undefined) plan.reasons.set(item.id, reason);
  };
  const target = value === NONE ? null : value;
  for (const item of items) {
    switch (field) {
      case 'sprint':
        // Sprints shape the plan (M9.2), so they need `can.plan`; Epics and
        // Features have none of their own (M12) and are skipped.
        if (item.sprintId === target) plan.unchanged.push(item);
        else if (!item.can.plan || !hasOwnSprint(item.type)) plan.skipped.push(item);
        else plan.steps.push({ item, kind: 'update', request: { sprintId: target } });
        break;
      case 'bucket':
        if (item.bucketId === target) plan.unchanged.push(item);
        else if (!item.can.move || target === null) plan.skipped.push(item);
        else plan.steps.push({ item, kind: 'move', request: { bucketId: target } });
        break;
      case 'status':
        if (item.status === value) plan.unchanged.push(item);
        else if (!item.can.edit) plan.skipped.push(item);
        else
          plan.steps.push({
            item,
            kind: 'update',
            request: { status: value as WorkItemDto['status'] },
          });
        break;
      case 'priority':
        if (item.priority === Number(value)) plan.unchanged.push(item);
        else if (!item.can.edit) plan.skipped.push(item);
        else plan.steps.push({ item, kind: 'update', request: { priority: Number(value) } });
        break;
      case 'labelAdd':
      case 'labelRemove': {
        const has = item.labelIds.includes(value);
        if (has === (field === 'labelAdd')) plan.unchanged.push(item);
        else if (!item.can.edit) plan.skipped.push(item);
        else
          plan.steps.push({
            item,
            kind: 'update',
            request: {
              labelIds: has
                ? item.labelIds.filter((id) => id !== value)
                : [...item.labelIds, value],
            },
          });
        break;
      }
      case 'share': {
        // One person's share on every row, adding them where they are not
        // assigned yet (M13). Shares are part of the plan (M9.2).
        const [person = '', percent = ''] = value.split(':');
        const share = Number(percent);
        const now = shareOf(item, person);
        if (now === share) plan.unchanged.push(item);
        else if (
          !item.can.edit ||
          (share !== 100 || now !== null ? !item.can.plan : false) ||
          (now === null && person !== rights.userId && !rights.canAssignOthers(item.teamId))
        )
          plan.skipped.push(item);
        else
          plan.steps.push({
            item,
            kind: 'update',
            request: { assignees: withShareFor(sharesOf(item), person, share) },
          });
        break;
      }
      case 'assignee':
      case 'assigneeAdd': {
        const next =
          field === 'assigneeAdd'
            ? target === null || item.assigneeIds.includes(target)
              ? item.assigneeIds
              : [...item.assigneeIds, target]
            : target === null
              ? []
              : [target];
        // Assigning or unassigning anyone but yourself needs ASSIGN_OTHERS
        // or leading the item's team (SPEC §3.2, §3.5).
        const touched = [
          ...item.assigneeIds.filter((id) => !next.includes(id)),
          ...next.filter((id) => !item.assigneeIds.includes(id)),
        ];
        if (touched.length === 0) plan.unchanged.push(item);
        else if (
          !item.can.edit ||
          (touched.some((id) => id !== rights.userId) && !rights.canAssignOthers(item.teamId))
        ) {
          plan.skipped.push(item);
        } else plan.steps.push({ item, kind: 'update', request: { assigneeIds: next } });
        break;
      }
      case 'type': {
        // A plain type change (v1.3.1): checked against the item's parent and
        // children here, so the summary says why a row was left out.
        const type = value as ItemType;
        const parentType = item.ancestors[item.ancestors.length - 1]?.type ?? null;
        const children = rights.childTypes?.(item.id) ?? [];
        const misfit = children.find((child) => !isAllowedParent(child, type));
        if (item.type === type) plan.unchanged.push(item);
        else if (!item.can.plan) skip(item);
        else if (item.adHoc && !['TASK', 'BUG'].includes(type))
          skip(item, 'an ad-hoc item stays a Task or Bug');
        else if (parentType !== null && !isAllowedParent(type, parentType))
          skip(
            item,
            `it sits under a ${typeLabel(parentType)}, which cannot hold a ${typeLabel(type)}`,
          );
        else if (misfit !== undefined)
          skip(item, `a ${typeLabel(type)} cannot hold its ${typeLabel(misfit)} items`);
        else plan.steps.push({ item, kind: 'update', request: { type } });
        break;
      }
      case 'parent': {
        // Move under a new parent, changing the type when the old one is not
        // allowed there (the indent rule, v1.3.1); NONE moves to the top level.
        const parent = target === null ? null : rights.itemById?.(target);
        const fit =
          parent === undefined
            ? { error: 'the new parent is not visible' }
            : fitTypeUnder(item.type, parent?.type ?? null, rights.childTypes?.(item.id) ?? []);
        if (item.parentId === target) plan.unchanged.push(item);
        else if (!item.can.plan) skip(item);
        else if (item.adHoc && target !== null) skip(item, 'an ad-hoc item has no parent');
        else if (
          parent !== undefined &&
          parent !== null &&
          (parent.id === item.id || parent.ancestors.some((a) => a.id === item.id))
        )
          skip(item, 'an item cannot sit under itself or its own child');
        else if ('error' in fit) skip(item, fit.error.charAt(0).toLowerCase() + fit.error.slice(1));
        else
          plan.steps.push({
            item,
            kind: 'update',
            request:
              fit.type === item.type ? { parentId: target } : { parentId: target, type: fit.type },
          });
        break;
      }
    }
  }
  return plan;
}

/**
 * A type's name for the bulk summary.
 *
 * @param type Item type.
 * @returns E.g. "User Story".
 */
function typeLabel(type: ItemType): string {
  return TYPE_LABELS[type];
}

/**
 * Sends the planned requests one after another and collects the results.
 *
 * @param steps The planned requests.
 * @param send Sends one request and returns the updated item.
 * @returns Updated items and refusals.
 */
export async function runBulk(
  steps: BulkStep[],
  send: (step: BulkStep) => Promise<WorkItemDto>,
): Promise<BulkResult> {
  const result: BulkResult = { updated: [], failed: [] };
  for (const step of steps) {
    try {
      result.updated.push(await send(step));
    } catch (error) {
      result.failed.push({ item: step.item, message: errorMessage(error) });
    }
  }
  return result;
}

/** Sends the requests of a bulk Undo; each returns the item as the API answers. */
export interface BulkUndoApi {
  /** Moves an item back to its bucket. */
  move(item: WorkItemDto, request: MoveItemRequest): Promise<WorkItemDto>;
  /** Puts an item's fields back. */
  update(item: WorkItemDto, request: UpdateItemRequest): Promise<WorkItemDto>;
}

/**
 * Undoes a bulk edit (DESIGN §11, v1.4.0): every item the edit changed gets
 * exactly its previous values back, one ordinary request (or two) per item
 * like the edit itself. A card that changed bucket (a bucket edit, or a
 * status rule) moves back first; then the fields the edit altered are put
 * back, with the status again when the move ran a bucket entry rule. An item
 * the edit put onto the board (an Epic or Feature that became a Story, Task
 * or Bug) gets its type back first, since only then may it leave the board. Items
 * the edit skipped or that were refused are left alone, as are fields the
 * edit did not touch.
 *
 * @param before The items as they were before the edit, by id.
 * @param updated The items the edit changed, as the API returned them.
 * @param api Sends the requests.
 * @returns The items put back and those the API refused.
 */
export async function undoBulk(
  before: ReadonlyMap<string, WorkItemDto>,
  updated: readonly WorkItemDto[],
  api: BulkUndoApi,
): Promise<BulkResult> {
  const result: BulkResult = { updated: [], failed: [] };
  for (const after of updated) {
    const was = before.get(after.id);
    if (was === undefined) continue;
    try {
      let current = after;
      const move = was.bucketId === after.bucketId ? null : revertMove(was, after, undefined);
      if (move !== null && was.bucketId === null) {
        const fields = revertFields(was, after);
        if (fields !== null) current = await api.update(current, fields);
        current = await api.move(current, move);
      } else {
        if (move !== null) current = await api.move(current, move);
        const fields = undoFields(was, after, current);
        if (fields !== null) current = await api.update(current, fields);
      }
      result.updated.push(current);
    } catch (error) {
      result.failed.push({ item: after, message: errorMessage(error) });
    }
  }
  return result;
}

/**
 * Turns refusals of a bulk Undo into one error for the toast.
 *
 * @param result The Undo's result.
 * @throws Error naming each item that could not be put back.
 */
export function assertUndone(result: BulkResult): void {
  if (result.failed.length === 0) return;
  throw new Error(
    `Not put back: ${result.failed.map((f) => `${f.item.key} (${f.message})`).join('; ')}`,
  );
}
