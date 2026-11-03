import {
  endSlot,
  compareOutline,
  fitTypeUnder,
  type ItemRefDto,
  isAllowedParent,
  ItemType,
  type OutlineMoveRequest,
  type PlanEdge,
  type ScheduleDates,
  scheduleSpan,
  type ScheduleSpan,
  startSlot,
  type WorkItemDto,
  NO_HOLIDAYS,
  type RescheduleChangeRequest,
  slotHalfDay,
  finishAfter,
  type WorkCalendar,
  workingDuration,
} from '@kloister/shared';
import { flattenTree, type TreeNode } from './board-logic';
import { parseDay } from './format';

// Pure logic of the project timeline (SPEC §6.4, docs/M9-PLAN.md §3):
// rows with summary spans, typed dates and durations, the bar scale and
// geometry, conflicts, indenting and pasted rows. The page renders it.

/** Zoom levels of the bar area. */
export type TimelineZoom = 'week' | 'month' | 'quarter';

/** Pixels per calendar day at each zoom. */
export const DAY_WIDTH: Record<TimelineZoom, number> = { week: 22, month: 7, quarter: 2.4 };

/** One rendered row. */
export interface TimelineRow {
  /** Tree node (item, or a title-only ancestor). */
  node: TreeNode;
  /** Nesting depth, 0 for roots. */
  depth: number;
  /** Span of the visible dated descendants, for rows with children. */
  summary: ScheduleSpan | null;
}

/** Month abbreviations, as in `formatDay`. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Flattens the tree into rows and works out each parent's summary span from
 * its visible dated descendants without children (docs/M9-PLAN.md §3.2.1).
 *
 * @param roots Tree roots.
 * @param collapsed Ids of collapsed rows.
 * @param cal Holidays (M9.1); none by default.
 * @returns Rows in display order.
 */
export function timelineRows(
  roots: TreeNode[],
  collapsed: ReadonlySet<string>,
  cal: WorkCalendar = NO_HOLIDAYS,
): TimelineRow[] {
  const spans = new Map<string, ScheduleSpan | null>();
  const leaves = (node: TreeNode): ScheduleDates[] =>
    node.children.flatMap((c) =>
      c.children.length > 0 ? leaves(c) : c.item === null ? [] : [c.item],
    );
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      if (node.children.length > 0) spans.set(node.id, scheduleSpan(leaves(node), cal));
      walk(node.children);
    }
  };
  walk(roots);
  return flattenTree(roots, collapsed).map(({ node, depth }) => ({
    node,
    depth,
    summary: spans.get(node.id) ?? null,
  }));
}

/**
 * The span of the whole plan: every visible dated item without visible
 * children.
 *
 * @param items Visible items.
 * @param cal Holidays (M9.1); none by default.
 * @returns The span, or null without dates.
 */
export function planSpan(
  items: readonly WorkItemDto[],
  cal: WorkCalendar = NO_HOLIDAYS,
): ScheduleSpan | null {
  const parents = new Set(items.map((i) => i.parentId).filter((id) => id !== null));
  return scheduleSpan(
    items.filter((i) => !parents.has(i.id)),
    cal,
  );
}

/**
 * A short date for grid cells: "5 Nov", with the year when it is not the
 * current one.
 *
 * @param date `YYYY-MM-DD`.
 * @param today `YYYY-MM-DD`.
 * @returns The text.
 */
export function shortDay(date: string, today: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const base = `${d} ${MONTHS[m - 1]}`;
  return date.slice(0, 4) === today.slice(0, 4) ? base : `${base} ${y}`;
}

/**
 * A start as the grid shows it: the date, plus ", 2nd half" when it starts
 * in the 2nd half.
 *
 * @param dates The item's dates.
 * @param today `YYYY-MM-DD`.
 * @returns The text, or empty without a start.
 */
export function startText(dates: ScheduleDates, today: string): string {
  if (dates.startDate === null) return '';
  return `${shortDay(dates.startDate, today)}${dates.startSecondHalf ? ', 2nd half' : ''}`;
}

/**
 * A due date as the grid shows it: the date, plus ", 1st half" when it
 * finishes after the 1st half.
 *
 * @param dates The item's dates.
 * @param today `YYYY-MM-DD`.
 * @returns The text, or empty without a due date.
 */
export function dueText(dates: ScheduleDates, today: string): string {
  if (dates.dueDate === null) return '';
  return `${shortDay(dates.dueDate, today)}${dates.dueFirstHalf ? ', 1st half' : ''}`;
}

/**
 * Reads a typed date with an optional half: any `parseDay` format, or a day
 * and month without the year ("5 Nov", this year), optionally followed by
 * "1st", "2nd", "1st half", "2nd half", "H1" or "H2".
 *
 * @param text What the person typed.
 * @param today `YYYY-MM-DD`, for the year.
 * @returns The date and the half (1, 2, or null when not given), or null.
 */
export function parseHalfDay(
  text: string,
  today: string,
): { date: string; half: 1 | 2 | null } | null {
  let value = text.trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
  let half: 1 | 2 | null = null;
  const suffix = /\s*(?:(1st|2nd)(?:\s*half)?|h([12]))$/i.exec(value);
  if (suffix !== null) {
    half = (suffix[1] ?? suffix[2] ?? '').startsWith('1') ? 1 : 2;
    value = value.slice(0, suffix.index).trim();
  }
  const date =
    parseDay(value) ??
    (/^\d{1,2}\s+[A-Za-z]{3,}\.?$/.test(value) ? parseDay(`${value} ${today.slice(0, 4)}`) : null);
  return date === null ? null : { date, half };
}

/**
 * A duration as the grid shows it: "4", "2.5".
 *
 * @param days Working days.
 * @returns The text.
 */
export function durationText(days: number): string {
  return Number.isInteger(days) ? String(days) : days.toFixed(1);
}

/**
 * Reads a typed duration in working days: at least 0.5, in halves ("2,5" too).
 *
 * @param text What the person typed.
 * @returns Working days, or null when invalid.
 */
export function parseDuration(text: string): number | null {
  const value = Number(
    text
      .trim()
      .replace(/\s*d(ays?)?$/i, '')
      .replace(',', '.'),
  );
  return Number.isFinite(value) && value >= 0.5 && Number.isInteger(value * 2) ? value : null;
}

/** The horizontal scale of the bar area. */
export interface TimelineScale {
  /** Day number (days since 1970-01-01) of the first column, a Monday. */
  origin: number;
  /** Number of days drawn. */
  days: number;
  /** Pixels per day. */
  dayWidth: number;
}

/**
 * Day number of a date.
 *
 * @param date `YYYY-MM-DD`.
 * @returns Days since 1970-01-01.
 */
export function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

/**
 * Date of a day number.
 *
 * @param day Days since 1970-01-01.
 * @returns `YYYY-MM-DD`.
 */
export function dateOfDay(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Day of the week of a day number, Monday first.
 *
 * @param day Days since 1970-01-01.
 * @returns 0 (Monday) to 6 (Sunday).
 */
export function weekdayOf(day: number): number {
  return (((day - 4) % 7) + 7) % 7;
}

/**
 * Chooses the drawn range: from a week before the plan (or today) to a few
 * weeks after it, starting on a Monday.
 *
 * @param items Visible items.
 * @param today `YYYY-MM-DD`.
 * @param zoom Zoom level.
 * @returns The scale.
 */
export function timelineScale(
  items: readonly ScheduleDates[],
  today: string,
  zoom: TimelineZoom,
): TimelineScale {
  const todayDay = dayNumber(today);
  let first = todayDay;
  let last = todayDay;
  for (const item of items) {
    for (const date of [item.startDate, item.dueDate]) {
      if (date === null) continue;
      first = Math.min(first, dayNumber(date));
      last = Math.max(last, dayNumber(date));
    }
  }
  const pad = zoom === 'week' ? 7 : zoom === 'month' ? 21 : 56;
  const start = first - pad;
  const origin = start - weekdayOf(start);
  return { origin, days: last + pad * 2 - origin, dayWidth: DAY_WIDTH[zoom] };
}

/**
 * The x position of the start of a half day.
 *
 * @param scale The scale.
 * @param date `YYYY-MM-DD`.
 * @param second The 2nd half.
 * @returns Pixels from the left edge.
 */
export function halfX(scale: TimelineScale, date: string, second: boolean): number {
  return (dayNumber(date) - scale.origin + (second ? 0.5 : 0)) * scale.dayWidth;
}

/** Where a row's bar or marker goes. */
export interface BarBox {
  /** Left edge in pixels. */
  left: number;
  /** Width in pixels; 0 for a one-date marker. */
  width: number;
  /** A one-date marker instead of a bar. */
  marker: 'start' | 'due' | null;
}

/**
 * Places a bar: from the start half to the end of the finish half. With
 * only one date it is a marker.
 *
 * @param scale The scale.
 * @param dates The dates.
 * @returns The box, or null without dates.
 */
export function barBox(scale: TimelineScale, dates: ScheduleDates): BarBox | null {
  const { startDate, dueDate } = dates;
  if (startDate !== null && dueDate !== null) {
    const left = halfX(scale, startDate, dates.startSecondHalf);
    const right = halfX(scale, dueDate, false) + scale.dayWidth / (dates.dueFirstHalf ? 2 : 1);
    return { left, width: Math.max(right - left, scale.dayWidth / 2), marker: null };
  }
  if (startDate !== null)
    return { left: halfX(scale, startDate, dates.startSecondHalf), width: 0, marker: 'start' };
  if (dueDate !== null)
    return {
      left: halfX(scale, dueDate, false) + scale.dayWidth / (dates.dueFirstHalf ? 2 : 1),
      width: 0,
      marker: 'due',
    };
  return null;
}

/** A label along the top of the bar area. */
export interface ScaleTick {
  /** Text. */
  label: string;
  /** Left edge in pixels. */
  left: number;
  /** Width in pixels. */
  width: number;
}

/**
 * Upper and lower header labels for a zoom: weeks over days, months over
 * weeks, or years over months.
 *
 * @param scale The scale.
 * @param zoom Zoom level.
 * @returns Upper and lower ticks.
 */
export function scaleTicks(
  scale: TimelineScale,
  zoom: TimelineZoom,
): { upper: ScaleTick[]; lower: ScaleTick[] } {
  const w = scale.dayWidth;
  const upper: ScaleTick[] = [];
  const lower: ScaleTick[] = [];
  const end = scale.origin + scale.days;
  if (zoom === 'week') {
    for (let d = scale.origin; d < end; d += 7) {
      const date = dateOfDay(d);
      upper.push({ label: shortDay(date, date), left: (d - scale.origin) * w, width: 7 * w });
    }
    for (let d = scale.origin; d < end; d++) {
      lower.push({ label: 'MTWTFSS'[weekdayOf(d)], left: (d - scale.origin) * w, width: w });
    }
    return { upper, lower };
  }
  // Months (upper for month zoom, lower for quarter zoom).
  const months: ScaleTick[] = [];
  for (let d = scale.origin; d < end;) {
    const date = dateOfDay(d);
    const [y, m] = date.split('-').map(Number) as [number, number];
    const next = dayNumber(
      `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`,
    );
    const stop = Math.min(next, end);
    months.push({
      label: `${MONTHS[m - 1]} ${y}`,
      left: (d - scale.origin) * w,
      width: (stop - d) * w,
    });
    d = stop;
  }
  if (zoom === 'month') {
    for (let d = scale.origin; d < end; d += 7) {
      lower.push({
        label: String(Number(dateOfDay(d).slice(8))),
        left: (d - scale.origin) * w,
        width: 7 * w,
      });
    }
    return { upper: months, lower };
  }
  const years: ScaleTick[] = [];
  for (const month of months) {
    const year = month.label.slice(-4);
    const lastYear = years[years.length - 1];
    if (lastYear !== undefined && lastYear.label === year) lastYear.width += month.width;
    else years.push({ label: year, left: month.left, width: month.width });
  }
  return { upper: years, lower: months.map((m) => ({ ...m, label: m.label.slice(0, 3) })) };
}

/**
 * Items that start before a visible predecessor finishes (docs/M9-PLAN.md
 * §3.3), keyed by successor id with the predecessor ids.
 *
 * @param items Visible items.
 * @param edges Visible links.
 * @param cal Holidays (M9.1); none by default.
 * @returns Conflicting successors and their predecessors.
 */
export function conflicts(
  items: readonly WorkItemDto[],
  edges: readonly PlanEdge[],
  cal: WorkCalendar = NO_HOLIDAYS,
): Map<string, string[]> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const result = new Map<string, string[]>();
  for (const edge of edges) {
    const pred = byId.get(edge.blockingItemId);
    const succ = byId.get(edge.blockedItemId);
    if (pred === undefined || succ === undefined || pred.dueDate === null) continue;
    const begin =
      succ.startDate !== null
        ? startSlot(succ.startDate, succ.startSecondHalf, cal)
        : succ.dueDate !== null
          ? endSlot(succ.dueDate, succ.dueFirstHalf, cal)
          : null;
    if (begin === null || begin > endSlot(pred.dueDate, pred.dueFirstHalf, cal)) continue;
    result.set(succ.id, [...(result.get(succ.id) ?? []), pred.id]);
  }
  return result;
}

/**
 * The usual type of a new child under a parent (Epic → Feature → Story →
 * Task; Task under a Feature too).
 *
 * @param parent The parent's type, or null for a top-level row.
 * @param fallback Type for a top-level row.
 * @returns The child type.
 */
export function childTypeOf(parent: ItemType | null, fallback: ItemType): ItemType {
  switch (parent) {
    case ItemType.EPIC:
      return ItemType.FEATURE;
    case ItemType.FEATURE:
      return ItemType.STORY;
    case ItemType.STORY:
      return ItemType.TASK;
    case null:
      return fallback;
    default:
      return ItemType.TASK;
  }
}

/**
 * Outcome of an indent or outdent: the new parent and, when the row's type is
 * not allowed there, the type it becomes (v1.3.1).
 */
export type OutlineMove = { parentId: string | null; type?: ItemType } | { error: string };

/**
 * Where indenting a row puts it: under its previous sibling (the nearest row
 * above at the same depth). Its type is kept when allowed there, else it
 * becomes the sibling's natural child type (v1.3.1; a Feature indented under a
 * Feature becomes a Story).
 *
 * @param rows Rows in display order.
 * @param index The row.
 * @param childTypes Types of the row's own children.
 * @returns The new parent and type, or why it cannot move.
 */
export function indentTarget(
  rows: readonly TimelineRow[],
  index: number,
  childTypes: readonly ItemType[] = [],
): OutlineMove {
  const row = rows[index];
  if (row?.node.item === undefined || row.node.item === null)
    return { error: 'This row cannot move' };
  let i = index - 1;
  while (i >= 0 && rows[i].depth > row.depth) i--;
  const sibling = rows[i];
  if (sibling === undefined || sibling.depth !== row.depth)
    return { error: 'There is no row above at the same level to indent under' };
  return placed(row.node.item, sibling.node.id, sibling.node.ref.type, childTypes);
}

/**
 * The move to a new parent with the type the row needs there.
 *
 * @param item The row's item.
 * @param parentId New parent id, or null for the top level.
 * @param parentType New parent's type, or null.
 * @param childTypes Types of the item's children.
 * @returns The move, or why it cannot happen.
 */
function placed(
  item: WorkItemDto,
  parentId: string | null,
  parentType: ItemType | null,
  childTypes: readonly ItemType[],
): OutlineMove {
  if (item.adHoc && parentId !== null) return { error: 'An ad-hoc item has no parent' };
  const fit = fitTypeUnder(item.type, parentType, childTypes);
  if ('error' in fit) return fit;
  return fit.type === item.type ? { parentId } : { parentId, type: fit.type };
}

/**
 * Where outdenting a row puts it: beside its parent, under the parent's
 * parent. Its type is kept when allowed there, else it becomes the new
 * parent's natural child type (v1.3.1; a Story outdented to an Epic becomes a
 * Feature).
 *
 * @param rows Rows in display order.
 * @param index The row.
 * @param childTypes Types of the row's own children.
 * @returns The new parent and type, or why it cannot move.
 */
export function outdentTarget(
  rows: readonly TimelineRow[],
  index: number,
  childTypes: readonly ItemType[] = [],
): OutlineMove {
  const row = rows[index];
  const item = row?.node.item;
  if (item === undefined || item === null) return { error: 'This row cannot move' };
  if (item.parentId === null) return { error: 'This row is already at the top level' };
  const parent = item.ancestors[item.ancestors.length - 1];
  const grandparent = item.ancestors[item.ancestors.length - 2] ?? null;
  if (parent === undefined) return { error: 'This row is already at the top level' };
  return placed(item, grandparent?.id ?? null, grandparent?.type ?? null, childTypes);
}

/** A row being dragged: its item and the types of its children. */
export interface DraggedRow {
  /** The item. */
  item: WorkItemDto;
  /** Types of its children, which must still fit under its new type. */
  childTypes: readonly ItemType[];
}

/** One placement to send for a drop. */
export interface DropMove {
  /** The item placed. */
  item: WorkItemDto;
  /** Its new parent, type and the sibling it follows. */
  move: OutlineMoveRequest;
}

/** Where dragged rows would land, and why not when they cannot. */
export interface DropTarget {
  /** The placements to send in order, or null when the drop is not possible. */
  moves: DropMove[] | null;
  /** The parent the rows go under, or null for the top level. */
  parent: WorkItemDto | null;
  /** The level the rows would take. */
  depth: number;
  /** Why the drop is not possible, or empty. */
  reason: string;
}

/**
 * Where dropping dragged rows lands (v1.3.1; several rows in v1.3.2): in a
 * gap between the rows left once the dragged ones (with their own rows) are
 * taken out, at a level between the next row's and one below the previous
 * row's, chosen from the wanted level. One level below the previous row makes
 * them that row's first children; otherwise they follow the row at that level
 * just above the gap. They keep their order, each after the one before, and
 * each type is fitted to the new parent as when indenting.
 *
 * @param rest Rows in display order without the dragged rows.
 * @param gap Insert before this index of `rest` (rest.length for the end).
 * @param wanted The level the pointer asks for.
 * @param dragged The dragged rows in display order (none inside another).
 * @returns The placements, the parent, the level and any reason they cannot happen.
 */
export function dropTarget(
  rest: readonly TimelineRow[],
  gap: number,
  wanted: number,
  dragged: readonly DraggedRow[],
): DropTarget {
  const none = (depth: number, reason: string, parent: WorkItemDto | null = null): DropTarget => ({
    moves: null,
    parent,
    depth,
    reason,
  });
  if (dragged.length === 0) return none(0, 'This row cannot move');
  const above = rest[gap - 1];
  const below = rest[gap];
  const depth = Math.max(
    below?.depth ?? 0,
    Math.min(above === undefined ? 0 : above.depth + 1, wanted),
  );
  let parent: WorkItemDto | null;
  let afterId: string | null;
  if (above !== undefined && depth === above.depth + 1) {
    if (!above.node.item) return none(depth, 'A title-only row cannot take rows');
    parent = above.node.item;
    afterId = null;
  } else {
    let i = gap - 1;
    while (i >= 0 && rest[i].depth > depth) i--;
    const anchor = rest[i];
    if (anchor === undefined) {
      parent = null;
      afterId = null;
    } else {
      if (!anchor.node.item) return none(depth, 'A title-only row cannot be a neighbour');
      afterId = anchor.node.id;
      const ref = anchor.node.item.ancestors[anchor.node.item.ancestors.length - 1];
      parent =
        ref === undefined ? null : (rest.find((row) => row.node.id === ref.id)?.node.item ?? null);
      if (ref !== undefined && parent === null)
        return none(depth, 'A title-only row cannot take rows');
    }
  }
  const moves: DropMove[] = [];
  // Several rows: name the one that cannot go there.
  const who = (item: WorkItemDto) => (dragged.length > 1 ? `${item.key}: ` : '');
  for (const { item, childTypes } of dragged) {
    if (item.adHoc && parent !== null)
      return none(depth, `${who(item)}An ad-hoc item has no parent`, parent);
    const fit = fitTypeUnder(item.type, parent?.type ?? null, childTypes);
    if ('error' in fit) return none(depth, who(item) + fit.error, parent);
    const parentId = parent?.id ?? null;
    moves.push({
      item,
      move: {
        afterId,
        ...(parentId === item.parentId ? {} : { parentId }),
        ...(fit.type === item.type ? {} : { type: fit.type }),
      },
    });
    afterId = item.id;
  }
  return { moves, parent, depth, reason: '' };
}

/** Gap between outline positions when siblings are numbered, as on the server. */
const OUTLINE_STEP = 1024;
/** Smallest gap between neighbours before siblings are numbered again, as on the server. */
const OUTLINE_MIN_GAP = 1e-6;

/**
 * The item a placement follows now: the sibling just before it in outline
 * order, or null when it comes first. Undo puts it back after that one.
 *
 * @param items All items.
 * @param item The item.
 * @returns The sibling's id, or null.
 */
export function previousSibling(items: readonly WorkItemDto[], item: WorkItemDto): string | null {
  const siblings = items.filter((i) => i.parentId === item.parentId).sort(compareOutline);
  return siblings[siblings.findIndex((i) => i.id === item.id) - 1]?.id ?? null;
}

/**
 * Applies placements to a copy of the items as the server will (v1.3.2), so
 * a drop shows at once: the new parent and type, new ancestors for the item
 * and its own rows, and a position after the given sibling, numbering the
 * siblings first when some have none. The reload that follows brings the
 * server's copies.
 *
 * @param items All items.
 * @param moves Placements in the order they are sent.
 * @returns The items that changed, in their new state.
 */
export function applyOutlineMoves(
  items: readonly WorkItemDto[],
  moves: readonly { id: string; move: OutlineMoveRequest }[],
): WorkItemDto[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const changed = new Set<string>();
  const put = (item: WorkItemDto) => {
    byId.set(item.id, item);
    changed.add(item.id);
  };
  const refOf = (i: WorkItemDto): ItemRefDto => ({
    id: i.id,
    number: i.number,
    key: i.key,
    type: i.type,
    title: i.title,
  });
  for (const { id, move } of moves) {
    const item = byId.get(id);
    if (item === undefined) continue;
    const parentId = move.parentId === undefined ? item.parentId : move.parentId;
    let moved: WorkItemDto = { ...item, parentId, type: move.type ?? item.type };
    if (parentId !== item.parentId || moved.type !== item.type) {
      const parent = parentId === null ? undefined : byId.get(parentId);
      const ancestors = parent === undefined ? [] : [...parent.ancestors, refOf(parent)];
      moved = { ...moved, ancestors };
      // Its own rows follow it: their ancestors now start with its new ones.
      const self = refOf(moved);
      for (const other of byId.values()) {
        const at = other.ancestors.findIndex((a) => a.id === id);
        if (at >= 0)
          put({ ...other, ancestors: [...ancestors, self, ...other.ancestors.slice(at + 1)] });
      }
    }
    const siblings = [...byId.values()]
      .filter((i) => i.parentId === parentId && i.id !== id)
      .sort(compareOutline);
    const at = move.afterId ? siblings.findIndex((s) => s.id === move.afterId) + 1 : 0;
    const left = siblings[at - 1]?.outlinePosition ?? null;
    const right = siblings[at]?.outlinePosition ?? null;
    if (
      siblings.some((s) => s.outlinePosition === null) ||
      (left !== null && right !== null && right - left < OUTLINE_MIN_GAP)
    ) {
      siblings.forEach((sibling, index) => {
        siblings[index] = { ...sibling, outlinePosition: (index + 1) * OUTLINE_STEP };
        put(siblings[index]);
      });
    }
    const before = siblings[at - 1]?.outlinePosition ?? null;
    const next = siblings[at]?.outlinePosition ?? null;
    const position =
      before === null
        ? (next ?? OUTLINE_STEP * 2) - OUTLINE_STEP
        : next === null
          ? before + OUTLINE_STEP
          : (before + next) / 2;
    put({ ...moved, outlinePosition: position });
  }
  return [...changed].map((id) => byId.get(id)!);
}

/**
 * A readable type name.
 *
 * @param type Item type.
 * @returns E.g. "User Story".
 */
export function typeName(type: ItemType): string {
  return { EPIC: 'Epic', FEATURE: 'Feature', STORY: 'User Story', TASK: 'Task', BUG: 'Bug' }[type];
}

/** One pasted line. */
export interface PastedRow {
  /** Title. */
  title: string;
  /** Indent level, 0 for the first level. */
  level: number;
}

/**
 * Splits pasted text into rows: one per non-empty line, with leading tabs
 * or pairs of spaces as indent levels, relative to the least indented line.
 * Tab-separated columns after the title are ignored.
 *
 * @param text Pasted text.
 * @param maxTitle Longest title kept; longer ones are cut.
 * @returns Rows.
 */
export function parsePasted(text: string, maxTitle: number): PastedRow[] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => l.trim() !== '');
  const levels = lines.map((l) => {
    const lead = /^[\t ]*/.exec(l)?.[0] ?? '';
    return [...lead].reduce((n, c) => n + (c === '\t' ? 2 : 1), 0) >> 1;
  });
  const min = Math.min(...levels);
  return lines.map((l, i) => ({
    title: (l.trim().split('\t')[0] ?? '').trim().slice(0, maxTitle),
    level: levels[i] - min,
  }));
}

/**
 * Reads a predecessors cell: item numbers or keys separated by commas or
 * spaces ("12, 15" or "KLO-12").
 *
 * @param text The cell text.
 * @param byNumber Visible items by number.
 * @returns Item ids found, and the parts that name no visible item.
 */
export function parsePredecessors(
  text: string,
  byNumber: ReadonlyMap<number, WorkItemDto>,
): { ids: string[]; unknown: string[] } {
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const part of text.split(/[\s,;]+/).filter((p) => p !== '')) {
    const number = Number(/(\d+)$/.exec(part)?.[1] ?? NaN);
    const item = Number.isInteger(number) ? byNumber.get(number) : undefined;
    if (item === undefined) unknown.push(part);
    else if (!ids.includes(item.id)) ids.push(item.id);
  }
  return { ids, unknown };
}

/**
 * After an item moved in the hierarchy, gives its visible descendants the
 * new ancestor chain, so the tree stays right without reloading everything.
 *
 * @param items Visible items, the moved one already updated.
 * @param moved The moved item as the API returned it.
 * @returns The items with rebased descendants.
 */
export function rebaseDescendants(
  items: readonly WorkItemDto[],
  moved: WorkItemDto,
): WorkItemDto[] {
  const head = [
    ...moved.ancestors,
    { id: moved.id, number: moved.number, key: moved.key, type: moved.type, title: moved.title },
  ];
  return items.map((item) => {
    const at = item.ancestors.findIndex((a) => a.id === moved.id);
    return at < 0 ? item : { ...item, ancestors: [...head, ...item.ancestors.slice(at + 1)] };
  });
}

/**
 * The types an item may change to (SPEC §4.1): allowed under its parent and
 * able to hold its visible children. An item off the board may become a
 * Story, Task or Bug; the API then places it in the default bucket (v1.3.1).
 *
 * @param item The item.
 * @param childTypes Types of its visible children.
 * @returns Types in the usual order, its own included.
 */
export function allowedTypes(item: WorkItemDto, childTypes: readonly ItemType[]): ItemType[] {
  const parent = item.ancestors[item.ancestors.length - 1];
  return Object.values(ItemType).filter(
    (type) =>
      (parent === undefined || isAllowedParent(type, parent.type)) &&
      childTypes.every((child) => isAllowedParent(child, type)),
  );
}

/**
 * Percent complete of a row (docs/M9-PLAN.md §3.1, Progress column): an item
 * is 100 when Done, otherwise the share of its checklist ticked (0 without a
 * checklist). A parent averages its visible items without children, each
 * weighted by its working days (at least half a day), as Microsoft Project does.
 *
 * @param node The row's tree node.
 * @param cal Holidays (M9.1); none by default.
 * @returns Whole percent, or null for a title-only row without visible items.
 */
export function percentComplete(node: TreeNode, cal: WorkCalendar = NO_HOLIDAYS): number | null {
  const own = (item: WorkItemDto): number =>
    item.status === 'DONE'
      ? 100
      : item.checklist.total > 0
        ? (item.checklist.done / item.checklist.total) * 100
        : 0;
  const leaves = (n: TreeNode): WorkItemDto[] =>
    n.children.length === 0 ? (n.item === null ? [] : [n.item]) : n.children.flatMap(leaves);
  const items = leaves(node);
  if (items.length === 0) return null;
  let weight = 0;
  let done = 0;
  for (const item of items) {
    const w = Math.max(0.5, workingDuration(item, cal));
    weight += w;
    done += w * own(item);
  }
  return Math.round(done / weight);
}

/**
 * Changes that keep items' working days after holidays changed (docs/
 * M9-PLAN.md §14): Not started items the caller may edit, whose dates touch
 * the changed days, keep the duration they had under the old calendar. A
 * start on a new holiday moves to the next working day and the finish moves.
 * Dependent items then follow through the reschedule flow.
 *
 * @param items Visible items.
 * @param ranges The changed holiday ranges.
 * @param before The calendar the items were planned with.
 * @param after The calendar now.
 * @returns Reschedule changes, keeping pins.
 */
export function keepDurations(
  items: readonly WorkItemDto[],
  ranges: readonly { startDate: string; endDate: string }[],
  before: WorkCalendar,
  after: WorkCalendar,
): RescheduleChangeRequest[] {
  const changes: RescheduleChangeRequest[] = [];
  for (const item of items) {
    if (item.status !== 'NOT_STARTED' || !item.can.plan) continue;
    if (item.startDate === null || item.dueDate === null) continue;
    const touches = ranges.some(
      (r) => r.startDate <= item.dueDate! && r.endDate >= item.startDate!,
    );
    if (!touches) continue;
    const start = slotHalfDay(startSlot(item.startDate, item.startSecondHalf, after), after);
    const days = Math.max(0.5, workingDuration(item, before));
    const finish = finishAfter(start, days, after);
    if (
      start.date === item.startDate &&
      start.second === item.startSecondHalf &&
      finish.dueDate === item.dueDate &&
      finish.dueFirstHalf === item.dueFirstHalf
    )
      continue;
    changes.push({
      item: item.id,
      startDate: start.date,
      startSecondHalf: start.second,
      ...finish,
      pin: 'keep',
    });
  }
  return changes;
}
