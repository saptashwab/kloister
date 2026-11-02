import type { ItemRefDto, WorkItemDto } from './items.js';
import type { HalfDay, KeptReason, PinAction, PlanEdge, ScheduleDates } from './schedule.js';

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
