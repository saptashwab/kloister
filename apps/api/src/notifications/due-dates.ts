/** Overdue items are announced only while they became overdue at most this many days ago. */
export const OVERDUE_LOOKBACK_DAYS = 7;

/** The daily due-date check: every day at 09:00 server time (SPEC §6). */
export const DUE_DATE_CRON = '0 9 * * *';

/** Calendar days the daily check looks at, as `YYYY-MM-DD` in server time. */
export interface DueWindows {
  /** Items due on this day get "due tomorrow". */
  tomorrow: string;
  /** Earliest due date that still gets "overdue". */
  overdueFrom: string;
  /** Latest due date that gets "overdue" (yesterday). */
  overdueTo: string;
  /** Midnight at the start of today, server time. */
  startOfToday: Date;
  /** Today, whose items with a passed due time are also overdue (M8.5). */
  today: string;
  /** Minutes after midnight when the check runs, server time. */
  minutes: number;
}

/**
 * The server-local calendar date of a moment, shifted by whole days.
 *
 * @param now The moment.
 * @param offsetDays Days to add (negative for the past).
 * @returns `YYYY-MM-DD`.
 */
export function localDate(now: Date, offsetDays = 0): string {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/**
 * Works out which due dates the daily check notifies about. Due dates are
 * calendar days, and due times wall-clock times, compared with the server's
 * local clock, the same clock the 09:00 schedule runs on.
 *
 * @param now When the check runs.
 * @returns The windows.
 */
export function dueWindows(now: Date): DueWindows {
  return {
    tomorrow: localDate(now, 1),
    overdueFrom: localDate(now, -OVERDUE_LOOKBACK_DAYS),
    overdueTo: localDate(now, -1),
    startOfToday: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
    today: localDate(now),
    minutes: now.getHours() * 60 + now.getMinutes(),
  };
}
