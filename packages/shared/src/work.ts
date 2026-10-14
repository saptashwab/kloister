import type { ItemStatus, ItemType, LabelDto } from './items.js';
import type { LabelStyle } from './projects.js';

/**
 * One item in a person's "all their work" list (SPEC §6): enough to show it
 * in a cross-project list and to open it in its project.
 */
export interface WorkSummaryDto {
  /** Item id (uuid). */
  id: string;
  /** Per-project number. */
  number: number;
  /** Display key, e.g. `KLO-42`. */
  key: string;
  /** Project id. */
  projectId: string;
  /** Project key, for the item's link (`/p/:key/items/:number`). */
  projectKey: string | null;
  /** True only for the caller's own personal tasks. */
  personal: boolean;
  /** Bucket metadata belongs to this project, never a cross-project column. */
  bucket: { id: string; name: string } | null;
  /** Readable labels belonging to this item. */
  labels: LabelDto[];
  /** This project's label presentation. */
  labelStyle: LabelStyle;
  /** Whether the viewer can edit the status. */
  canEdit: boolean;
  /** Project name. */
  projectName: string;
  /** Item type. */
  type: ItemType;
  /** Title. */
  title: string;
  /** Status. */
  status: ItemStatus;
  /** Priority, 1 (highest) to 4. */
  priority: number;
  /** Due date as `YYYY-MM-DD`, or null. */
  dueDate: string | null;
}

/** The person whose work is listed. */
export interface WorkPersonDto {
  /** User id. */
  id: string;
  /** Display name. */
  displayName: string;
  /** Email. */
  email: string;
}

/**
 * Answer of `GET /users/:userId/work`: the person and one page of the items
 * assigned to them that the caller can see.
 */
export interface UserWorkDto {
  /** The person. */
  user: WorkPersonDto;
  /** Items on this page, due date first (undated last). */
  items: WorkSummaryDto[];
  /** Cursor for the next page, or null on the last page. */
  nextCursor: string | null;
}
