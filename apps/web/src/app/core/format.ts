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
