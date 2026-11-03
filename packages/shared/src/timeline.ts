import type { ItemRefDto, WorkItemDto } from './items.js';
import {
  type HalfDay,
  type KeptReason,
  NO_HOLIDAYS,
  PinAction,
  type PlanChange,
  type PlanEdge,
  type PlanItem,
  planSchedule,
  type ScheduleDates,
  type WorkCalendar,
} from './schedule.js';

/** Response of `GET /projects/:id/timeline` (SPEC §6.4). */
export interface TimelineDto {
  /** "Blocked by" links whose both ends the caller can see. */
  edges: PlanEdge[];
}

/** How `POST /projects/:id/timeline/reschedule` treats the request. */
export const RescheduleMode = {
  /** Plan only; nothing changes. */
  PREVIEW: 'preview',
  /** Apply the requested changes and move dependent items. */
  APPLY: 'apply',
  /** Apply only the requested changes; nothing else moves. */
  ONLY: 'only',
} as const;

/** One of the {@link RescheduleMode} values. */
export type RescheduleMode = (typeof RescheduleMode)[keyof typeof RescheduleMode];

/** One requested change. Omitted date fields keep the item's current values. */
export interface RescheduleChangeRequest {
  /** Item uuid or per-project number. */
  item: string;
  /** New start date, or null. */
  startDate?: string | null;
  /** Starts in the 2nd half. */
  startSecondHalf?: boolean;
  /** New due date, or null. */
  dueDate?: string | null;
  /** Finishes after the 1st half. */
  dueFirstHalf?: boolean;
  /** Pin handling; default `auto`. */
  pin?: PinAction;
  /** An exact pin to restore (Undo); overrides `pin` when present. */
  pinTo?: HalfDay | null;
}

/** A dependent move the caller saw in the preview. */
export interface PreviewedChange {
  /** Item id. */
  id: string;
  /** Dates shown. */
  to: ScheduleDates;
}

/** Body of `POST /projects/:id/timeline/reschedule`. */
export interface RescheduleRequest {
  /** Changes asked for. */
  changes: RescheduleChangeRequest[];
  /** Preview, apply with dependent moves, or apply only the changes. */
  mode: RescheduleMode;
  /** Versions (`updatedAt`) the caller saw, by item id; a mismatch is 409. */
  expect?: Record<string, string>;
  /** The moves a preview showed; `apply` refuses with 409 when the plan differs. */
  previewed?: PreviewedChange[];
}

/** One item a reschedule changes. */
export interface RescheduleChangeDto {
  /** The item. */
  item: ItemRefDto;
  /** Dates before. */
  from: ScheduleDates;
  /** Dates after. */
  to: ScheduleDates;
  /** Pin before. */
  pinFrom: HalfDay | null;
  /** Pin after. */
  pinTo: HalfDay | null;
  /** True for a change the caller asked for. */
  requested: boolean;
  /** A requested start before the earliest allowed one was moved to it. */
  snapped: boolean;
  /** The item's version (`updatedAt`) before the change. */
  version: string;
}

/** A visible dependent item that stays where it is. */
export interface RescheduleKeptDto {
  /** The item. */
  item: ItemRefDto;
  /** Why it stays. */
  reason: KeptReason;
}

/** Response of `POST /projects/:id/timeline/reschedule`. */
export interface RescheduleResultDto {
  /** Every change, requested first. */
  changes: RescheduleChangeDto[];
  /** Dependent items that stay. */
  kept: RescheduleKeptDto[];
  /** The changed items after applying; empty for a preview. */
  items: WorkItemDto[];
  /** Shared by the audit entries of this reschedule; null for a preview. */
  rescheduleId: string | null;
}

/**
 * Turns a requested change into the planner's form, filling omitted date
 * fields from the item. A change naming no date field only reschedules the
 * item from its predecessors. The API and the web app's local preview
 * (v1.4.1) both use it, so they plan the same change.
 *
 * @param change The request.
 * @param id The item's id.
 * @param current The item's dates now.
 * @returns The plan change.
 */
export function toPlanChange(
  change: RescheduleChangeRequest,
  id: string,
  current: ScheduleDates,
): PlanChange {
  const touchesDates =
    change.startDate !== undefined ||
    change.startSecondHalf !== undefined ||
    change.dueDate !== undefined ||
    change.dueFirstHalf !== undefined;
  const startDate = change.startDate === undefined ? current.startDate : change.startDate;
  const dueDate = change.dueDate === undefined ? current.dueDate : change.dueDate;
  const dates: ScheduleDates = {
    startDate,
    startSecondHalf: startDate !== null && (change.startSecondHalf ?? current.startSecondHalf),
    dueDate,
    dueFirstHalf: dueDate !== null && (change.dueFirstHalf ?? current.dueFirstHalf),
  };
  const pin = change.pinTo !== undefined ? PinAction.KEEP : (change.pin ?? PinAction.AUTO);
  return { id, ...(touchesDates ? { dates } : {}), pin };
}

/** An item as a reschedule preview sees it: plan facts, reference and version. */
export interface PreviewItem extends PlanItem {
  /** The item's reference, for the dialog. */
  ref: ItemRefDto;
  /** Its version (`updatedAt`). */
  version: string;
}

/**
 * Plans a reschedule without saving it (v1.4.1): the same plan the API's
 * `preview` mode answers when given the same visible, non-ad-hoc items,
 * links and holidays. The web app uses it to open the confirmation at once;
 * the apply still sends what was shown, so the API checks it again.
 *
 * @param items Visible items on the timeline (ad-hoc items left out).
 * @param edges Links whose both ends are among them.
 * @param changes The requested changes, each naming an item by id.
 * @param cal The project's working-day calendar.
 * @returns The preview, or null when a requested item is not among the items.
 */
export function previewReschedule(
  items: readonly PreviewItem[],
  edges: readonly PlanEdge[],
  changes: readonly RescheduleChangeRequest[],
  cal: WorkCalendar = NO_HOLIDAYS,
): RescheduleResultDto | null {
  const byId = new Map(items.map((i) => [i.id, i]));
  const requested = changes.map((c) => byId.get(c.item));
  if (requested.some((i) => i === undefined)) return null;
  const plan = planSchedule(
    items,
    edges,
    changes.map((c, n) => toPlanChange(c, requested[n]!.id, requested[n]!)),
    cal,
  );
  return {
    changes: plan.changes.map((c) => {
      const item = byId.get(c.id)!;
      return {
        item: item.ref,
        from: c.from,
        to: c.to,
        pinFrom: c.pinFrom,
        pinTo: c.pinTo,
        requested: c.requested,
        snapped: c.snapped,
        version: item.version,
      };
    }),
    kept: plan.kept.map((k) => ({ item: byId.get(k.id)!.ref, reason: k.reason })),
    items: [],
    rescheduleId: null,
  };
}
