import { AuditAction, type AuditEntryDto, type ItemStatus, type ItemType } from '@kloister/shared';
import { PRIORITY_LABELS, STATUS_LABELS, TYPE_LABELS } from './labels';

/** Resolves ids in activity entries to names; unknown ids return null. */
export interface ActivityNames {
  /** Bucket name. */
  bucket(id: string): string | null;
  /** Sprint name. */
  sprint(id: string): string | null;
  /** Member display name. */
  member(id: string): string | null;
  /** Label name. */
  label(id: string): string | null;
  /** Team name. */
  team(id: string): string | null;
  /** Item key such as `KLO-4`, for visible items. */
  item(id: string): string | null;
}

/** Field names shown in "changed …" lines. */
const FIELD_LABELS: Record<string, string> = {
  type: 'type',
  title: 'title',
  description: 'description',
  parentId: 'parent',
  status: 'status',
  priority: 'priority',
  startDate: 'start date',
  dueDate: 'due date',
  sprintId: 'sprint',
  teamId: 'team',
  bucketId: 'bucket',
  assigneeIds: 'assignees',
  labelIds: 'labels',
};

/**
 * Reports whether a value is a plain object.
 *
 * @param value Anything.
 * @returns True for non-null, non-array objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Turns a recorded scalar into text.
 *
 * @param value A recorded value.
 * @returns Its text, or an empty string for anything but a scalar.
 */
function scalar(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
}

/**
 * Formats one side of a field change.
 *
 * @param field Changed field.
 * @param value Old or new value.
 * @param names Id lookups.
 * @returns Display text.
 */
function formatValue(field: string, value: unknown, names: ActivityNames): string {
  if (value === null || value === undefined || value === '') return 'none';
  const name = (id: unknown, lookup: (id: string) => string | null, hidden = 'unknown') =>
    typeof id === 'string' ? (lookup(id) ?? hidden) : hidden;
  switch (field) {
    case 'status':
      return STATUS_LABELS[value as ItemStatus] ?? scalar(value);
    case 'type':
      return TYPE_LABELS[value as ItemType] ?? scalar(value);
    case 'priority':
      return PRIORITY_LABELS[value as number] ?? scalar(value);
    case 'bucketId':
      return name(value, names.bucket.bind(names), 'a deleted bucket');
    case 'sprintId':
      return name(value, names.sprint.bind(names), 'a deleted sprint');
    case 'teamId':
      return name(value, names.team.bind(names), 'a deleted team');
    case 'parentId':
      return name(value, names.item.bind(names), 'another item');
    case 'assigneeIds':
    case 'labelIds': {
      if (!Array.isArray(value) || value.length === 0) return 'none';
      const lookup = field === 'labelIds' ? names.label.bind(names) : names.member.bind(names);
      return value.map((id) => name(id, lookup, 'someone')).join(', ');
    }
    default:
      return scalar(value);
  }
}

/**
 * Describes field changes recorded as `{ field: { from, to } }`.
 *
 * @param changes The recorded changes.
 * @param names Id lookups.
 * @returns One line per field.
 */
function describeChanges(changes: unknown, names: ActivityNames): string[] {
  if (!isRecord(changes)) return [];
  return Object.entries(changes).map(([field, change]) => {
    const label = FIELD_LABELS[field] ?? field;
    // Descriptions are recorded without their text (they can be long).
    if (field === 'description' || !isRecord(change)) return `changed the ${label}`;
    if (field === 'parentId' && change['to'] === null && change['from'] === null) {
      return 'changed the parent';
    }
    return `changed the ${label} from ${formatValue(field, change['from'], names)} to ${formatValue(field, change['to'], names)}`;
  });
}

/**
 * Turns an item's audit entry into readable lines for the activity history
 * (SPEC §6). References the API redacted (items outside the caller's scope)
 * arrive as null and are shown as "another item".
 *
 * @param entry The audit entry.
 * @param names Id lookups.
 * @returns Lines describing what happened.
 */
export function describeActivity(entry: AuditEntryDto, names: ActivityNames): string[] {
  const meta = entry.meta;
  const blocker = () => {
    const id = meta['blockingItemId'];
    return typeof id === 'string' ? (names.item(id) ?? 'another item') : 'another item';
  };
  switch (entry.action) {
    case AuditAction.ITEM_CREATED:
      return [`created this ${TYPE_LABELS[meta['type'] as ItemType] ?? 'item'}`];
    case AuditAction.ITEM_UPDATED:
      return describeChanges(meta['changes'], names);
    case AuditAction.ITEM_MOVED: {
      const from = formatValue('bucketId', meta['from'], names);
      const to = formatValue('bucketId', meta['to'], names);
      const status = isRecord(meta['status'])
        ? describeChanges({ status: meta['status'] }, names)
        : [];
      return [`moved the card from ${from} to ${to}`, ...status];
    }
    case AuditAction.CHECKLIST_ITEM_ADDED:
      return [`added checklist line “${scalar(meta['text'])}”`];
    case AuditAction.CHECKLIST_ITEM_REMOVED:
      return [`removed checklist line “${scalar(meta['text'])}”`];
    case AuditAction.CHECKLIST_ITEM_UPDATED: {
      const changes = isRecord(meta['changes']) ? meta['changes'] : {};
      const lines: string[] = [];
      const done = changes['done'];
      if (isRecord(done))
        lines.push(done['to'] === true ? 'ticked a checklist line' : 'unticked a checklist line');
      const text = changes['text'];
      if (isRecord(text))
        lines.push(`renamed checklist line “${scalar(text['from'])}” to “${scalar(text['to'])}”`);
      return lines.length > 0 ? lines : ['edited the checklist'];
    }
    case AuditAction.DEPENDENCY_ADDED:
      return [`marked this as blocked by ${blocker()}`];
    case AuditAction.DEPENDENCY_REMOVED:
      return [`removed the block by ${blocker()}`];
    default:
      return [entry.action.toLowerCase().replaceAll('_', ' ')];
  }
}
