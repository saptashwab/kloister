/** Work item types (SPEC §4). */
export const ItemType = {
  EPIC: 'EPIC',
  FEATURE: 'FEATURE',
  STORY: 'STORY',
  TASK: 'TASK',
  BUG: 'BUG',
} as const;

/** One of the {@link ItemType} values. */
export type ItemType = (typeof ItemType)[keyof typeof ItemType];

/** Work item status; independent of the bucket (SPEC §4.2). */
export const ItemStatus = {
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  BLOCKED: 'BLOCKED',
  DONE: 'DONE',
} as const;

/** One of the {@link ItemStatus} values. */
export type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus];

/** What moving a card into a bucket does to its status (SPEC §4.2). */
export const BucketRule = {
  /** No change. */
  NONE: 'NONE',
  /** Set the status to the bucket's `onEnterStatus`. */
  SET: 'SET',
  /** Set it only if the current status is `NOT_STARTED`. */
  SET_IF_NOT_STARTED: 'SET_IF_NOT_STARTED',
} as const;

/** One of the {@link BucketRule} values. */
export type BucketRule = (typeof BucketRule)[keyof typeof BucketRule];

/** Sprint lifecycle. A project has at most one `ACTIVE` sprint. */
export const SprintState = {
  PLANNED: 'PLANNED',
  ACTIVE: 'ACTIVE',
  CLOSED: 'CLOSED',
} as const;

/** One of the {@link SprintState} values. */
export type SprintState = (typeof SprintState)[keyof typeof SprintState];

/**
 * Allowed parent types per item type (SPEC §4.1). Any item may also have no
 * parent; Epics never have one.
 */
export const ALLOWED_PARENT_TYPES: Record<ItemType, readonly ItemType[]> = {
  EPIC: [],
  FEATURE: [ItemType.EPIC],
  STORY: [ItemType.FEATURE],
  TASK: [ItemType.STORY, ItemType.FEATURE],
  BUG: [ItemType.STORY, ItemType.FEATURE],
};

/**
 * Reports whether an item of one type may sit under a parent of another
 * (SPEC §4.1).
 *
 * @param child The child's type.
 * @param parent The parent's type.
 * @returns True if the link is allowed.
 */
export function isAllowedParent(child: ItemType, parent: ItemType): boolean {
  return ALLOWED_PARENT_TYPES[child].includes(parent);
}

/**
 * Reports whether an item type has a sprint of its own (M12): Epics and
 * Features show their children's sprints instead.
 *
 * @param type The item type.
 * @returns True for STORY, TASK and BUG.
 */
export function hasOwnSprint(type: ItemType): boolean {
  return type !== ItemType.EPIC && type !== ItemType.FEATURE;
}

/**
 * Reports whether an item type may be ad hoc (M12): only types that never
 * have children, Tasks and Bugs.
 *
 * @param type The item type.
 * @returns True for TASK and BUG.
 */
export function mayBeAdHoc(type: ItemType): boolean {
  return type === ItemType.TASK || type === ItemType.BUG;
}

/**
 * Reports whether an item type must be in a bucket (SPEC §4): Stories, Tasks
 * and Bugs always are; Epics and Features may stay off the board.
 *
 * @param type The item type.
 * @returns True for STORY, TASK and BUG.
 */
export function requiresBucket(type: ItemType): boolean {
  return type !== ItemType.EPIC && type !== ItemType.FEATURE;
}

/** Highest priority value. */
export const PRIORITY_MIN = 1;

/** Lowest priority value. */
export const PRIORITY_MAX = 4;

/** Priority of a new item when none is given. */
export const DEFAULT_PRIORITY = 2;

/** Longest item title accepted. */
export const ITEM_TITLE_MAX = 255;

/** Longest item description accepted, in characters of (sanitized) HTML. */
export const ITEM_DESCRIPTION_MAX = 100_000;

/** Most assignees one item can have. */
export const MAX_ASSIGNEES = 20;

/** Most labels one item can have. */
export const MAX_ITEM_LABELS = 50;

/** Longest bucket, label and sprint name accepted. */
export const BOARD_NAME_MAX = 100;

/** Longest checklist line accepted. */
export const CHECKLIST_TEXT_MAX = 500;

/** Longest sprint ADO iteration path accepted. */
export const ITERATION_PATH_MAX = 4000;

/** Label colours: `#rrggbb`. */
export const LABEL_COLOUR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Calendar dates on the wire: `YYYY-MM-DD`. */
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A default bucket of a new project. */
export interface DefaultBucket {
  /** Bucket name. */
  name: string;
  /** Entry rule. */
  onEnterMode: BucketRule;
  /** Status set by the rule, or null for `NONE`. */
  onEnterStatus: ItemStatus | null;
}

/** Buckets every new project starts with, in order (SPEC §4.2). */
export const DEFAULT_BUCKETS: readonly DefaultBucket[] = [
  { name: 'Backlog', onEnterMode: BucketRule.NONE, onEnterStatus: null },
  { name: 'To Do', onEnterMode: BucketRule.NONE, onEnterStatus: null },
  {
    name: 'In Progress',
    onEnterMode: BucketRule.SET_IF_NOT_STARTED,
    onEnterStatus: ItemStatus.IN_PROGRESS,
  },
  { name: 'Done', onEnterMode: BucketRule.SET, onEnterStatus: ItemStatus.DONE },
];

/**
 * A reference to an item: enough to show it as a read-only title. Ancestors
 * outside a restricted visibility scope are returned only in this form
 * (SPEC §3.3).
 */
export interface ItemRefDto {
  /** Item id (uuid). */
  id: string;
  /** Per-project number. */
  number: number;
  /** Display key, e.g. `KLO-42`. */
  key: string;
  /** Item type. */
  type: ItemType;
  /** Title. */
  title: string;
}

/** What the caller may do with an item; the UI uses this only to hide controls. */
export interface ItemCapabilitiesDto {
  /** Edit fields, checklist and labels. */
  edit: boolean;
  /**
   * Change the title, type, parent, sprint, dates, half days, pin and
   * dependencies (M9.2): `edit` unless the project keeps the plan to PMs
   * and Leads.
   */
  plan: boolean;
  /** Move the card between and within buckets. */
  move: boolean;
  /** Delete the item (without cascade). */
  delete: boolean;
  /** Delete the item with all its descendants. */
  deleteCascade: boolean;
  /** Add notes and attachments (M5). */
  annotate: boolean;
}

/** A work item as returned by list endpoints. */
export interface WorkItemDto {
  /** Item id (uuid). */
  id: string;
  /** Per-project number. */
  number: number;
  /** Display key, e.g. `KLO-42`. */
  key: string;
  /** Item type. */
  type: ItemType;
  /** Parent item id, or null. */
  parentId: string | null;
  /** Ancestors from the root down to the parent, as read-only titles. */
  ancestors: ItemRefDto[];
  /** Title. */
  title: string;
  /** Sanitized HTML. */
  description: string;
  /** Status. */
  status: ItemStatus;
  /** 1 (highest) to 4. */
  priority: number;
  /** Bucket id; null only for Epics and Features off the board. */
  bucketId: string | null;
  /** Sprint id, or null. */
  sprintId: string | null;
  /** Team id, or null. */
  teamId: string | null;
  /** `YYYY-MM-DD`, or null. */
  startDate: string | null;
  /** The item starts in the 2nd half of its start date (timeline, M9). */
  startSecondHalf: boolean;
  /** `YYYY-MM-DD`, or null. */
  dueDate: string | null;
  /** The item finishes after the 1st half of its due date (timeline, M9). */
  dueFirstHalf: boolean;
  /** Optional due time `HH:MM` on the due date, or null (M8.5). */
  dueTime: string | null;
  /** "Start no earlier than" pin set on the timeline, or null (M9). */
  startNoEarlierThan: { date: string; second: boolean } | null;
  /** Order within the bucket, ascending. */
  position: number;
  /** Creator's user id. */
  createdById: string;
  /** Assignee user ids. */
  assigneeIds: string[];
  /** Label ids. */
  labelIds: string[];
  /** Checklist progress, e.g. 3 of 7. */
  checklist: { done: number; total: number };
  /** Number of child items (in any scope). */
  childCount: number;
  /** Tracked but not part of the plan: no parent, children or links, not on the timeline (M12). */
  adHoc: boolean;
  /** ISO timestamp when the status became DONE, or null. */
  completedAt: string | null;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of the last change. */
  updatedAt: string;
  /** What the caller may do with this item. */
  can: ItemCapabilitiesDto;
}

/** One checklist line. */
export interface ChecklistItemDto {
  /** Checklist line id (uuid). */
  id: string;
  /** Text. */
  text: string;
  /** Ticked. */
  done: boolean;
  /** Order, ascending. */
  position: number;
}

/** A work item with its checklist and dependencies, from `GET …/items/:item`. */
export interface WorkItemDetailDto extends WorkItemDto {
  /** Checklist lines in order. */
  checklistItems: ChecklistItemDto[];
  /** Visible items this one is blocked by. */
  blockedBy: ItemRefDto[];
  /** Visible items this one blocks. */
  blocks: ItemRefDto[];
}

/** Body of `POST /projects/:id/items`. */
export interface CreateItemRequest {
  /** Item type. */
  type: ItemType;
  /** Title. */
  title: string;
  /** HTML; sanitized by the server. */
  description?: string;
  /** Parent item id (SPEC §4.1). */
  parentId?: string | null;
  /** Initial status; when omitted, the bucket's entry rule decides. */
  status?: ItemStatus;
  /** 1 (highest) to 4; default 2. */
  priority?: number;
  /**
   * Bucket. Stories, Tasks and Bugs without one start in the project's
   * "New items start in" bucket (M12). New cards go to the top.
   */
  bucketId?: string | null;
  /**
   * Sprint (not closed); never on Epics and Features (M12). A child of a Story
   * starts in its Story's sprint when omitted.
   */
  sprintId?: string | null;
  /** Ad hoc: not part of the plan (Tasks and Bugs without parent only, M12). */
  adHoc?: boolean;
  /** Team (SPEC §3.5). */
  teamId?: string | null;
  /** `YYYY-MM-DD`. */
  startDate?: string | null;
  /** Starts in the 2nd half of the start date; default false (M9). */
  startSecondHalf?: boolean;
  /** `YYYY-MM-DD`. */
  dueDate?: string | null;
  /** Finishes after the 1st half of the due date; default false (M9). */
  dueFirstHalf?: boolean;
  /** `HH:MM` on the due date; needs a due date. */
  dueTime?: string | null;
  /** Assignees: project members. */
  assigneeIds?: string[];
  /** Labels of the project. */
  labelIds?: string[];
}

/**
 * Body of `PATCH /projects/:id/items/:item`. Omitted fields stay unchanged;
 * nullable fields are cleared with `null`. The bucket changes only through
 * the move endpoint.
 */
export interface UpdateItemRequest {
  /** New type; must fit the parent and the children (SPEC §4.1). */
  type?: ItemType;
  /** New title. */
  title?: string;
  /** New description (HTML; sanitized). */
  description?: string;
  /** New parent, or null for none. */
  parentId?: string | null;
  /** New status; moves the card when the project maps the status to a bucket. */
  status?: ItemStatus;
  /** New priority. */
  priority?: number;
  /**
   * New sprint, or null; never on Epics and Features. A Story's Tasks and Bugs
   * in its old sprint (or none) follow it (M12).
   */
  sprintId?: string | null;
  /** Make the item ad hoc or plan it again (a plan change, M12). */
  adHoc?: boolean;
  /** New team, or null. */
  teamId?: string | null;
  /** New start date, or null. */
  startDate?: string | null;
  /** Starts in the 2nd half of the start date (M9); reset when the start date is cleared. */
  startSecondHalf?: boolean;
  /** New due date, or null; clearing it also clears the due time. */
  dueDate?: string | null;
  /** Finishes after the 1st half of the due date (M9); reset when the due date is cleared. */
  dueFirstHalf?: boolean;
  /** New due time `HH:MM`, or null; needs a due date. */
  dueTime?: string | null;
  /** The full new assignee list. */
  assigneeIds?: string[];
  /** The full new label list. */
  labelIds?: string[];
}

/** Body of `POST /projects/:id/items/:item/move`. */
export interface MoveItemRequest {
  /**
   * Target bucket. Omit to reorder within the current bucket; `null` takes
   * an Epic or Feature off the board.
   */
  bucketId?: string | null;
  /** Place the card right after this item of the target bucket; omit or null for the top. */
  afterId?: string | null;
}

/** Body of `POST /projects/:id/items/:item/dependencies`. */
export interface AddDependencyRequest {
  /** The item that blocks this one. */
  blockingItemId: string;
}

/** Body of `POST /projects/:id/items/:item/checklist`. */
export interface CreateChecklistItemRequest {
  /** Text. */
  text: string;
  /** Initially ticked; default false. */
  done?: boolean;
}

/** Body of `PATCH /projects/:id/items/:item/checklist/:lineId`. */
export interface UpdateChecklistItemRequest {
  /** New text. */
  text?: string;
  /** Tick or untick. */
  done?: boolean;
}

/** Body of the reorder endpoints for buckets and checklist lines. */
export interface ReorderRequest {
  /** Place the row right after this one; omit or null for the first place. */
  afterId?: string | null;
}

/** A bucket as returned by `GET /projects/:id/buckets`. */
export interface BucketDto {
  /** Bucket id (uuid). */
  id: string;
  /** Name. */
  name: string;
  /** Column order, ascending. */
  position: number;
  /** Entry rule. */
  onEnterMode: BucketRule;
  /** Status set by the rule, or null for `NONE`. */
  onEnterStatus: ItemStatus | null;
}

/** Body of `POST /projects/:id/buckets`. New buckets go last. */
export interface CreateBucketRequest {
  /** Name. */
  name: string;
  /** Entry rule; default `NONE`. */
  onEnterMode?: BucketRule;
  /** Required for `SET` and `SET_IF_NOT_STARTED`; must be omitted or null for `NONE`. */
  onEnterStatus?: ItemStatus | null;
}

/** Body of `PATCH /projects/:id/buckets/:bucketId`. */
export interface UpdateBucketRequest {
  /** New name. */
  name?: string;
  /** New entry rule. */
  onEnterMode?: BucketRule;
  /** New rule status. */
  onEnterStatus?: ItemStatus | null;
}

/** A label as returned by `GET /projects/:id/labels`. */
export interface LabelDto {
  /** Label id (uuid). */
  id: string;
  /** Name, unique within the project. */
  name: string;
  /** `#rrggbb`. */
  colour: string;
}

/** Body of `POST /projects/:id/labels`. */
export interface CreateLabelRequest {
  /** Name. */
  name: string;
  /** `#rrggbb`. */
  colour: string;
}

/** Body of `PATCH /projects/:id/labels/:labelId`. */
export interface UpdateLabelRequest {
  /** New name. */
  name?: string;
  /** New colour. */
  colour?: string;
}

/** A sprint as returned by `GET /projects/:id/sprints`. */
export interface SprintDto {
  /** Sprint id (uuid). */
  id: string;
  /** Name. */
  name: string;
  /** `YYYY-MM-DD`. */
  startDate: string;
  /** `YYYY-MM-DD`. */
  endDate: string;
  /** Lifecycle state. */
  state: SprintState;
  /** ADO iteration path override, or null. */
  adoIterationPath: string | null;
}

/** Body of `POST /projects/:id/sprints`. New sprints are `PLANNED`. */
export interface CreateSprintRequest {
  /** Name. */
  name: string;
  /** `YYYY-MM-DD`. */
  startDate: string;
  /** `YYYY-MM-DD`, not before the start. */
  endDate: string;
  /** ADO iteration path override. */
  adoIterationPath?: string | null;
}

/** Body of `PATCH /projects/:id/sprints/:sprintId`. */
export interface UpdateSprintRequest {
  /** New name. */
  name?: string;
  /** New start date. */
  startDate?: string;
  /** New end date. */
  endDate?: string;
  /** New override, or null. */
  adoIterationPath?: string | null;
}

/** Body of `POST /projects/:id/sprints/:sprintId/close`. */
export interface CloseSprintRequest {
  /**
   * Where unfinished (not DONE) items go: another open sprint's id, or null
   * for the backlog. Omit to leave them in the closed sprint.
   */
  moveUnfinishedTo?: string | null;
}

/** Result of closing a sprint. */
export interface CloseSprintResult {
  /** The closed sprint. */
  sprint: SprintDto;
  /** How many unfinished items were moved. */
  movedItems: number;
}

/** Most item references resolved by one `GET /references` request (M12). */
export const REFERENCE_KEYS_MAX = 50;

/**
 * A visible item named in rich text (`KLO-12`, M12): enough for the hover
 * card. Items the caller cannot see are never returned.
 */
export interface ItemPreviewDto extends ItemRefDto {
  /** Project id. */
  projectId: string;
  /** Status. */
  status: ItemStatus;
  /** Assignee user ids. */
  assigneeIds: string[];
  /** `YYYY-MM-DD`, or null. */
  dueDate: string | null;
}

/** An item whose description or notes name another item (M12 "Referenced in"). */
export interface ItemReferrerDto extends ItemRefDto {
  /** Project id. */
  projectId: string;
}

/** One trashed item as listed in a delete batch (M12). */
export interface TrashItemDto extends ItemRefDto {
  /** Parent id when trashed, or null. */
  parentId: string | null;
}

/** One delete batch in a project's trash, newest first (M12). */
export interface TrashBatchDto {
  /** Batch id (uuid). */
  id: string;
  /** ISO timestamp of the delete. */
  deletedAt: string;
  /** Who deleted it, or null when that account is gone. */
  deletedBy: { id: string; displayName: string } | null;
  /** ISO timestamp after which the nightly purge removes it for good. */
  purgeAfter: string;
  /** The visible items of the batch, the deleted item first. */
  items: TrashItemDto[];
  /** The caller may restore the batch. */
  canRestore: boolean;
  /** The caller may delete the batch permanently (PMs). */
  canPurge: boolean;
}

/** Answer of `DELETE /projects/:id/items/:item` since M12: the trash batch, for Undo. */
export interface DeleteItemResult {
  /** The delete batch; restoring it is the Undo. */
  batchId: string;
  /** Items moved to the trash, the deleted item included. */
  count: number;
}

/** Answer of `POST /projects/:id/trash/:batchId/restore` (M12). */
export interface RestoreBatchResult {
  /** Items restored. */
  restored: number;
  /** The restored item went back without its parent, which is still in the trash. */
  parentDropped: boolean;
}
