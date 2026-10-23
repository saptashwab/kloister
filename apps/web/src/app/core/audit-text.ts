import { formatMoment } from './format';

/** One readable line of an audit entry's details. */
export interface AuditDetail {
  /** What the value is, e.g. "Changed" or "Email". */
  label: string;
  /** The value as text. */
  value: string;
}

/** Labels for detail keys the API writes (SPEC §4 AuditLog `meta`). */
const KEY_LABELS: Record<string, string> = {
  email: 'Email',
  ip: 'IP address',
  reason: 'Reason',
  key: 'Setting',
  value: 'New value',
  file: 'File',
  via: 'Request',
  sessionId: 'Session',
  role: 'Role',
  systemRole: 'System role',
  title: 'Title',
  name: 'Name',
  lockedUntil: 'Locked until',
  sessionsEnded: 'Sessions ended',
  otherSessionsEnded: 'Other sessions ended',
  removed: 'Removed',
  fontReset: 'Font reset',
  trigger: 'Started by',
  size: 'Size',
  error: 'Error',
};

/** Readable names of changed fields. */
const FIELD_LABELS: Record<string, string> = {
  displayName: 'Display name',
  dueDate: 'Due date',
  dueTime: 'Due time',
  startDate: 'Start date',
  parentId: 'Parent',
  bucketId: 'Bucket',
  sprintId: 'Sprint',
  teamId: 'Team',
  assigneeIds: 'Assignees',
  labelIds: 'Labels',
  isActive: 'Active',
  systemRole: 'System role',
};

/** Keys that only identify people or rows already shown in the entry's columns. */
const HIDDEN = new Set(['userId']);

/**
 * Turns a key into words: `allowedBucketIds` → "Allowed bucket ids".
 *
 * @param key A detail key.
 * @returns Its label.
 */
function words(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A detail value as short text.
 *
 * @param value Any JSON value.
 * @returns Text; ISO timestamps are shown in the app's format.
 */
function text(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string')
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? formatMoment(value) : value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.map(text).join(', ');
  return JSON.stringify(value);
}

/**
 * The readable lines of an audit entry's details (M8.5): changed fields as
 * "Title: Old → New", known keys with their labels, other keys in words.
 * The raw JSON stays available separately.
 *
 * @param meta The entry's details.
 * @returns Lines in a stable order.
 */
export function auditDetails(meta: Record<string, unknown>): AuditDetail[] {
  const lines: AuditDetail[] = [];
  for (const [key, value] of Object.entries(meta)) {
    if (HIDDEN.has(key)) continue;
    if (key === 'changes' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [field, change] of Object.entries(value as Record<string, unknown>)) {
        const label = FIELD_LABELS[field] ?? words(field);
        const pair = change as { from?: unknown; to?: unknown } | null;
        lines.push({
          label: `Changed ${label.toLowerCase()}`,
          value:
            pair !== null && typeof pair === 'object' && ('from' in pair || 'to' in pair)
              ? `${text(pair.from)} → ${text(pair.to)}`
              : text(change),
        });
      }
      continue;
    }
    const label = KEY_LABELS[key] ?? words(key);
    const shown =
      key === 'sessionId' && typeof value === 'string' ? `${value.slice(0, 8)}…` : text(value);
    lines.push({ label, value: shown });
  }
  return lines;
}
