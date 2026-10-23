import {
  dueNow,
  isOverdueAt,
  ItemStatus,
  type MoveItemRequest,
  type UpdateItemRequest,
  type WorkItemDto,
} from '@kloister/shared';

/** How urgent a due date is (DESIGN §3.4). */
export type DueState = 'overdue' | 'soon' | 'later';

/** Days ahead that count as "due soon", today included (DESIGN §3.4). */
export const DUE_SOON_DAYS = 3;

/** Weekday and month names for short dates. */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Whole days from one `YYYY-MM-DD` date to another (negative when `to` is
 * earlier). Calendar dates, so time zones and DST cannot shift the count.
 *
 * @param from Start date.
 * @param to End date.
 * @returns Days between them.
 */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * A short date such as "Fri 17 Oct".
 *
 * @param date `YYYY-MM-DD`.
 * @returns The formatted date.
 */
export function shortDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Fields the due rules read; `dueTime` is optional for older payloads. */
export type DueItem = Pick<WorkItemDto, 'dueDate' | 'status'> & { dueTime?: string | null };

/**
 * Minutes after midnight now, in the viewer's local time.
 *
 * @returns Minutes (0–1439).
 */
export function nowMinutes(): number {
  return dueNow(new Date()).minutes;
}

/**
 * How urgent an item's due date is: overdue (not Done, and before today, or
 * today past its due time; SPEC §6, M8.5), soon (today to
 * {@link DUE_SOON_DAYS} days ahead, not Done) or later.
 *
 * @param item The item.
 * @param today `YYYY-MM-DD`.
 * @param minutes Minutes after midnight now; defaults to the current time.
 * @returns The state, or null without a due date.
 */
export function dueState(
  item: DueItem,
  today: string,
  minutes: number = nowMinutes(),
): DueState | null {
  if (item.dueDate === null) return null;
  if (item.status === ItemStatus.DONE) return 'later';
  if (isOverdueAt(item, { date: today, minutes })) return 'overdue';
  return daysBetween(today, item.dueDate) <= DUE_SOON_DAYS ? 'soon' : 'later';
}

/**
 * The due date in words for cards and the drawer: "2 days overdue", "Due
 * today", "Due tomorrow", "Due in 3 days", or the date; with a due time,
 * "Due today 17:00", "Overdue since 17:00" or "Fri 17 Oct, 17:00".
 *
 * @param item The item.
 * @param today `YYYY-MM-DD`.
 * @param minutes Minutes after midnight now; defaults to the current time.
 * @returns The text, or empty without a due date.
 */
export function dueText(item: DueItem, today: string, minutes: number = nowMinutes()): string {
  if (item.dueDate === null) return '';
  const state = dueState(item, today, minutes);
  const days = daysBetween(today, item.dueDate);
  const time = item.dueTime ?? null;
  const at = time === null ? '' : ` ${time}`;
  if (state === 'overdue') {
    if (days === 0) return `Overdue since ${time ?? ''}`.trim();
    return days === -1 ? '1 day overdue' : `${-days} days overdue`;
  }
  if (state === 'soon') {
    if (days === 0) return `Due today${at}`;
    if (days === 1) return `Due tomorrow${at}`;
    return `Due in ${days} days${time === null ? '' : `, ${time}`}`;
  }
  return `${shortDate(item.dueDate)}${time === null ? '' : `, ${time}`}`;
}

/** Fields an item edit can change, and so an undo can put back. */
const UNDOABLE = [
  'type',
  'title',
  'description',
  'parentId',
  'status',
  'priority',
  'sprintId',
  'teamId',
  'startDate',
  'dueDate',
  'dueTime',
  'assigneeIds',
  'labelIds',
] as const satisfies readonly (keyof UpdateItemRequest & keyof WorkItemDto)[];

/**
 * The PATCH that puts an item's fields back after a change (DESIGN §11
 * "Undo"): every undoable field whose value differs. Bucket and position
 * are not fields; see {@link revertMove}.
 *
 * @param before The item before the change.
 * @param after The item the server returned.
 * @returns The request, or null when no field changed.
 */
export function revertFields(before: WorkItemDto, after: WorkItemDto): UpdateItemRequest | null {
  const request: Record<string, unknown> = {};
  for (const key of UNDOABLE) {
    const a = before[key];
    const b = after[key];
    const same = Array.isArray(a) && Array.isArray(b) ? sameIds(a, b) : a === b;
    if (!same) request[key] = Array.isArray(a) ? [...a] : a;
  }
  return Object.keys(request).length === 0 ? null : request;
}

/**
 * The PATCH an Undo sends after any move back: the fields the change itself
 * altered (from `before` to `after`), plus the status when the move back ran
 * a bucket entry rule. Fields changed later, by anyone, are left alone.
 *
 * @param before The item before the change.
 * @param after The item the change produced.
 * @param current The item now, after any move back.
 * @returns The request, or null when nothing needs putting back.
 */
export function undoFields(
  before: WorkItemDto,
  after: WorkItemDto,
  current: WorkItemDto,
): UpdateItemRequest | null {
  const request: UpdateItemRequest = { ...revertFields(before, after) };
  if (current.status !== before.status) request.status = before.status;
  return Object.keys(request).length === 0 ? null : request;
}

/**
 * The move that puts a card back into its old bucket and place.
 *
 * @param before The item before the change.
 * @param after The item the server returned.
 * @param previousAfterId The card it followed before (null: it was on top).
 * @returns The request, or null when the bucket did not change and no place is known.
 */
export function revertMove(
  before: WorkItemDto,
  after: WorkItemDto,
  previousAfterId: string | null | undefined,
): MoveItemRequest | null {
  if (before.bucketId === after.bucketId && previousAfterId === undefined) return null;
  const request: MoveItemRequest = { afterId: previousAfterId ?? null };
  if (before.bucketId !== after.bucketId) request.bucketId = before.bucketId;
  return request;
}

/**
 * Compares two id lists as sets.
 *
 * @param a First list.
 * @param b Second list.
 * @returns True when they hold the same ids.
 */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}
