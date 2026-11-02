/**
 * Live updates and presence (M10): the Server-Sent Events stream at
 * `GET /events` and its control routes. Events carry ids only; the web app
 * refetches what changed through the normal, scoped API.
 */

/** How often the stream sends a heartbeat comment, in milliseconds. */
export const LIVE_HEARTBEAT_MS = 25_000;

/** Most open streams per user; opening another closes the oldest. */
export const LIVE_MAX_STREAMS_PER_USER = 10;

/** Most item ids in one `ids` filter of the item list. */
export const ITEM_IDS_FILTER_MAX = 100;

/** Items changed by one transaction above which a project resync is sent instead. */
export const LIVE_RESYNC_THRESHOLD = 200;

/** How long someone must stay before others see their presence, in milliseconds. */
export const PRESENCE_DELAY_MS = 2_000;

/** How often the web app may report presence, in milliseconds. */
export const PRESENCE_THROTTLE_MS = 1_000;

/** What a person is doing on an item (M10 plan section 4.5). */
export const PresenceAction = {
  /** The item's details are open. */
  VIEWING: 'viewing',
  /** A field or grid cell is being edited; `field` names it. */
  EDITING: 'editing',
  /** A card or bar is being dragged. */
  MOVING: 'moving',
  /** A note is being written. */
  NOTING: 'noting',
} as const;

/** One of the {@link PresenceAction} values. */
export type PresenceAction = (typeof PresenceAction)[keyof typeof PresenceAction];

/**
 * Fields presence may name, with the words shown to others ("Ann is editing
 * the due date"). Only these keys are accepted, so no free text travels.
 */
export const PRESENCE_FIELDS = {
  title: 'the title',
  description: 'the description',
  type: 'the type',
  status: 'the status',
  priority: 'the priority',
  bucket: 'the bucket',
  sprint: 'the sprint',
  team: 'the team',
  parent: 'the parent',
  assignees: 'the assignees',
  labels: 'the labels',
  startDate: 'the start date',
  dueDate: 'the due date',
  dueTime: 'the due time',
  duration: 'the duration',
  checklist: 'the checklist',
  dependencies: 'the dependencies',
} as const;

/** One of the {@link PRESENCE_FIELDS} keys. */
export type PresenceField = keyof typeof PRESENCE_FIELDS;

/** Names of the events sent on the stream. */
export const LiveEvent = {
  /** First event; carries the stream id for the control routes. */
  HELLO: 'hello',
  /** Visible items were created or changed. */
  ITEM_CHANGED: 'item-changed',
  /** Items were deleted or left the viewer's scope. */
  ITEM_REMOVED: 'item-removed',
  /** Dependency links between visible items changed. */
  LINKS_CHANGED: 'links-changed',
  /** Buckets, labels, sprints or holidays changed (team changes send `access-changed`). */
  BOARD_CHANGED: 'board-changed',
  /** Members, roles, teams or project settings changed; reload the project. */
  ACCESS_CHANGED: 'access-changed',
  /** The viewer received a notification. */
  NOTIFICATION: 'notification',
  /** Who else is on the subscribed project, and what they are doing. */
  PRESENCE: 'presence',
  /** Too much changed at once; reload the subscribed project. */
  PROJECT_RESYNC: 'project-resync',
  /** Events may have been missed; reload what is open. */
  RESYNC: 'resync',
  /** An admin switched live updates off; the stream ends and must not reopen. */
  DISABLED: 'disabled',
} as const;

/** One of the {@link LiveEvent} names. */
export type LiveEvent = (typeof LiveEvent)[keyof typeof LiveEvent];

/** Data of `hello`. */
export interface LiveHelloDto {
  /** Id for `PUT /events/:streamId/...`. */
  streamId: string;
}

/** One changed or removed item, with who changed it. */
export interface LiveItemDto {
  /** Item id. */
  id: string;
  /** Who made the change; null for the system (scheduled jobs). */
  actorId: string | null;
  /** On `item-removed`: true when deleted, false when it left the viewer's scope. */
  deleted?: boolean;
}

/** Data of `item-changed` and `item-removed`. */
export interface LiveItemsDto {
  /** The subscribed project. */
  projectId: string;
  /** The items. */
  items: LiveItemDto[];
}

/** Data of `links-changed`. */
export interface LiveLinksDto {
  /** The subscribed project. */
  projectId: string;
  /** Items at either end of the changed links; all visible to the viewer. */
  ids: string[];
}

/** Data of `board-changed`, `access-changed` and `project-resync`. */
export interface LiveProjectDto {
  /** The project. */
  projectId: string;
}

/** One person on the subscribed project. */
export interface PresenceEntryDto {
  /** The person (a project member). */
  userId: string;
  /** The item they have open, or null when only on the project's pages. */
  itemId: string | null;
  /** What they are doing on that item; null without an item. */
  action: PresenceAction | null;
  /** The field they are editing, with `editing` only. */
  field: PresenceField | null;
}

/** Data of `presence`: everyone else on the project, as the viewer may see them. */
export interface LivePresenceDto {
  /** The subscribed project. */
  projectId: string;
  /** One entry per person, their most recent action. */
  people: PresenceEntryDto[];
}

/** Body of `PUT /events/:streamId/project`. */
export interface LiveSubscribeRequest {
  /** Project id or key to follow, or null for none. */
  projectId: string | null;
}

/** Body of `PUT /events/:streamId/presence`. */
export interface LivePresenceRequest {
  /** Item the tab has open, or null. */
  itemId: string | null;
  /** What the tab is doing on it; null without an item. */
  action: PresenceAction | null;
  /** Field being edited, with `editing` only. */
  field: PresenceField | null;
}

/** Answer of `GET /events/status`. */
export interface LiveStatusDto {
  /** False when an admin switched live updates off. */
  enabled: boolean;
}

/** Admin setting "Live updates" (`GET`/`PUT /admin/settings/live`). */
export interface LiveSettingsDto {
  /** Whether streams are accepted; default true. */
  enabled: boolean;
}
