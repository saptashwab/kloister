import {
  addDays,
  type AssigneeShareDto,
  type BurndownPointDto,
  endSlot,
  isHoliday,
  isWorkingDay,
  type ScheduleDates,
  SHARE_MAX,
  startSlot,
  type WorkCalendar,
  WORKLOAD_HIGH,
  WORKLOAD_OVER,
  type WorkloadCellDto,
  type WorkloadEntryDto,
  WorkloadLevel,
  type WorkloadWeekDto,
  workingDaysIn,
  workingDaysWithin,
  workingDuration,
} from '@kloister/shared';

/**
 * Pure report arithmetic (docs/M13-PLAN.md §3), kept apart from the database
 * so it can be tested directly. Every input is already limited to the items
 * the caller can see.
 */

/** An item as the workload sees it. */
export interface WorkloadItem extends ScheduleDates {
  /** Item id. */
  id: string;
  /** Assignees with shares; empty for unassigned work. */
  assignees: readonly AssigneeShareDto[];
}

/** One person's (or the unassigned work's) planned weeks. */
export interface WorkloadLine {
  /** User id, or null for unassigned work. */
  userId: string | null;
  /** Per week: the item ids with their days and shares. */
  weeks: { itemId: string; days: number; share: number }[][];
}

/**
 * Builds the weeks of a workload report.
 *
 * @param monday The first week's Monday.
 * @param count Number of weeks.
 * @param cal The project's working calendar.
 * @returns The weeks with their available working days.
 */
export function workloadWeeks(monday: string, count: number, cal: WorkCalendar): WorkloadWeekDto[] {
  return Array.from({ length: count }, (_, i) => {
    const start = addDays(monday, i * 7);
    const end = addDays(start, 6);
    return { start, end, available: workingDaysIn(start, end, cal) };
  });
}

/**
 * Spreads dated items over people and weeks (M13): each item's working days in
 * a week, times each assignee's share. Unassigned items go to the line with a
 * null user id at 100%. The caller passes only dated, unfinished items that are
 * part of the plan.
 *
 * @param items The items.
 * @param weeks The weeks.
 * @param cal The project's working calendar.
 * @returns One line per person with planned work, then unassigned work.
 */
export function spreadWorkload(
  items: readonly WorkloadItem[],
  weeks: readonly WorkloadWeekDto[],
  cal: WorkCalendar,
): WorkloadLine[] {
  const lines = new Map<string | null, WorkloadLine>();
  const line = (userId: string | null): WorkloadLine => {
    let found = lines.get(userId);
    if (found === undefined) {
      found = { userId, weeks: weeks.map(() => []) };
      lines.set(userId, found);
    }
    return found;
  };
  for (const item of items) {
    weeks.forEach((week, w) => {
      const days = workingDaysWithin(item, week.start, week.end, cal);
      if (days === 0) return;
      const people =
        item.assignees.length === 0 ? [{ userId: null, share: SHARE_MAX }] : item.assignees;
      for (const person of people)
        line(person.userId).weeks[w]?.push({ itemId: item.id, days, share: person.share });
    });
  }
  const unassigned = lines.get(null);
  lines.delete(null);
  return [...lines.values(), ...(unassigned === undefined ? [] : [unassigned])];
}

/**
 * How loaded a week is (owner decision M13: amber from 80%, red above 100%).
 *
 * @param planned Planned working days.
 * @param available Available working days.
 * @returns The load (null when nothing is available) and its level.
 */
export function loadLevel(
  planned: number,
  available: number,
): { load: number | null; level: WorkloadLevel } {
  if (available <= 0) return { load: null, level: WorkloadLevel.NONE };
  const load = planned / available;
  const level =
    planned === 0
      ? WorkloadLevel.NONE
      : load > WORKLOAD_OVER
        ? WorkloadLevel.OVER
        : load >= WORKLOAD_HIGH
          ? WorkloadLevel.HIGH
          : WorkloadLevel.OK;
  return { load: round(load), level };
}

/**
 * Turns one week of a line into a report cell.
 *
 * @param parts The week's items with days and shares.
 * @param available The week's working days.
 * @param entry Builds the entry for an item id (its report item).
 * @returns The cell.
 */
export function workloadCell(
  parts: readonly { itemId: string; days: number; share: number }[],
  available: number,
  entry: (part: { itemId: string; days: number; share: number }) => WorkloadEntryDto,
): WorkloadCellDto {
  const planned = round(parts.reduce((sum, p) => sum + (p.days * p.share) / 100, 0));
  return { planned, ...loadLevel(planned, available), entries: parts.map(entry) };
}

/** One sprint change of an item, from its history. */
export interface SprintMove {
  /** When. */
  at: Date;
  /** Sprint before, or null. */
  from: string | null;
  /** Sprint after, or null. */
  to: string | null;
}

/** An item as the sprint report sees it. */
export interface SprintItem extends ScheduleDates {
  /** Item id. */
  id: string;
  /** Sprint now. */
  sprintId: string | null;
  /** Created. */
  createdAt: Date;
  /** Finished, or null. */
  completedAt: Date | null;
  /** Its sprint changes, oldest first. */
  moves: readonly SprintMove[];
}

/**
 * The item's sprint at a moment, worked back from its current sprint through
 * the later changes in its history.
 *
 * @param item The item.
 * @param at The moment.
 * @returns The sprint id then, or null.
 */
export function sprintAt(item: SprintItem, at: Date): string | null {
  let sprint = item.sprintId;
  for (let i = item.moves.length - 1; i >= 0; i--) {
    const move = item.moves[i];
    if (move.at <= at) break;
    sprint = move.from;
  }
  return sprint;
}

/**
 * When an item joined and left a sprint after it started (M13): from its
 * history, not its creation date, so an item planned before the start and
 * created earlier is not an addition. An item created in the sprint after the
 * start is one.
 *
 * @param item The item.
 * @param sprintId The sprint.
 * @param startedAt When the sprint started.
 * @returns The last addition and removal after the start, if any.
 */
export function sprintChanges(
  item: SprintItem,
  sprintId: string,
  startedAt: Date,
): { added: Date | null; removed: Date | null } {
  let added: Date | null = null;
  let removed: Date | null = null;
  for (const move of item.moves) {
    if (move.at <= startedAt) continue;
    if (move.to === sprintId) added = move.at;
    if (move.from === sprintId) removed = move.at;
  }
  if (added === null && item.createdAt > startedAt && sprintAt(item, item.createdAt) === sprintId)
    added = item.createdAt;
  return { added, removed };
}

/**
 * The working days of a sprint (weekends and holidays left out).
 *
 * @param start First day.
 * @param end Last day.
 * @param cal The project's working calendar.
 * @returns The working days in order.
 */
export function sprintWorkingDays(start: string, end: string, cal: WorkCalendar): string[] {
  const days: string[] = [];
  for (let day = start; day <= end; day = addDays(day, 1))
    if (isWorkingDay(day) && !isHoliday(day, cal)) days.push(day);
  return days;
}

/**
 * The burndown of a sprint: for each working day up to today, the working
 * days of the items that were in the sprint at the end of that day and not yet
 * finished; days to come have none. The ideal line runs from the first day's
 * total to zero on the last day.
 *
 * @param items Visible items that were in the sprint at some point.
 * @param sprintId The sprint.
 * @param days The sprint's working days.
 * @param today Today, `YYYY-MM-DD`.
 * @param cal The project's working calendar.
 * @returns One point per working day.
 */
export function burndown(
  items: readonly SprintItem[],
  sprintId: string,
  days: readonly string[],
  today: string,
  cal: WorkCalendar,
): BurndownPointDto[] {
  const remaining = days.map((day) => {
    if (day > today) return null;
    const end = new Date(`${addDays(day, 1)}T00:00:00.000Z`);
    let sum = 0;
    for (const item of items) {
      if (item.createdAt >= end || sprintAt(item, end) !== sprintId) continue;
      if (item.completedAt !== null && item.completedAt < end) continue;
      sum += workingDuration(item, cal);
    }
    return sum;
  });
  const first = remaining[0] ?? items.reduce((s, i) => s + workingDuration(i, cal), 0);
  const steps = Math.max(1, days.length - 1);
  return days.map((date, i) => ({
    date,
    remaining: remaining[i] ?? null,
    ideal: round(days.length === 1 ? first : first * (1 - i / steps)),
  }));
}

/**
 * Reports whether an item starts before a predecessor finishes, as the
 * timeline marks it (docs/M9-PLAN.md §3.3).
 *
 * @param item The successor.
 * @param pred The predecessor.
 * @param cal The project's working calendar.
 * @returns True on a conflict.
 */
export function startsBeforePredecessor(
  item: ScheduleDates,
  pred: ScheduleDates,
  cal: WorkCalendar,
): boolean {
  if (pred.dueDate === null) return false;
  const begin =
    item.startDate !== null
      ? startSlot(item.startDate, item.startSecondHalf, cal)
      : item.dueDate !== null
        ? endSlot(item.dueDate, item.dueFirstHalf, cal)
        : null;
  return begin !== null && begin <= endSlot(pred.dueDate, pred.dueFirstHalf, cal);
}

/**
 * Rounds to two decimals for display.
 *
 * @param n A number.
 * @returns The rounded number.
 */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
