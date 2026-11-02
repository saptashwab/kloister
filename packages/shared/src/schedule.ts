import { ItemStatus } from './items.js';

/**
 * Timeline scheduling (SPEC §6.4, docs/M9-PLAN.md §3.2 and §4.1).
 *
 * Working days are Monday to Friday, with no holiday calendar. Each working
 * day has a 1st and a 2nd half and no clock times. Internally every half day
 * is a "slot": consecutive integers that skip weekends, so durations and
 * finish-to-start links are plain integer arithmetic. Dates are calendar
 * dates (`YYYY-MM-DD`) read in UTC, like every other date in the app.
 *
 * The planner here is pure and runs in both the API (which applies moves)
 * and the web app (which shows durations, totals and previews).
 */

/** One half of a calendar day. */
export interface HalfDay {
  /** `YYYY-MM-DD`. */
  date: string;
  /** True for the 2nd half. */
  second: boolean;
}

/** The scheduling fields of an item. */
export interface ScheduleDates {
  /** `YYYY-MM-DD`, or null. */
  startDate: string | null;
  /** The item starts in the 2nd half of its start date. */
  startSecondHalf: boolean;
  /** `YYYY-MM-DD`, or null. */
  dueDate: string | null;
  /** The item finishes after the 1st half of its due date. */
  dueFirstHalf: boolean;
}

/** Milliseconds in a day. */
const DAY_MS = 86_400_000;

/** Day number (days since 1970-01-01) of a Monday, the origin of the slot count. */
const EPOCH_MONDAY = 4;

/**
 * Converts a calendar date to its day number.
 *
 * @param date `YYYY-MM-DD`.
 * @returns Days since 1970-01-01.
 */
function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

/**
 * Converts a day number back to a calendar date.
 *
 * @param day Days since 1970-01-01.
 * @returns `YYYY-MM-DD`.
 */
function dateOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Day of the week, Monday first.
 *
 * @param day Day number.
 * @returns 0 (Monday) to 6 (Sunday).
 */
function weekday(day: number): number {
  return (((day - EPOCH_MONDAY) % 7) + 7) % 7;
}

/**
 * Reports whether a date is a working day (Monday to Friday).
 *
 * @param date `YYYY-MM-DD`.
 * @returns True on weekdays.
 */
export function isWorkingDay(date: string): boolean {
  return weekday(dayNumber(date)) < 5;
}

/**
 * Index of a working day among all working days since the slot origin.
 *
 * @param day Day number of a weekday.
 * @returns Working-day index.
 */
function workIndex(day: number): number {
  return Math.floor((day - EPOCH_MONDAY) / 7) * 5 + weekday(day);
}

/**
 * Whole-day holidays that are not working days (docs/M9-PLAN.md §14), as
 * indexes among all weekdays. Build it with {@link workCalendar}.
 */
export interface WorkCalendar {
  /** Weekday indexes of the holidays, ascending. */
  readonly holidayIndexes: readonly number[];
  /** The same indexes, for lookups. */
  readonly holidaySet: ReadonlySet<number>;
}

/** A calendar without holidays. */
export const NO_HOLIDAYS: WorkCalendar = { holidayIndexes: [], holidaySet: new Set() };

/**
 * Builds a calendar from holiday date ranges; weekend days in them are
 * ignored, since they are not working days anyway.
 *
 * @param ranges Holidays, each from `startDate` to `endDate` inclusive.
 * @returns The calendar.
 */
export function workCalendar(
  ranges: readonly { startDate: string; endDate: string }[],
): WorkCalendar {
  const set = new Set<number>();
  for (const range of ranges) {
    for (let day = dayNumber(range.startDate); day <= dayNumber(range.endDate); day++) {
      if (weekday(day) < 5) set.add(workIndex(day));
    }
  }
  return { holidayIndexes: [...set].sort((a, b) => a - b), holidaySet: set };
}

/**
 * Reports whether a date is a holiday in a calendar.
 *
 * @param date `YYYY-MM-DD`.
 * @param cal The calendar.
 * @returns True for a weekday holiday.
 */
export function isHoliday(date: string, cal: WorkCalendar): boolean {
  const day = dayNumber(date);
  return weekday(day) < 5 && cal.holidaySet.has(workIndex(day));
}

/**
 * Number of holidays before a weekday index.
 *
 * @param index Weekday index.
 * @param cal The calendar.
 * @returns The count.
 */
function holidaysBefore(index: number, cal: WorkCalendar): number {
  let low = 0;
  let high = cal.holidayIndexes.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (cal.holidayIndexes[mid] < index) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * The slot a start falls in. A start on a weekend or a holiday counts from
 * the next working day's 1st half.
 *
 * @param date Start date.
 * @param second Starts in the 2nd half.
 * @param cal Holidays; none by default.
 * @returns Slot number.
 */
export function startSlot(date: string, second: boolean, cal: WorkCalendar = NO_HOLIDAYS): number {
  const day = dayNumber(date);
  const dow = weekday(day);
  let index = dow >= 5 ? workIndex(day + (7 - dow)) : workIndex(day);
  let half = dow >= 5 ? 0 : second ? 1 : 0;
  while (cal.holidaySet.has(index)) {
    index++;
    half = 0;
  }
  return (index - holidaysBefore(index, cal)) * 2 + half;
}

/**
 * The last slot of a finish. A finish on a weekend or a holiday counts to the
 * previous working day's 2nd half.
 *
 * @param date Due date.
 * @param firstHalf Finishes after the 1st half.
 * @param cal Holidays; none by default.
 * @returns Slot number.
 */
export function endSlot(date: string, firstHalf: boolean, cal: WorkCalendar = NO_HOLIDAYS): number {
  const day = dayNumber(date);
  const dow = weekday(day);
  let index = dow >= 5 ? workIndex(day - (dow - 4)) : workIndex(day);
  let half = dow >= 5 ? 1 : firstHalf ? 0 : 1;
  while (cal.holidaySet.has(index)) {
    index--;
    half = 1;
  }
  return (index - holidaysBefore(index, cal)) * 2 + half;
}

/**
 * The half day a slot stands for.
 *
 * @param slot Slot number.
 * @param cal Holidays; none by default.
 * @returns Date and half.
 */
export function slotHalfDay(slot: number, cal: WorkCalendar = NO_HOLIDAYS): HalfDay {
  const working = Math.floor(slot / 2);
  // The weekday index whose working-day position is `working`, skipping holidays.
  let index = working;
  for (;;) {
    const candidate = working + holidaysBefore(index, cal);
    if (candidate === index && !cal.holidaySet.has(index)) break;
    index = cal.holidaySet.has(candidate) ? candidate + 1 : candidate;
  }
  const week = Math.floor(index / 5);
  const dow = index - week * 5;
  return { date: dateOf(EPOCH_MONDAY + week * 7 + dow), second: slot - working * 2 === 1 };
}

/**
 * Duration in working days, in steps of half a day, from the start half to
 * the finish half, both included. Zero when either date is missing or the
 * span holds no working half day.
 *
 * @param dates The item's dates.
 * @param cal Holidays; none by default.
 * @returns Working days, e.g. 2.5.
 */
export function workingDuration(dates: ScheduleDates, cal: WorkCalendar = NO_HOLIDAYS): number {
  if (dates.startDate === null || dates.dueDate === null) return 0;
  const halves =
    endSlot(dates.dueDate, dates.dueFirstHalf, cal) -
    startSlot(dates.startDate, dates.startSecondHalf, cal) +
    1;
  return Math.max(0, halves) / 2;
}

/**
 * Where an item finishes when it starts at a half day and lasts a duration.
 *
 * @param start Start date and half.
 * @param duration Working days, a positive multiple of 0.5.
 * @param cal Holidays; none by default.
 * @returns Due date and whether it finishes after the 1st half.
 */
export function finishAfter(
  start: HalfDay,
  duration: number,
  cal: WorkCalendar = NO_HOLIDAYS,
): { dueDate: string; dueFirstHalf: boolean } {
  const last = startSlot(start.date, start.second, cal) + Math.round(duration * 2) - 1;
  const half = slotHalfDay(last, cal);
  return { dueDate: half.date, dueFirstHalf: !half.second };
}

/**
 * Reports whether a duration is one the timeline accepts: at least half a
 * day, in steps of half a day.
 *
 * @param duration Working days.
 * @returns True when valid.
 */
export function isValidDuration(duration: number): boolean {
  return Number.isFinite(duration) && duration >= 0.5 && Number.isInteger(duration * 2);
}

/**
 * Reports whether an item's start comes after its finish, counting halves:
 * a same-day item cannot start in the 2nd half and finish after the 1st.
 *
 * @param dates The item's dates.
 * @returns True when the order is wrong.
 */
export function startsAfterFinish(dates: ScheduleDates): boolean {
  if (dates.startDate === null || dates.dueDate === null) return false;
  if (dates.startDate !== dates.dueDate) return dates.startDate > dates.dueDate;
  return dates.startSecondHalf && dates.dueFirstHalf;
}

/** An item as the planner sees it: one the caller can see. */
export interface PlanItem extends ScheduleDates {
  /** Item id. */
  id: string;
  /** Status; only Not started items move. */
  status: ItemStatus;
  /** "Start no earlier than", or null. */
  pin: HalfDay | null;
  /** The caller may edit this item. */
  editable: boolean;
}

/** A "blocked by" link between two items the caller can see. */
export interface PlanEdge {
  /** The predecessor. */
  blockingItemId: string;
  /** The successor. */
  blockedItemId: string;
}

/** How a requested change treats the item's pin. */
export const PinAction = {
  /** Apply the pin rule (default): a later-than-allowed start becomes the pin. */
  AUTO: 'auto',
  /** Leave the pin as it is. */
  KEEP: 'keep',
  /** Pin the new start. */
  SET: 'set',
  /** Remove the pin and move the item to its earliest start. */
  REMOVE: 'remove',
} as const;

/** One of the {@link PinAction} values. */
export type PinAction = (typeof PinAction)[keyof typeof PinAction];

/** A change someone asked for. */
export interface PlanChange {
  /** Item id. */
  id: string;
  /** New dates; omitted to only reschedule the item from its predecessors. */
  dates?: ScheduleDates;
  /** Pin handling; default {@link PinAction.AUTO}. */
  pin?: PinAction;
}

/** Why a reached item was left where it is. */
export const KeptReason = {
  /** The caller may not edit it. */
  NOT_EDITABLE: 'NOT_EDITABLE',
  /** It is in progress, blocked or done. */
  STARTED: 'STARTED',
  /** Its pin holds it later than its predecessors allow. */
  PINNED: 'PINNED',
} as const;

/** One of the {@link KeptReason} values. */
export type KeptReason = (typeof KeptReason)[keyof typeof KeptReason];

/** One item the plan changes. */
export interface PlannedChange {
  /** Item id. */
  id: string;
  /** Dates before. */
  from: ScheduleDates;
  /** Dates after. */
  to: ScheduleDates;
  /** Pin before. */
  pinFrom: HalfDay | null;
  /** Pin after. */
  pinTo: HalfDay | null;
  /** True for an item the caller changed, false for a dependent item moved. */
  requested: boolean;
  /** A requested start before the earliest allowed one was moved to it. */
  snapped: boolean;
}

/** A dependent item the plan reached but did not move. */
export interface KeptItem {
  /** Item id. */
  id: string;
  /** Why it stays. */
  reason: KeptReason;
}

/** The outcome of planning a change. */
export interface SchedulePlan {
  /** Every item that changes, requested ones first, then in dependency order. */
  changes: PlannedChange[];
  /** Dependent items that would have moved but stay. */
  kept: KeptItem[];
}

/**
 * Plans a change and the moves of dependent items (docs/M9-PLAN.md §4.1):
 * finish-to-start links without lag; a Not started item with constraining
 * predecessors starts at the half day after its latest predecessor finishes,
 * or at its pin if that is later, keeping its duration; it moves earlier as
 * well as later. Items that are started, not editable, undated or without
 * constraining predecessors stay, and the chain stops at them.
 *
 * Only items and links the caller can see may be passed in, so hidden items
 * never affect the result.
 *
 * @param items Visible items (at least the requested ones and their neighbours).
 * @param edges Links whose both ends are visible.
 * @param requested The changes asked for.
 * @param cal Holidays; none by default.
 * @returns The plan.
 */
export function planSchedule(
  items: readonly PlanItem[],
  edges: readonly PlanEdge[],
  requested: readonly PlanChange[],
  cal: WorkCalendar = NO_HOLIDAYS,
): SchedulePlan {
  const byId = new Map(items.map((i) => [i.id, { ...i }]));
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const e of edges) {
    if (!byId.has(e.blockingItemId) || !byId.has(e.blockedItemId)) continue;
    preds.set(e.blockedItemId, [...(preds.get(e.blockedItemId) ?? []), e.blockingItemId]);
    succs.set(e.blockingItemId, [...(succs.get(e.blockingItemId) ?? []), e.blockedItemId]);
  }
  const original = new Map(items.map((i) => [i.id, { ...i }]));
  const asked = new Map(requested.filter((c) => byId.has(c.id)).map((c) => [c.id, c]));

  // Requested dates apply first; the pin rule needs the predecessors' final
  // dates, so it runs in dependency order below.
  for (const change of asked.values()) {
    if (change.dates !== undefined) Object.assign(byId.get(change.id)!, change.dates);
  }

  const order = topologicalOrder([...asked.keys()], succs);
  const dirty = new Set(asked.keys());
  const snapped = new Set<string>();
  const kept: KeptItem[] = [];

  for (const id of order) {
    if (!dirty.has(id)) continue;
    const item = byId.get(id)!;
    const before = original.get(id)!;
    const change = asked.get(id);
    const earliest = earliestStart(preds.get(id) ?? [], byId, cal);

    if (change !== undefined) {
      applyRequested(item, before, change, earliest, snapped, cal);
    } else {
      const reason = reachedOutcome(item, earliest, cal);
      if (reason !== null) {
        if (reason !== 'MOVE') kept.push({ id, reason });
      }
    }
    if (!sameDates(item, before)) for (const s of succs.get(id) ?? []) dirty.add(s);
  }

  const changes: PlannedChange[] = [];
  const push = (id: string): void => {
    const item = byId.get(id)!;
    const before = original.get(id)!;
    if (sameDates(item, before) && samePin(item.pin, before.pin)) return;
    changes.push({
      id,
      from: datesOf(before),
      to: datesOf(item),
      pinFrom: before.pin,
      pinTo: item.pin,
      requested: asked.has(id),
      snapped: snapped.has(id),
    });
  };
  for (const id of asked.keys()) push(id);
  for (const id of order) if (!asked.has(id)) push(id);
  return { changes, kept };
}

/**
 * Applies a requested change's pin rule to an item whose requested dates are
 * already set. Only Not started items get pins or snap to their earliest
 * start; a started item keeps whatever dates were asked for.
 *
 * @param item The item, already holding the requested dates.
 * @param before The item before the change.
 * @param change The change.
 * @param earliest Earliest start slot, or null without constraining predecessors.
 * @param snapped Collects items whose start was moved to the earliest one.
 * @param cal Holidays.
 */
function applyRequested(
  item: PlanItem,
  before: PlanItem,
  change: PlanChange,
  earliest: number | null,
  snapped: Set<string>,
  cal: WorkCalendar,
): void {
  const pin = change.pin ?? PinAction.AUTO;
  const start =
    item.startDate === null ? null : startSlot(item.startDate, item.startSecondHalf, cal);
  if (pin === PinAction.KEEP) return;
  if (pin === PinAction.SET) {
    item.pin = start === null ? null : slotHalfDay(start, cal);
    return;
  }
  if (pin === PinAction.REMOVE) {
    item.pin = null;
    if (item.status === ItemStatus.NOT_STARTED && earliest !== null) placeAt(item, earliest, cal);
    return;
  }
  const startChanged =
    change.dates === undefined
      ? false
      : item.startDate !== before.startDate || item.startSecondHalf !== before.startSecondHalf;
  if (change.dates === undefined) {
    // A plain reschedule: as a reached item, but the caller asked for it.
    if (item.status === ItemStatus.NOT_STARTED && item.editable && earliest !== null) {
      placeAt(item, Math.max(earliest, pinSlot(item, cal) ?? earliest), cal);
    }
    return;
  }
  if (!startChanged || item.status !== ItemStatus.NOT_STARTED || earliest === null) return;
  if (start === null) return;
  if (start > earliest) item.pin = slotHalfDay(start, cal);
  else {
    item.pin = null;
    if (start < earliest) {
      placeAt(item, earliest, cal);
      snapped.add(item.id);
    }
  }
}

/**
 * Decides what happens to a dependent item the plan reached, moving it when
 * it may move.
 *
 * @param item The item; updated in place when it moves.
 * @param earliest Earliest start slot, or null without constraining predecessors.
 * @param cal Holidays.
 * @returns 'MOVE' when it may move (whether or not it changed), a reason when
 *   it would have moved but stays, or null when nothing applies.
 */
function reachedOutcome(
  item: PlanItem,
  earliest: number | null,
  cal: WorkCalendar,
): KeptReason | 'MOVE' | null {
  if (earliest === null || (item.startDate === null && item.dueDate === null)) return null;
  const pin = pinSlot(item, cal);
  const target = Math.max(earliest, pin ?? earliest);
  const current = currentStart(item, cal);
  if (!item.editable) return current !== target ? KeptReason.NOT_EDITABLE : null;
  if (item.status !== ItemStatus.NOT_STARTED) return current < earliest ? KeptReason.STARTED : null;
  placeAt(item, target, cal);
  if (pin !== null && pin > earliest && current === target) return KeptReason.PINNED;
  return 'MOVE';
}

/**
 * Moves an item so it starts at a slot, keeping its duration. A due-only item
 * finishes at the end of that half day; a start-only item just starts there.
 *
 * @param item The item; updated in place.
 * @param slot Target start slot.
 * @param cal Holidays.
 */
function placeAt(item: PlanItem, slot: number, cal: WorkCalendar): void {
  if (item.startDate === null) {
    if (item.dueDate === null) return;
    const half = slotHalfDay(slot, cal);
    item.dueDate = half.date;
    item.dueFirstHalf = !half.second;
    return;
  }
  const halves =
    item.dueDate === null
      ? 0
      : Math.max(
          1,
          endSlot(item.dueDate, item.dueFirstHalf, cal) -
            startSlot(item.startDate, item.startSecondHalf, cal) +
            1,
        );
  const start = slotHalfDay(slot, cal);
  item.startDate = start.date;
  item.startSecondHalf = start.second;
  if (item.dueDate !== null) {
    const end = slotHalfDay(slot + halves - 1, cal);
    item.dueDate = end.date;
    item.dueFirstHalf = !end.second;
  }
}

/**
 * The slot an item currently starts in, using its due date for due-only items.
 *
 * @param item The item, with at least one date.
 * @param cal Holidays.
 * @returns Slot number.
 */
function currentStart(item: PlanItem, cal: WorkCalendar): number {
  if (item.startDate !== null) return startSlot(item.startDate, item.startSecondHalf, cal);
  return endSlot(item.dueDate!, item.dueFirstHalf, cal);
}

/**
 * The slot of an item's pin, or null without one.
 *
 * @param item The item.
 * @param cal Holidays.
 * @returns Slot number, or null.
 */
function pinSlot(item: PlanItem, cal: WorkCalendar): number | null {
  return item.pin === null ? null : startSlot(item.pin.date, item.pin.second, cal);
}

/**
 * The earliest slot an item may start in: the one after the latest finish
 * among its predecessors that have a due date.
 *
 * @param predIds The item's predecessors.
 * @param byId Items in their planned state.
 * @param cal Holidays; none by default.
 * @returns Slot number, or null when no predecessor constrains it.
 */
export function earliestStart(
  predIds: readonly string[],
  byId: ReadonlyMap<string, ScheduleDates>,
  cal: WorkCalendar = NO_HOLIDAYS,
): number | null {
  let latest: number | null = null;
  for (const id of predIds) {
    const pred = byId.get(id);
    if (pred === undefined || pred.dueDate === null) continue;
    const end = endSlot(pred.dueDate, pred.dueFirstHalf, cal);
    if (latest === null || end > latest) latest = end;
  }
  return latest === null ? null : latest + 1;
}

/**
 * Orders the items reachable from the starting ones so every item comes
 * after its reachable predecessors. Links never form cycles (SPEC §4); a
 * cycle, if one slipped through, is cut where it closes.
 *
 * @param starts Starting items.
 * @param succs Successors per item.
 * @returns Item ids in dependency order.
 */
function topologicalOrder(
  starts: readonly string[],
  succs: ReadonlyMap<string, readonly string[]>,
): string[] {
  const reach = new Set<string>();
  const stack = [...starts];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reach.has(id)) continue;
    reach.add(id);
    stack.push(...(succs.get(id) ?? []));
  }
  const indegree = new Map<string, number>([...reach].map((id) => [id, 0]));
  for (const id of reach) {
    for (const s of succs.get(id) ?? []) indegree.set(s, (indegree.get(s) ?? 0) + 1);
  }
  const queue = [...reach].filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const s of succs.get(id) ?? []) {
      const left = indegree.get(s)! - 1;
      indegree.set(s, left);
      if (left === 0) queue.push(s);
    }
  }
  for (const id of reach) if (!order.includes(id)) order.push(id);
  return order;
}

/**
 * Copies the scheduling fields of an item.
 *
 * @param item The item.
 * @returns The dates.
 */
function datesOf(item: ScheduleDates): ScheduleDates {
  return {
    startDate: item.startDate,
    startSecondHalf: item.startSecondHalf,
    dueDate: item.dueDate,
    dueFirstHalf: item.dueFirstHalf,
  };
}

/**
 * Reports whether two sets of dates are equal.
 *
 * @param a First.
 * @param b Second.
 * @returns True when equal.
 */
export function sameDates(a: ScheduleDates, b: ScheduleDates): boolean {
  return (
    a.startDate === b.startDate &&
    a.startSecondHalf === b.startSecondHalf &&
    a.dueDate === b.dueDate &&
    a.dueFirstHalf === b.dueFirstHalf
  );
}

/**
 * Reports whether two pins are equal.
 *
 * @param a First.
 * @param b Second.
 * @returns True when equal.
 */
function samePin(a: HalfDay | null, b: HalfDay | null): boolean {
  return a === b || (a !== null && b !== null && a.date === b.date && a.second === b.second);
}

/** The span of a group of items, for summary rows and the plan total. */
export interface ScheduleSpan {
  /** Earliest start. */
  start: HalfDay;
  /** Latest finish: date and whether it is after the 1st half. */
  finish: { dueDate: string; dueFirstHalf: boolean };
  /** Working days from first start to last finish. */
  duration: number;
  /** Sum of the items' own durations. */
  work: number;
}

/**
 * Spans a group of items from the earliest start to the latest finish (docs/
 * M9-PLAN.md §3.2.1). An item with only one date counts that half day.
 *
 * @param items Items, usually the dated leaves under a parent.
 * @param cal Holidays; none by default.
 * @returns The span, or null when no item has a date.
 */
export function scheduleSpan(
  items: readonly ScheduleDates[],
  cal: WorkCalendar = NO_HOLIDAYS,
): ScheduleSpan | null {
  let first: number | null = null;
  let last: number | null = null;
  let work = 0;
  for (const item of items) {
    const own = {
      start: item.startDate === null ? null : startSlot(item.startDate, item.startSecondHalf, cal),
      end: item.dueDate === null ? null : endSlot(item.dueDate, item.dueFirstHalf, cal),
    };
    // A one-date item counts the half day it has.
    const s = own.start ?? own.end;
    const e = own.end ?? own.start;
    if (s === null || e === null) continue;
    if (first === null || s < first) first = s;
    if (last === null || e > last) last = e;
    work += workingDuration(item, cal);
  }
  if (first === null || last === null) return null;
  const end = slotHalfDay(last, cal);
  return {
    start: slotHalfDay(first, cal),
    finish: { dueDate: end.date, dueFirstHalf: !end.second },
    duration: Math.max(0, last - first + 1) / 2,
    work,
  };
}

/**
 * Adds calendar days to a date.
 *
 * @param date `YYYY-MM-DD`.
 * @param days Days to add; negative moves back.
 * @returns `YYYY-MM-DD`.
 */
export function addDays(date: string, days: number): string {
  return dateOf(dayNumber(date) + days);
}

/**
 * The Monday of a date's week.
 *
 * @param date `YYYY-MM-DD`.
 * @returns `YYYY-MM-DD` of that week's Monday.
 */
export function mondayOf(date: string): string {
  const day = dayNumber(date);
  return dateOf(day - weekday(day));
}

/**
 * Working days in a date range, holidays excluded.
 *
 * @param from First day, `YYYY-MM-DD`.
 * @param to Last day, `YYYY-MM-DD`.
 * @param cal Holidays; none by default.
 * @returns Working days, e.g. 4.
 */
export function workingDaysIn(from: string, to: string, cal: WorkCalendar = NO_HOLIDAYS): number {
  return Math.max(0, endSlot(to, false, cal) - startSlot(from, false, cal) + 1) / 2;
}

/**
 * The working days of an item that fall within a date range (workload, M13),
 * counting its halves. Items without both dates have none.
 *
 * @param dates The item's dates.
 * @param from First day of the range.
 * @param to Last day of the range.
 * @param cal Holidays; none by default.
 * @returns Working days, in steps of half a day.
 */
export function workingDaysWithin(
  dates: ScheduleDates,
  from: string,
  to: string,
  cal: WorkCalendar = NO_HOLIDAYS,
): number {
  if (dates.startDate === null || dates.dueDate === null) return 0;
  const first = Math.max(
    startSlot(dates.startDate, dates.startSecondHalf, cal),
    startSlot(from, false, cal),
  );
  const last = Math.min(endSlot(dates.dueDate, dates.dueFirstHalf, cal), endSlot(to, false, cal));
  return Math.max(0, last - first + 1) / 2;
}

/**
 * Moves an item so it finishes on another day and keeps its working duration
 * (calendar drag, M13). For an item with both dates, a finish on a weekend or
 * holiday moves back to the previous working day. An item with one date moves
 * that date to the day as it is; an undated item stays as it is.
 *
 * @param dates The item's dates.
 * @param due The new finish day.
 * @param cal Holidays; none by default.
 * @returns The new dates.
 */
export function moveFinishTo(
  dates: ScheduleDates,
  due: string,
  cal: WorkCalendar = NO_HOLIDAYS,
): ScheduleDates {
  if (dates.dueDate === null) {
    return dates.startDate === null ? dates : { ...dates, startDate: due };
  }
  if (dates.startDate === null) return { ...dates, dueDate: due };
  const halves = Math.max(
    1,
    endSlot(dates.dueDate, dates.dueFirstHalf, cal) -
      startSlot(dates.startDate, dates.startSecondHalf, cal) +
      1,
  );
  const end = endSlot(due, dates.dueFirstHalf, cal);
  const finish = slotHalfDay(end, cal);
  const start = slotHalfDay(end - halves + 1, cal);
  return {
    startDate: start.date,
    startSecondHalf: start.second,
    dueDate: finish.date,
    dueFirstHalf: !finish.second,
  };
}
