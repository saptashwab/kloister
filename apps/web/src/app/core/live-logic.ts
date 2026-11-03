import {
  PRESENCE_FIELDS,
  PRESENCE_VIEWS,
  PresenceAction,
  type PresenceEntryDto,
  type ProjectMemberDto,
  type ProjectRole,
  type WorkItemDto,
} from '@kloister/shared';

/**
 * Pure helpers for live updates and presence (M10 plan sections 4.1 to
 * 4.5): the words people read, and the field comparisons behind the
 * "Keep mine / Use theirs" notice.
 */

/** Short role names for the conflict notice, e.g. "Pat (PM)". */
const SHORT_ROLES: Record<ProjectRole, string> = {
  PM: 'PM',
  LEAD: 'Lead',
  MEMBER: 'Member',
  VIEWER: 'Viewer',
};

/** How long a changed card stays highlighted, in milliseconds. */
export const HIGHLIGHT_MS = 1_200;

/** How long "Changed by … just now" stays in a card's tooltip, in milliseconds. */
export const CHANGED_TEXT_MS = 60_000;

/**
 * The name of a person for live texts.
 *
 * @param members Project members by user id.
 * @param userId The person, or null for the system.
 * @returns Their display name, or "Someone".
 */
export function personName(
  members: ReadonlyMap<string, ProjectMemberDto>,
  userId: string | null,
): string {
  return (userId === null ? undefined : members.get(userId)?.displayName) ?? 'Someone';
}

/**
 * The name of a person with their project role, for the conflict notice:
 * no role outranks another, so the notice names it to make the choice a
 * knowing one (M10 plan section 4.3).
 *
 * @param members Project members by user id.
 * @param userId The person.
 * @returns E.g. "Pat (PM)".
 */
export function personWithRole(
  members: ReadonlyMap<string, ProjectMemberDto>,
  userId: string | null,
): string {
  const member = userId === null ? undefined : members.get(userId);
  return member === undefined
    ? personName(members, userId)
    : `${member.displayName} (${SHORT_ROLES[member.role]})`;
}

/**
 * What one person is doing, in plain words.
 *
 * @param entry Their presence.
 * @param name Their name.
 * @param what "this card", "this bar" or "this item", for moving.
 * @returns E.g. "Ann is editing the due date".
 */
export function presenceSentence(
  entry: PresenceEntryDto,
  name: string,
  what = 'this item',
): string {
  switch (entry.action) {
    case PresenceAction.EDITING:
      return `${name} is editing ${entry.field === null ? 'this item' : PRESENCE_FIELDS[entry.field]}`;
    case PresenceAction.MOVING:
      return `${name} is moving ${what}`;
    case PresenceAction.NOTING:
      return `${name} is writing a note`;
    default:
      return `${name} is viewing`;
  }
}

/**
 * Several people's presence on one item, joined with a middle dot.
 *
 * @param entries Their presence.
 * @param members Project members by user id.
 * @param what Word for the thing being moved.
 * @returns E.g. "Ann is editing the due date · Bo is viewing".
 */
export function presenceLine(
  entries: readonly PresenceEntryDto[],
  members: ReadonlyMap<string, ProjectMemberDto>,
  what = 'this item',
): string {
  return entries.map((e) => presenceSentence(e, personName(members, e.userId), what)).join(' · ');
}

/**
 * The fields each editable thing writes, for deciding whether a change
 * that arrived during an edit touched the same thing.
 */
export const CONFLICT_FIELDS = {
  title: ['title'],
  description: ['description'],
  status: ['status'],
  bucket: ['bucketId'],
  assignees: ['assigneeIds', 'assigneeShares'],
  labels: ['labelIds'],
  sprint: ['sprintId'],
  priority: ['priority'],
  team: ['teamId'],
  parent: ['parentId'],
  type: ['type'],
  dueTime: ['dueTime'],
  dates: ['startDate', 'startSecondHalf', 'dueDate', 'dueFirstHalf'],
} as const satisfies Record<string, readonly (keyof WorkItemDto)[]>;

/** One of the {@link CONFLICT_FIELDS} keys. */
export type ConflictField = keyof typeof CONFLICT_FIELDS;

/**
 * Whether someone else changed the given fields between two copies of an
 * item.
 *
 * @param base The copy the edit started from.
 * @param fresh The current copy.
 * @param fields The fields the edit writes.
 * @returns True when any of them differs.
 */
export function changedFields(
  base: WorkItemDto,
  fresh: WorkItemDto,
  fields: readonly (keyof WorkItemDto)[],
): boolean {
  return fields.some((f) => JSON.stringify(base[f]) !== JSON.stringify(fresh[f]));
}

/**
 * The highlight tooltip of a changed card or row.
 *
 * @param name Who changed it.
 * @param moved True when it changed bucket.
 * @returns E.g. "Moved by Ann just now".
 */
export function changedText(name: string, moved: boolean): string {
  return `${moved ? 'Moved' : 'Changed'} by ${name} just now`;
}

/**
 * Up to four people for a header, and how many more there are.
 *
 * @param userIds The people.
 * @param max How many to show.
 * @returns The shown ones and the rest's count.
 */
export function headPeople(userIds: readonly string[], max = 4): { shown: string[]; more: number } {
  return { shown: userIds.slice(0, max), more: Math.max(0, userIds.length - max) };
}

/**
 * Whether an action shows strongly (DESIGN §9.1): editing, moving and
 * writing a note do; viewing is faint.
 *
 * @param action The action.
 * @returns True for a strong mark.
 */
export function isStrong(action: PresenceAction | null): boolean {
  return (
    action === PresenceAction.EDITING ||
    action === PresenceAction.MOVING ||
    action === PresenceAction.NOTING
  );
}

/**
 * The person whose mark a field, cell, card or row shows: the first strong
 * entry, else the first one. Entries are returned as given, so a template
 * binding keeps its value until presence changes.
 *
 * @param entries Presence on the item, if any.
 * @param accept Which entries belong to this place; all by default.
 * @returns The entry, or null.
 */
export function leadPresence(
  entries: readonly PresenceEntryDto[] | undefined,
  accept: (entry: PresenceEntryDto) => boolean = () => true,
): PresenceEntryDto | null {
  let first: PresenceEntryDto | null = null;
  for (const entry of entries ?? []) {
    if (!accept(entry)) continue;
    if (isStrong(entry.action)) return entry;
    first ??= entry;
  }
  return first;
}

/**
 * The short name on a presence tag: the first word of the display name.
 *
 * @param name The display name.
 * @returns E.g. "Ann" for "Ann Lee".
 */
export function tagName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** The item a header hover card names. */
export interface PresenceItemRef {
  /** E.g. "KLO-42". */
  key: string;
  /** The title. */
  title: string;
}

/**
 * What a person is doing, for their header hover card (DESIGN §9.1).
 *
 * @param entry Their presence.
 * @param name Their name.
 * @param item The item they have open, when the viewer has it.
 * @returns E.g. "Ann is editing the due date of KLO-42 · Fix login", "Di is
 *   moving 3 rows", or "Viewing the timeline" without an item.
 */
export function presenceDoing(
  entry: PresenceEntryDto,
  name: string,
  item: PresenceItemRef | null,
): string {
  // Rows moved together (v1.4.1): the count of those the viewer can see.
  const rows = entry.itemIds?.length ?? 0;
  if (entry.action === PresenceAction.MOVING && rows > 1) return `${name} is moving ${rows} rows`;
  if (entry.itemId === null || item === null) {
    if (entry.itemId !== null) return presenceSentence(entry, name);
    return entry.view === null ? 'On this project' : `Viewing ${PRESENCE_VIEWS[entry.view]}`;
  }
  const what = `${item.key} · ${item.title}`;
  switch (entry.action) {
    case PresenceAction.EDITING:
      return entry.field === null
        ? `${name} is editing ${what}`
        : `${name} is editing ${PRESENCE_FIELDS[entry.field]} of ${what}`;
    case PresenceAction.MOVING:
      return `${name} is moving ${what}`;
    case PresenceAction.NOTING:
      return `${name} is writing a note on ${what}`;
    default:
      return `${name} is viewing ${what}`;
  }
}

/** Project tabs whose routes have an item drawer. */
const DRAWER_TABS: ReadonlySet<string> = new Set(['backlog', 'timeline', 'calendar']);

/**
 * Where an item's drawer opens from a project tab: beside that tab when it
 * has a drawer, else beside the board.
 *
 * @param projectKey The project key.
 * @param tab The current tab (`''` for the board).
 * @param itemNumber The item number.
 * @returns Router commands.
 */
export function drawerPath(projectKey: string, tab: string, itemNumber: number): unknown[] {
  return DRAWER_TABS.has(tab)
    ? ['/p', projectKey, tab, 'items', itemNumber]
    : ['/p', projectKey, 'items', itemNumber];
}
