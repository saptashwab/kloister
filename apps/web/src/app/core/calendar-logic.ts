import {
  addDays,
  type ItemStatus,
  type ItemType,
  mondayOf,
  type ScheduleDates,
} from '@kloister/shared';

// Calendar layout (docs/M13-PLAN.md §4): month and week grids starting on
// Monday, items as spans from start to due in week rows (half days as half
// cells), lanes so spans never overlap, and the phone agenda by day.

/** An item placed on a calendar. */
export interface CalendarEntry extends ScheduleDates {
  /** Item id. */
  id: string;
  /** Display key. */
  key: string;
  /** Title. */
  title: string;
  /** Type. */
  type: ItemType;
  /** Status; Done items are dimmed. */
  status: ItemStatus;
  /** Ad hoc (M12): shown with its tag. */
  adHoc: boolean;
  /** Route that opens the item. */
  link: unknown[];
  /** The caller may move it (change its dates). */
  canMove: boolean;
  /** Who else is on it, e.g. "Ann is editing", or null. */
  presence: string | null;
  /** Project name on cross-project calendars, else null. */
  project: string | null;
}

/** A named range shaded or banded on the calendar: a holiday or a sprint. */
export interface CalendarRange {
  /** Name. */
  name: string;
  /** First day. */
  startDate: string;
  /** Last day. */
  endDate: string;
}

/** An item's piece within one week row. */
export interface WeekSegment {
  /** The item. */
  entry: CalendarEntry;
  /** First column, 0 (Monday) to 6. */
  start: number;
  /** Last column. */
  end: number;
  /** Starts in the 2nd half of its first day. */
  startHalf: boolean;
  /** Ends after the 1st half of its last day. */
  endHalf: boolean;
  /** Row within the week, from 0. */
  lane: number;
  /** The item started before this week. */
  before: boolean;
  /** The item goes on after this week. */
  after: boolean;
}

/** A band (sprint) within one week row. */
export interface WeekBand {
  /** Name. */
  name: string;
  /** First column. */
  start: number;
  /** Last column. */
  end: number;
}

/**
 * The first and last day an item covers: start to due, or its one date.
 *
 * @param dates The item's dates.
 * @returns The span, or null for undated items.
 */
export function entrySpan(dates: ScheduleDates): { first: string; last: string } | null {
  const first = dates.startDate ?? dates.dueDate;
  const last = dates.dueDate ?? dates.startDate;
  if (first === null || last === null) return null;
  return first <= last ? { first, last } : { first: last, last: first };
}

/**
 * The weeks a month view shows: Monday to Sunday rows from the week of the
 * 1st to the week of the last day.
 *
 * @param month Any day of the month, `YYYY-MM-DD`.
 * @returns The weeks' Mondays.
 */
export function monthWeeks(month: string): string[] {
  const first = `${month.slice(0, 7)}-01`;
  const next = addDays(first, 32).slice(0, 7);
  const last = addDays(`${next}-01`, -1);
  const weeks: string[] = [];
  for (let monday = mondayOf(first); monday <= last; monday = addDays(monday, 7))
    weeks.push(monday);
  return weeks;
}

/**
 * The seven days of a week.
 *
 * @param monday The week's Monday.
 * @returns Monday to Sunday.
 */
export function weekDays(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/**
 * Lays out the items of one week row: each item's piece in the week, in
 * lanes so that pieces never overlap. Longer and earlier pieces go first.
 *
 * @param entries The items.
 * @param monday The week's Monday.
 * @returns The pieces with their lanes.
 */
export function layoutWeek(entries: readonly CalendarEntry[], monday: string): WeekSegment[] {
  const sunday = addDays(monday, 6);
  const col = (date: string) => Math.round(dayDiff(monday, date));
  const pieces = entries.flatMap((entry) => {
    const span = entrySpan(entry);
    if (span === null || span.last < monday || span.first > sunday) return [];
    const before = span.first < monday;
    const after = span.last > sunday;
    const single = entry.startDate === null || entry.dueDate === null;
    return [
      {
        entry,
        start: before ? 0 : col(span.first),
        end: after ? 6 : col(span.last),
        startHalf: !before && !single && entry.startSecondHalf,
        endHalf: !after && entry.dueDate !== null && entry.dueFirstHalf,
        lane: 0,
        before,
        after,
      },
    ];
  });
  pieces.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const lanes: number[] = [];
  for (const piece of pieces) {
    let lane = lanes.findIndex((end) => end < piece.start);
    if (lane === -1) lane = lanes.length;
    lanes[lane] = piece.end;
    piece.lane = lane;
  }
  return pieces;
}

/**
 * The bands (sprints) of one week row.
 *
 * @param ranges The ranges.
 * @param monday The week's Monday.
 * @returns The bands that touch the week.
 */
export function weekBands(ranges: readonly CalendarRange[], monday: string): WeekBand[] {
  const sunday = addDays(monday, 6);
  return ranges
    .filter((r) => r.endDate >= monday && r.startDate <= sunday)
    .map((r) => ({
      name: r.name,
      start: r.startDate < monday ? 0 : Math.round(dayDiff(monday, r.startDate)),
      end: r.endDate > sunday ? 6 : Math.round(dayDiff(monday, r.endDate)),
    }));
}

/**
 * The holiday on a day, if any.
 *
 * @param ranges Holidays.
 * @param day `YYYY-MM-DD`.
 * @returns The holiday's name, or null.
 */
export function holidayOn(ranges: readonly CalendarRange[], day: string): string | null {
  return ranges.find((r) => r.startDate <= day && r.endDate >= day)?.name ?? null;
}

/**
 * The phone agenda: for each day of a range with items, the items it covers.
 *
 * @param entries The items.
 * @param from First day.
 * @param to Last day.
 * @returns Days in order, each with its items.
 */
export function agenda(
  entries: readonly CalendarEntry[],
  from: string,
  to: string,
): { day: string; entries: CalendarEntry[] }[] {
  const days: { day: string; entries: CalendarEntry[] }[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const covering = entries.filter((e) => {
      const span = entrySpan(e);
      return span !== null && span.first <= day && span.last >= day;
    });
    if (covering.length > 0) days.push({ day, entries: covering });
  }
  return days;
}

/**
 * Shifts an item's dates by calendar days, for the preview while it is moved.
 *
 * @param dates The item's dates.
 * @param days Days to shift.
 * @returns The shifted dates.
 */
export function shiftDates<T extends ScheduleDates>(dates: T, days: number): T {
  return {
    ...dates,
    startDate: dates.startDate === null ? null : addDays(dates.startDate, days),
    dueDate: dates.dueDate === null ? null : addDays(dates.dueDate, days),
  };
}

/**
 * The days between two dates.
 *
 * @param from Earlier date.
 * @param to Later date.
 * @returns Days from `from` to `to`; negative when `to` is earlier.
 */
export function dayDiff(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}
