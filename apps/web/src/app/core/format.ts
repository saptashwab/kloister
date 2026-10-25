/**
 * A file or folder size for people: bytes, KB, MB or GB with one decimal.
 *
 * @param bytes Size in bytes.
 * @returns E.g. "820 bytes", "14.2 KB", "3.1 MB", "12.4 GB".
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * A duration in minutes for people, in the largest whole unit that fits.
 *
 * @param minutes The duration.
 * @returns E.g. "45 minutes", "8 hours", "7 days", "1 day 12 hours".
 */
export function formatMinutes(minutes: number): string {
  const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (!Number.isFinite(minutes) || minutes < 60)
    return plural(Math.max(0, Math.round(minutes || 0)), 'minute');
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(plural(days, 'day'));
  if (hours > 0) parts.push(plural(hours, 'hour'));
  if (rest > 0) parts.push(plural(rest, 'minute'));
  return parts.join(' ');
}

/** Month abbreviations used by every displayed date (DESIGN §15, M8.5). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Full month names accepted when typing a date. */
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Two-digit padding.
 *
 * @param n A number below 100.
 * @returns E.g. "07".
 */
function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * A calendar date as the app shows it everywhere: "23 Oct 2026", which reads
 * the same in every locale.
 *
 * @param value `YYYY-MM-DD`, or a Date read in local time.
 * @returns The formatted date, or empty for an invalid value.
 */
export function formatDay(value: string | Date): string {
  const date =
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8)))
      : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/**
 * A moment in the viewer's time zone: "23 Oct 2026, 14:05" (24-hour).
 *
 * @param value ISO timestamp or Date.
 * @returns The formatted moment, or empty for an invalid value.
 */
export function formatMoment(value: string | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${formatDay(date)}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Reads a typed date: day first as `23/10/2026` (also `23-10-2026`,
 * `23.10.2026` or `3/1/2026`), `2026-10-23`, `23 Oct 2026` or
 * `23 October 2026` (month names in English, any case). Numeric dates are
 * always read day first (DESIGN §15), never month first.
 *
 * @param text What the person typed.
 * @returns `YYYY-MM-DD`, or null when it is not a real date.
 */
export function parseDay(text: string): string | null {
  const value = text.trim();
  let year: number, month: number, day: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  const named = /^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})$/.exec(value);
  // One separator used twice, so "23/10-2026" is not a date.
  const dayFirst = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/.exec(value);
  if (iso) {
    [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (dayFirst) {
    [year, month, day] = [Number(dayFirst[4]), Number(dayFirst[3]), Number(dayFirst[1])];
  } else if (named) {
    const name = named[2].toLowerCase();
    // The abbreviation or the full English name, nothing longer ("Octopus" is not a month).
    const index = MONTH_NAMES.findIndex(
      (full) => name === full.slice(0, 3).toLowerCase() || name === full.toLowerCase(),
    );
    if (index < 0) return null;
    [year, month, day] = [Number(named[3]), index + 1, Number(named[1])];
  } else return null;
  // Four-digit years only, so the result is always `YYYY-MM-DD`.
  if (year < 1000) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day)
    return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Reads a typed 24-hour time, `17:00` or `9:30`.
 *
 * @param text What the person typed.
 * @returns `HH:MM`, or null.
 */
export function parseTime(text: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  return hours < 24 && minutes < 60 ? `${pad(hours)}:${pad(minutes)}` : null;
}

/**
 * A Date's local calendar day as `YYYY-MM-DD`.
 *
 * @param date The date.
 * @returns The wire date.
 */
export function dayOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
