import { ItemStatus } from './items.js';

/**
 * Due dates with an optional time of day (SPEC §4 `dueTime`, M8.5).
 *
 * The time is a wall-clock value with no time zone, read like the due date
 * itself: in the viewer's calendar in the browser and in server time on the
 * server. On the wire it is `HH:MM`; in the database, minutes after midnight.
 */

/** Wire format of a due time: 24-hour `HH:MM`. */
export const DUE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Fields the due rules read. */
export interface DueFields {
  /** `YYYY-MM-DD`, or null. */
  dueDate: string | null;
  /** `HH:MM`, or null for no time. Optional so older payloads still fit. */
  dueTime?: string | null;
  /** Current status; Done items are never overdue. */
  status: ItemStatus;
}

/** A moment in the same wall-clock terms as due dates. */
export interface DueNow {
  /** Today as `YYYY-MM-DD`. */
  date: string;
  /** Minutes after midnight. */
  minutes: number;
}

/**
 * Converts a wire due time to minutes after midnight.
 *
 * @param time `HH:MM`.
 * @returns Minutes (0–1439).
 */
export function dueTimeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number) as [number, number];
  return hours * 60 + minutes;
}

/**
 * Converts minutes after midnight to the wire due time.
 *
 * @param minutes Minutes (0–1439).
 * @returns `HH:MM`.
 */
export function minutesToDueTime(minutes: number): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/**
 * The current moment in wall-clock terms, for {@link isOverdueAt}.
 *
 * @param date The moment, read in the local time zone of the caller.
 * @returns Today and minutes after midnight.
 */
export function dueNow(date: Date): DueNow {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    minutes: date.getHours() * 60 + date.getMinutes(),
  };
}

/**
 * Whether an unfinished item is overdue: past its due time on its due day,
 * or, without a time, from the day after its due date.
 *
 * @param item Due fields.
 * @param now Current moment.
 * @returns True when overdue.
 */
export function isOverdueAt(item: DueFields, now: DueNow): boolean {
  if (item.dueDate === null || item.status === ItemStatus.DONE) return false;
  if (item.dueDate < now.date) return true;
  if (item.dueDate > now.date || item.dueTime === null || item.dueTime === undefined) return false;
  return now.minutes > dueTimeToMinutes(item.dueTime);
}
