import {
  type HalfDay,
  type ItemStatus,
  type ItemType,
  scheduleSpan,
  type ScheduleDates,
  workingDuration,
} from '@kloister/shared';
import type { SnapshotLayout } from './snapshot-format.js';

/** Most week columns on the Timeline sheet (docs/M9-PLAN.md §6). */
export const TIMELINE_SHEET_MAX_WEEKS = 156;

/** One readable item as the Timeline sheet needs it. */
export interface TimelineSheetItem extends ScheduleDates {
  /** Item id. */
  id: string;
  /** Parent id, or null. */
  parentId: string | null;
  /** Per-project number, for sibling order. */
  number: number;
  /** Display key. */
  key: string;
  /** Title. */
  title: string;
  /** Type. */
  type: ItemType;
  /** Status. */
  status: ItemStatus;
  /** Assignee names, one per line. */
  assignees: string;
  /** Sprint name, or empty. */
  sprint: string;
  /** "Start no earlier than" pin, or null. */
  pin: HalfDay | null;
  /** Keys of the readable predecessors. */
  predecessors: string[];
}

/** A sprint for the sprint row. */
export interface TimelineSheetSprint {
  /** Name. */
  name: string;
  /** `YYYY-MM-DD`. */
  startDate: string;
  /** `YYYY-MM-DD`. */
  endDate: string;
}

/** The Timeline sheet's table plus a note for the Summary sheet. */
export interface TimelineSheet {
  /** Column headers. */
  headers: string[];
  /** Data rows. */
  rows: string[][];
  /** Outline, fills and widths. */
  layout: SnapshotLayout;
  /** Set when the week range was capped. */
  note: string | null;
}

/** Light fills per item type, readable with black text. */
const TYPE_FILL: Record<ItemType, string> = {
  EPIC: 'DDD0FB',
  FEATURE: 'CFE0FD',
  STORY: 'CDEFD9',
  TASK: 'C8EBF3',
  BUG: 'F9CFCF',
};

/** Fill of summary spans and done items. */
const SUMMARY_FILL = '9AA0A6';
const DONE_FILL = 'E3E6EC';
const PLAN_FILL = 'EEF0FF';

/** Status shown as text in the first filled week, so it is not colour-only. */
const STATUS_MARK: Record<ItemStatus, string> = {
  NOT_STARTED: '○',
  IN_PROGRESS: '▶',
  BLOCKED: '⏸',
  DONE: '✓',
};

/** Columns before the weeks. */
const FIXED_HEADERS = [
  'Item',
  'Title',
  'Type',
  'Assignees',
  'Status',
  'Start',
  'Days',
  'Due',
  'Work (days)',
  'Half days',
  'Start no earlier than',
  'Predecessors',
  'Sprint',
];
const FIXED_WIDTHS = [12, 44, 10, 22, 12, 12, 7, 12, 9, 24, 14, 16, 14];

/**
 * Builds the Timeline sheet (docs/M9-PLAN.md §6): the items in hierarchy
 * order with Excel outline levels, summary spans for parents, a plan row and
 * a sprint row, then one column per week filled for each item's dates. Only
 * the items passed in appear, so the caller passes readable items only.
 *
 * @param items Readable items.
 * @param sprints The project's sprints.
 * @param today `YYYY-MM-DD`, marked in the week headers.
 * @returns The sheet.
 */
export function timelineSheet(
  items: readonly TimelineSheetItem[],
  sprints: readonly TimelineSheetSprint[],
  today: string,
): TimelineSheet {
  const ids = new Set(items.map((i) => i.id));
  const children = new Map<string | null, TimelineSheetItem[]>();
  for (const item of items) {
    const parent = item.parentId !== null && ids.has(item.parentId) ? item.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), item]);
  }
  for (const list of children.values()) list.sort((a, b) => a.number - b.number);

  const ordered: { item: TimelineSheetItem; depth: number }[] = [];
  const visit = (parent: string | null, depth: number): void => {
    for (const item of children.get(parent) ?? []) {
      ordered.push({ item, depth });
      visit(item.id, depth + 1);
    }
  };
  visit(null, 0);

  const leavesUnder = (id: string): TimelineSheetItem[] =>
    (children.get(id) ?? []).flatMap((c) => (children.has(c.id) ? leavesUnder(c.id) : [c]));
  const rows = ordered.map(({ item, depth }) => {
    const summary = children.has(item.id) ? scheduleSpan(leavesUnder(item.id)) : null;
    return { item, depth, summary };
  });

  const plan = scheduleSpan(items.filter((i) => !children.has(i.id)));
  const firstDay = plan === null ? null : mondayOf(plan.start.date);
  const lastDay = plan === null ? null : mondayOf(plan.finish.dueDate);
  const totalWeeks =
    firstDay === null || lastDay === null ? 0 : Math.round((lastDay - firstDay) / 7) + 1;
  const weeks = Math.min(totalWeeks, TIMELINE_SHEET_MAX_WEEKS);
  const weekStarts = Array.from({ length: weeks }, (_, w) => (firstDay ?? 0) + w * 7);
  const todayDay = dayNumber(today);
  const note =
    totalWeeks > weeks
      ? `The Timeline sheet shows ${weeks} weeks from ${dateOf(weekStarts[0])}; the ${totalWeeks - weeks} later weeks to ${plan!.finish.dueDate} are not drawn (limit of ${TIMELINE_SHEET_MAX_WEEKS} weeks).`
      : null;

  const headers = [
    ...FIXED_HEADERS,
    ...weekStarts.map((d) => `${dateOf(d)}${todayDay >= d && todayDay < d + 7 ? ' (today)' : ''}`),
  ];
  const blankWeeks = weekStarts.map(() => '');
  const planRow = [
    'Plan',
    plan === null
      ? 'No dated items'
      : `${plan.start.date} – ${plan.finish.dueDate} · ${plan.duration} working days · ${plan.work} days of work${note === null ? '' : ` · ${note}`}`,
    ...FIXED_HEADERS.slice(2).map(() => ''),
    ...blankWeeks,
  ];
  const sprintRow = [
    'Sprints',
    'Sprints overlapping each week',
    ...FIXED_HEADERS.slice(2).map(() => ''),
    ...weekStarts.map((d) =>
      sprints
        .filter((s) => dayNumber(s.startDate) <= d + 6 && dayNumber(s.endDate) >= d)
        .map((s) => s.name)
        .join('\n'),
    ),
  ];

  const dataRows: string[][] = [planRow, sprintRow];
  const fills: (string | null)[][] = [
    [...FIXED_HEADERS.map(() => PLAN_FILL), ...weekStarts.map(() => PLAN_FILL)],
    [],
  ];
  const outlineLevels = [0, 0];
  const boldRows = [0];
  for (const { item, depth, summary } of rows) {
    const own = {
      start: item.startDate,
      due: item.dueDate,
      days: workingDuration(item),
    };
    const shown =
      summary === null
        ? own
        : { start: summary.start.date, due: summary.finish.dueDate, days: summary.duration };
    const span = summary === null ? ownSpan(item) : summarySpan(summary);
    let marked = false;
    const fill =
      summary !== null ? SUMMARY_FILL : item.status === 'DONE' ? DONE_FILL : TYPE_FILL[item.type];
    const weekCells = weekStarts.map((d) => {
      const covered = span !== null && span.first <= d + 6 && span.last >= d;
      if (!covered || summary !== null || marked) return '';
      marked = true;
      return STATUS_MARK[item.status];
    });
    if (summary !== null) boldRows.push(dataRows.length);
    dataRows.push([
      item.key,
      `${'  '.repeat(depth)}${item.title}`,
      item.type,
      item.assignees,
      item.status,
      shown.start ?? '',
      shown.start !== null && shown.due !== null ? String(shown.days) : '',
      shown.due ?? '',
      summary === null ? (own.days > 0 ? String(own.days) : '') : String(summary.work),
      summary === null ? halves(item) : '',
      item.pin === null ? '' : `${item.pin.date}${item.pin.second ? ' (2nd half)' : ''}`,
      item.predecessors.join(', '),
      item.sprint,
      ...weekCells,
    ]);
    fills.push([
      ...FIXED_HEADERS.map(() => null),
      ...weekStarts.map((d) =>
        span !== null && span.first <= d + 6 && span.last >= d ? fill : null,
      ),
    ]);
    outlineLevels.push(depth);
  }
  return {
    headers,
    rows: dataRows,
    layout: {
      outlineLevels,
      fills,
      boldRows,
      widths: [...FIXED_WIDTHS, ...weekStarts.map(() => 11)],
      frozenColumns: 2,
    },
    note,
  };
}

/**
 * Words for an item's non-default halves.
 *
 * @param item The item.
 * @returns E.g. "starts 2nd half, ends 1st half", or empty.
 */
function halves(item: ScheduleDates): string {
  const parts = [
    item.startDate !== null && item.startSecondHalf ? 'starts 2nd half' : null,
    item.dueDate !== null && item.dueFirstHalf ? 'ends 1st half' : null,
  ].filter((p) => p !== null);
  return parts.join(', ');
}

/**
 * The calendar days an item covers; a one-date item covers that day.
 *
 * @param item The item.
 * @returns First and last day numbers, or null without dates.
 */
function ownSpan(item: ScheduleDates): { first: number; last: number } | null {
  const start = item.startDate ?? item.dueDate;
  const due = item.dueDate ?? item.startDate;
  if (start === null || due === null) return null;
  return { first: dayNumber(start), last: dayNumber(due) };
}

/**
 * The calendar days a summary span covers.
 *
 * @param span The span.
 * @param span.start Its first half day.
 * @param span.finish Its finish.
 * @param span.finish.dueDate Its last day.
 * @returns First and last day numbers.
 */
function summarySpan(span: { start: HalfDay; finish: { dueDate: string } }): {
  first: number;
  last: number;
} {
  return { first: dayNumber(span.start.date), last: dayNumber(span.finish.dueDate) };
}

/**
 * Day number of a date.
 *
 * @param date `YYYY-MM-DD`.
 * @returns Days since 1970-01-01.
 */
function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

/**
 * Date of a day number.
 *
 * @param day Days since 1970-01-01.
 * @returns `YYYY-MM-DD`.
 */
function dateOf(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The Monday of a date's week.
 *
 * @param date `YYYY-MM-DD`.
 * @returns Day number of that Monday.
 */
function mondayOf(date: string): number {
  const day = dayNumber(date);
  // 1970-01-05 (day 4) was a Monday.
  return day - ((((day - 4) % 7) + 7) % 7);
}
