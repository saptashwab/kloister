import type { MoveItemRequest, UpdateItemRequest, WorkItemDto } from '@kloister/shared';
import { errorMessage } from './api';
import { NONE } from './board-logic';

// Backlog bulk edits (SPEC §6: set sprint, bucket or assignee for many
// items). They run as one ordinary request per item (PATCH or move), so
// every item goes through exactly the same API checks as a single edit, and
// one refused item does not undo the others. Items whose capabilities rule
// the change out are skipped without a request; the API remains the
// authority for the rest.

/** What a bulk edit sets. */
export type BulkField = 'sprint' | 'bucket' | 'assignee';

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
}

/** The requests to send and the items left out. */
export interface BulkPlan {
  /** Requests, in selection order. */
  steps: BulkStep[];
  /** Items the caller may not change this way. */
  skipped: WorkItemDto[];
  /** Items that already have the value. */
  unchanged: WorkItemDto[];
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
 *   "unassigned".
 * @param rights What the caller may do.
 * @returns The requests to send and the items left out.
 */
export function planBulk(
  items: WorkItemDto[],
  field: BulkField,
  value: string,
  rights: BulkRights,
): BulkPlan {
  const plan: BulkPlan = { steps: [], skipped: [], unchanged: [] };
  const target = value === NONE ? null : value;
  for (const item of items) {
    switch (field) {
      case 'sprint':
        if (item.sprintId === target) plan.unchanged.push(item);
        else if (!item.can.edit) plan.skipped.push(item);
        else plan.steps.push({ item, kind: 'update', request: { sprintId: target } });
        break;
      case 'bucket':
        if (item.bucketId === target) plan.unchanged.push(item);
        else if (!item.can.move || target === null) plan.skipped.push(item);
        else plan.steps.push({ item, kind: 'move', request: { bucketId: target } });
        break;
      case 'assignee': {
        const next = target === null ? [] : [target];
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
    }
  }
  return plan;
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
