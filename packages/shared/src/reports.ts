import type { HalfDay } from './schedule.js';
import type { ItemRefDto, ItemStatus, SprintDto } from './items.js';

/**
 * Project reports (SPEC §6.5, docs/M13-PLAN.md §3): Overview, Sprint,
 * Workload and Plan health, computed by the API from the items the caller can
 * see. Hidden items are never counted, listed or hinted at.
 */

/** Load from which a workload cell is shown amber (owner decision, M13). */
export const WORKLOAD_HIGH = 0.8;

/** Load above which a workload cell is shown red, "overallocated" (owner decision, M13). */
export const WORKLOAD_OVER = 1;

/** Weeks a workload report covers by default. */
export const WORKLOAD_WEEKS_DEFAULT = 8;

/** Most weeks one workload report covers. */
export const WORKLOAD_WEEKS_MAX = 26;

/** Days counted as "recently done" on the Overview. */
export const RECENT_DONE_DAYS = 14;

/** How loaded a person is in a week. */
export const WorkloadLevel = {
  /** Nothing available that week (holidays only), or nothing planned. */
  NONE: 'none',
  /** Under 80%. */
  OK: 'ok',
  /** From 80% to 100%. */
  HIGH: 'high',
  /** Above 100%. */
  OVER: 'over',
} as const;

/** One of the {@link WorkloadLevel} values. */
export type WorkloadLevel = (typeof WorkloadLevel)[keyof typeof WorkloadLevel];

/** A visible item listed in a report. */
export interface ReportItemDto extends ItemRefDto {
  /** Status. */
  status: ItemStatus;
  /** `YYYY-MM-DD`, or null. */
  startDate: string | null;
  /** `YYYY-MM-DD`, or null. */
  dueDate: string | null;
  /** Assignee user ids. */
  assigneeIds: string[];
}

/** Open items in one bucket. */
export interface ReportBucketCountDto {
  /** Bucket id, or null for Epics and Features off the board. */
  bucketId: string | null;
  /** Bucket name, or "Off the board". */
  name: string;
  /** Open (not Done) visible items in it. */
  count: number;
}

/** Answer of `GET /projects/:id/reports/overview`. */
export interface OverviewReportDto {
  /** The day the report was computed for, server time (`YYYY-MM-DD`). */
  today: string;
  /** Monday of this week. */
  weekStart: string;
  /** Sunday of this week. */
  weekEnd: string;
  /** Visible items. */
  total: number;
  /** Visible items per status. */
  byStatus: Record<ItemStatus, number>;
  /** Unfinished items past their due date (and time). */
  overdue: number;
  /** Unfinished items due from today to Sunday, not yet overdue. */
  dueThisWeek: number;
  /** Items finished in the last 14 days. */
  doneRecently: number;
  /** Open items per bucket, in board order. */
  openByBucket: ReportBucketCountDto[];
  /** Open ad-hoc items. */
  adHocOpen: number;
}

/** An item that joined or left a sprint after it started. */
export interface SprintChangeDto {
  /** The item. */
  item: ReportItemDto;
  /** ISO timestamp of the change. */
  at: string;
}

/** One day of a sprint burndown. */
export interface BurndownPointDto {
  /** `YYYY-MM-DD`, a working day of the sprint. */
  date: string;
  /** Working days of unfinished items in the sprint at the end of that day; null for days to come. */
  remaining: number | null;
  /** The straight line from the first day's total to zero. */
  ideal: number;
}

/** Answer of `GET /projects/:id/reports/sprint`. */
export interface SprintReportDto {
  /** The sprint shown: the chosen one, else the active one; null when there is none. */
  sprint: SprintDto | null;
  /** When additions start counting: the sprint's start, or its first day. */
  startedAt: string | null;
  /** Visible items in the sprint now, by done and not done. */
  items: { done: number; remaining: number };
  /** Working days of those items, by done and not done. */
  days: { done: number; remaining: number };
  /** Working days of the sprint, and how many of them have passed. */
  sprintDays: { total: number; elapsed: number };
  /** Remaining working days per working day of the sprint. */
  burndown: BurndownPointDto[];
  /** Items that joined after the start, from item history. */
  added: SprintChangeDto[];
  /** Items that left after the start, from item history. */
  removed: SprintChangeDto[];
  /** Unfinished items due after the sprint ends. */
  atRisk: ReportItemDto[];
}

/** One week of a workload report. */
export interface WorkloadWeekDto {
  /** Monday, `YYYY-MM-DD`. */
  start: string;
  /** Sunday, `YYYY-MM-DD`. */
  end: string;
  /** Working days that week (holidays excluded). */
  available: number;
}

/** One item's part of a workload cell. */
export interface WorkloadEntryDto {
  /** The item. */
  item: ReportItemDto;
  /** The item's working days in that week (half days count 0.5). */
  days: number;
  /** The person's share in percent (100 for unassigned work). */
  share: number;
}

/** A person's (or the unassigned work's) week. */
export interface WorkloadCellDto {
  /** Planned working days: each item's days that week times the share. */
  planned: number;
  /** Planned ÷ available, or null when nothing is available that week. */
  load: number | null;
  /** How loaded. */
  level: WorkloadLevel;
  /** The items behind the number. */
  entries: WorkloadEntryDto[];
}

/** One row of a workload report. */
export interface WorkloadRowDto {
  /** The person, or null for planned work nobody is assigned to. */
  userId: string | null;
  /** One cell per week, in the order of `weeks`. */
  cells: WorkloadCellDto[];
}

/** Answer of `GET /projects/:id/reports/workload`. */
export interface WorkloadReportDto {
  /** The weeks, from the week of `from`. */
  weeks: WorkloadWeekDto[];
  /** Active members (and anyone else with planned work), then unassigned work. */
  rows: WorkloadRowDto[];
}

/** An item that starts before its predecessors finish. */
export interface PlanConflictDto {
  /** The item. */
  item: ReportItemDto;
  /** Its visible predecessors that finish too late. */
  predecessors: ReportItemDto[];
}

/** An item whose pin holds it later than its predecessors require. */
export interface PinnedLateDto {
  /** The item. */
  item: ReportItemDto;
  /** The pin ("start no earlier than"). */
  pin: HalfDay;
  /** The earliest start its visible predecessors allow. */
  earliest: HalfDay;
}

/** Answer of `GET /projects/:id/reports/plan-health`. */
export interface PlanHealthReportDto {
  /** Unfinished items past their due date. */
  pastDue: ReportItemDto[];
  /** Items starting before their predecessors finish. */
  conflicts: PlanConflictDto[];
  /** The active sprint, or null. */
  sprint: SprintDto | null;
  /** Stories and Tasks without dates in the active sprint. */
  undatedInSprint: ReportItemDto[];
  /** Items held later by their pin than their predecessors require. */
  pinnedLate: PinnedLateDto[];
}

/** A work item placed on the My work calendar (M13). */
export interface CalendarItemDto {
  /** Item id. */
  id: string;
  /** Per-project number. */
  number: number;
  /** Display key. */
  key: string;
  /** Project id. */
  projectId: string;
  /** Item type. */
  type: ItemRefDto['type'];
  /** Title. */
  title: string;
  /** Status. */
  status: ItemStatus;
  /** `YYYY-MM-DD`, or null. */
  startDate: string | null;
  /** Starts in the 2nd half. */
  startSecondHalf: boolean;
  /** `YYYY-MM-DD`, or null. */
  dueDate: string | null;
  /** Finishes after the 1st half. */
  dueFirstHalf: boolean;
  /** Ad hoc (M12). */
  adHoc: boolean;
  /** Assignee user ids. */
  assigneeIds: string[];
  /** Label ids of the item's project. */
  labelIds: string[];
  /** The item's version, for the reschedule check. */
  updatedAt: string;
  /** The caller may change its dates. */
  canPlan: boolean;
}

/** A project (or the personal space) with items on the My work calendar. */
export interface CalendarProjectDto {
  /** Project id. */
  id: string;
  /** Key, or null for the personal space. */
  key: string | null;
  /** Name. */
  name: string;
  /** Dependent items move without asking (M9). */
  autoMoveDependents: boolean;
  /** The project's calendar includes the instance holidays (M9.1). */
  useInstanceHolidays: boolean;
  /** The caller may switch automatic moving on (PMs). */
  canSwitch: boolean;
}

/** A holiday shaded on the My work calendar. */
export interface CalendarHolidayDto {
  /** The project it belongs to, or null for an instance holiday. */
  projectId: string | null;
  /** Name. */
  name: string;
  /** First day. */
  startDate: string;
  /** Last day. */
  endDate: string;
}

/** Answer of `GET /me/calendar`. */
export interface MyCalendarDto {
  /** First day asked for. */
  from: string;
  /** Last day asked for. */
  to: string;
  /** Dated items assigned to the caller (and personal tasks) that touch the range. */
  items: CalendarItemDto[];
  /** Open undated items assigned to the caller, for "Not on the calendar" (at most 200). */
  undated: CalendarItemDto[];
  /** The projects of the listed items. */
  projects: CalendarProjectDto[];
  /** Every active instance holiday and the listed projects' own holidays. */
  holidays: CalendarHolidayDto[];
}

/** Most days one `GET /me/calendar` request covers. */
export const CALENDAR_RANGE_MAX_DAYS = 100;
