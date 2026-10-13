import {
  type BucketDto,
  type ItemRefDto,
  ItemStatus,
  type ItemType,
  type MoveItemRequest,
  type ProjectMemberDto,
  type SprintDto,
  SprintState,
  type UpdateItemRequest,
  type WorkItemDto,
} from '@kloister/shared';
import { STATUS_LABELS } from './labels';

// Pure board, filter and tree logic shared by the board, backlog and sprint
// views. Nothing here decides permissions: the API is the authority and
// these functions only shape what the UI shows and which request it sends.

/** What the board's columns are (SPEC §6 Group-by switch). */
export type GroupBy = 'bucket' | 'status' | 'assignee' | 'sprint';

/** Column id meaning "no assignee" or "no sprint". */
export const NONE = 'none';

/** Board filters (SPEC §6). Empty values do not filter. */
export interface BoardFilter {
  /** Assignee user id, or {@link NONE} for unassigned items. */
  assigneeId: string;
  /** Label id. */
  labelId: string;
  /** Sprint id, or {@link NONE} for items in no sprint. */
  sprintId: string;
  /** Item type. */
  type: ItemType | '';
  /** `overdue` or `week` (due this week). */
  due: 'overdue' | 'week' | '';
  /** Case-insensitive text matched against the title and the key. */
  text: string;
}

/** A filter that shows everything. */
export const EMPTY_FILTER: BoardFilter = {
  assigneeId: '',
  labelId: '',
  sprintId: '',
  type: '',
  due: '',
  text: '',
};

/**
 * Formats a date as the wire format `YYYY-MM-DD`, in local time.
 *
 * @param date The date.
 * @returns The calendar date.
 */
export function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Returns the last day (Sunday) of the ISO week containing a date.
 *
 * @param today `YYYY-MM-DD`.
 * @returns `YYYY-MM-DD` of that week's Sunday.
 */
export function endOfWeek(today: string): string {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  // getDay(): Sunday is 0; weeks run Monday to Sunday.
  date.setDate(date.getDate() + ((7 - date.getDay()) % 7));
  return isoDate(date);
}

/**
 * Reports whether an unfinished item is past its due date.
 *
 * @param item The item.
 * @param today `YYYY-MM-DD`.
 * @returns True when due before today and not Done.
 */
export function isOverdue(item: Pick<WorkItemDto, 'dueDate' | 'status'>, today: string): boolean {
  return item.dueDate !== null && item.dueDate < today && item.status !== ItemStatus.DONE;
}

/**
 * Reports whether an item is due between today and the end of this week.
 *
 * @param item The item.
 * @param today `YYYY-MM-DD`.
 * @returns True when due this week, today included.
 */
export function isDueThisWeek(item: Pick<WorkItemDto, 'dueDate'>, today: string): boolean {
  return item.dueDate !== null && item.dueDate >= today && item.dueDate <= endOfWeek(today);
}

/**
 * Applies the board filters to one item.
 *
 * @param item The item.
 * @param filter The filters.
 * @param today `YYYY-MM-DD`, for the due filters.
 * @returns True if the item passes every filter.
 */
export function matchesFilter(item: WorkItemDto, filter: BoardFilter, today: string): boolean {
  if (filter.assigneeId === NONE && item.assigneeIds.length > 0) return false;
  if (
    filter.assigneeId &&
    filter.assigneeId !== NONE &&
    !item.assigneeIds.includes(filter.assigneeId)
  ) {
    return false;
  }
  if (filter.labelId && !item.labelIds.includes(filter.labelId)) return false;
  if (filter.sprintId === NONE && item.sprintId !== null) return false;
  if (filter.sprintId && filter.sprintId !== NONE && item.sprintId !== filter.sprintId) {
    return false;
  }
  if (filter.type && item.type !== filter.type) return false;
  if (filter.due === 'overdue' && !isOverdue(item, today)) return false;
  if (filter.due === 'week' && !isDueThisWeek(item, today)) return false;
  const text = filter.text.trim().toLowerCase();
  if (text && !item.title.toLowerCase().includes(text) && !item.key.toLowerCase().includes(text)) {
    return false;
  }
  return true;
}

/** One board column. */
export interface BoardColumn {
  /** Bucket id, status, user id, sprint id, or {@link NONE}. */
  id: string;
  /** Column heading. */
  title: string;
  /** Cards in display order. */
  items: WorkItemDto[];
  /** False for columns cards cannot be dropped into (closed sprints). */
  accepts: boolean;
}

/** Lookups needed to build columns. */
export interface BoardLookups {
  /** Buckets in column order. */
  buckets: BucketDto[];
  /** Project members. */
  members: ProjectMemberDto[];
  /** Sprints. */
  sprints: SprintDto[];
}

/**
 * Groups cards into columns. Cards are the items on the board (with a
 * bucket); inside every column they keep board order (bucket column order,
 * then position).
 *
 * @param items Visible, filtered items.
 * @param groupBy What the columns are.
 * @param lookups Buckets, members and sprints.
 * @returns The columns, in display order.
 */
export function buildColumns(
  items: WorkItemDto[],
  groupBy: GroupBy,
  lookups: BoardLookups,
): BoardColumn[] {
  const bucketRank = new Map(lookups.buckets.map((b, i) => [b.id, i]));
  const cards = items
    .filter((i) => i.bucketId !== null && bucketRank.has(i.bucketId))
    .sort(
      (a, b) =>
        (bucketRank.get(a.bucketId as string) ?? 0) - (bucketRank.get(b.bucketId as string) ?? 0) ||
        a.position - b.position,
    );
  const column = (
    id: string,
    title: string,
    match: (i: WorkItemDto) => boolean,
    accepts = true,
  ) => ({
    id,
    title,
    items: cards.filter(match),
    accepts,
  });

  switch (groupBy) {
    case 'bucket':
      return lookups.buckets.map((b) => column(b.id, b.name, (i) => i.bucketId === b.id));
    case 'status':
      return Object.values(ItemStatus).map((s) =>
        column(s, STATUS_LABELS[s], (i) => i.status === s),
      );
    case 'assignee': {
      const members = [...lookups.members].sort((a, b) =>
        a.displayName.localeCompare(b.displayName),
      );
      return [
        column(NONE, 'Unassigned', (i) => i.assigneeIds.length === 0),
        ...members
          // Deactivated members only get a column while they still hold cards.
          .filter((m) => m.isActive || cards.some((i) => i.assigneeIds.includes(m.userId)))
          .map((m) => column(m.userId, m.displayName, (i) => i.assigneeIds.includes(m.userId))),
      ];
    }
    case 'sprint':
      return [
        column(NONE, 'No sprint', (i) => i.sprintId === null),
        ...lookups.sprints
          .filter((s) => s.state !== SprintState.CLOSED || cards.some((i) => i.sprintId === s.id))
          .map((s) =>
            column(s.id, s.name, (i) => i.sprintId === s.id, s.state !== SprintState.CLOSED),
          ),
      ];
  }
}

/** The request a drop turns into. */
export type DropRequest =
  { kind: 'move'; request: MoveItemRequest } | { kind: 'update'; request: UpdateItemRequest };

/**
 * Turns a drag-and-drop into an API request.
 *
 * Bucket view: `POST …/move` with the card it now follows (`afterId`), so
 * the server places it and applies the bucket's entry rule. Other views
 * change the field the columns stand for; reordering inside those columns
 * means nothing and sends nothing.
 *
 * @param groupBy What the columns are.
 * @param item The dragged card.
 * @param from Source column id.
 * @param to Target column id.
 * @param target The target column's cards before the drop.
 * @param index Drop index in the target column.
 * @returns The request, or null when nothing changes.
 */
export function dropRequest(
  groupBy: GroupBy,
  item: WorkItemDto,
  from: string,
  to: string,
  target: WorkItemDto[],
  index: number,
): DropRequest | null {
  if (groupBy === 'bucket') {
    const others = target.filter((i) => i.id !== item.id);
    if (from === to && target[index]?.id === item.id) return null;
    const afterId = index > 0 ? (others[index - 1]?.id ?? null) : null;
    return { kind: 'move', request: from === to ? { afterId } : { bucketId: to, afterId } };
  }
  if (from === to) return null;
  switch (groupBy) {
    case 'status':
      return { kind: 'update', request: { status: to as ItemStatus } };
    case 'sprint':
      return { kind: 'update', request: { sprintId: to === NONE ? null : to } };
    case 'assignee': {
      const kept = item.assigneeIds.filter((id) => id !== from);
      const assigneeIds = to === NONE || kept.includes(to) ? kept : [...kept, to];
      return { kind: 'update', request: { assigneeIds: to === NONE ? [] : assigneeIds } };
    }
  }
}

/** Sort rank of item types: the hierarchy from top to bottom. */
const TYPE_RANK: Record<ItemType, number> = {
  EPIC: 0,
  FEATURE: 1,
  STORY: 2,
  TASK: 3,
  BUG: 4,
};

/** One node of the backlog tree. */
export interface TreeNode {
  /** Item id. */
  id: string;
  /** Key, type and title. */
  ref: ItemRefDto;
  /**
   * The full item, or null for an ancestor outside the caller's scope,
   * which is shown as a read-only title only (SPEC §3.3).
   */
  item: WorkItemDto | null;
  /** Child nodes in display order. */
  children: TreeNode[];
}

/**
 * Builds the Epic → Feature → Story → Task tree from the visible items.
 * Ancestors the caller cannot see come from each item's `ancestors` and
 * become read-only title nodes, so the hierarchy stays readable.
 *
 * @param items Visible items.
 * @returns Root nodes, ordered by type then number.
 */
export function buildTree(items: WorkItemDto[]): TreeNode[] {
  const visible = new Map(items.map((i) => [i.id, i]));
  const nodes = new Map<string, TreeNode>();
  const placed = new Set<string>();
  const roots: TreeNode[] = [];

  const nodeFor = (ref: ItemRefDto): TreeNode => {
    let node = nodes.get(ref.id);
    if (node === undefined) {
      const item = visible.get(ref.id) ?? null;
      node = { id: ref.id, ref: item ?? ref, item, children: [] };
      nodes.set(ref.id, node);
    }
    return node;
  };
  const place = (node: TreeNode, parent: TreeNode | null) => {
    if (placed.has(node.id)) return;
    placed.add(node.id);
    (parent === null ? roots : parent.children).push(node);
  };

  for (const item of items) {
    // `ancestors` runs from the root down to the parent; every item on the
    // chain sits under the one before it.
    let parent: TreeNode | null = null;
    for (const ancestor of item.ancestors) {
      const node = nodeFor(ancestor);
      place(node, parent);
      parent = node;
    }
    place(nodeFor(item), parent);
  }

  const order = (list: TreeNode[]) => {
    list.sort(
      (a, b) => TYPE_RANK[a.ref.type] - TYPE_RANK[b.ref.type] || a.ref.number - b.ref.number,
    );
    for (const node of list) order(node.children);
  };
  order(roots);
  return roots;
}

/** A tree node flattened for rendering. */
export interface TreeRow {
  /** The node. */
  node: TreeNode;
  /** Nesting depth, 0 for roots. */
  depth: number;
}

/**
 * Flattens the tree, skipping the children of collapsed nodes.
 *
 * @param roots Root nodes.
 * @param collapsed Ids of collapsed nodes.
 * @returns Rows in display order.
 */
export function flattenTree(roots: TreeNode[], collapsed: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (list: TreeNode[], depth: number) => {
    for (const node of list) {
      rows.push({ node, depth });
      if (!collapsed.has(node.id)) walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return rows;
}

/**
 * Keeps the nodes that pass a filter plus the path to each of them, so a
 * filtered backlog still shows where every match sits.
 *
 * @param roots Root nodes.
 * @param match The filter, applied to visible items.
 * @returns A pruned copy of the tree.
 */
export function pruneTree(roots: TreeNode[], match: (item: WorkItemDto) => boolean): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of roots) {
    const children = pruneTree(node.children, match);
    if (children.length > 0 || (node.item !== null && match(node.item))) {
      out.push({ ...node, children });
    }
  }
  return out;
}
