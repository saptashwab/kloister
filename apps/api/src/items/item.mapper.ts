import type {
  ChecklistItemDto,
  ItemCapabilitiesDto,
  ItemRefDto,
  WorkItemDto,
} from '@kloister/shared';
import { fromDbDate } from '../common/dates.js';
import type { ChecklistItem, Prisma } from '../generated/prisma/client.js';
import type { ItemFacts } from '../projects/project-access.service.js';

/**
 * Relations every item response needs: assignees, labels, checklist
 * progress, and the number of children the caller can see (hidden children
 * are not revealed, not even as a count).
 *
 * @param scope The caller's visibility filter.
 * @returns The Prisma include.
 */
export function itemInclude(scope: Prisma.WorkItemWhereInput) {
  return {
    assignees: {
      select: { userId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    },
    labels: { select: { labelId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    checklist: { select: { done: true } },
    _count: { select: { children: { where: scope } } },
  } satisfies Prisma.WorkItemInclude;
}

/** An item row loaded with {@link itemInclude}. */
export type ItemRow = Prisma.WorkItemGetPayload<{ include: ReturnType<typeof itemInclude> }>;

/** The columns of an item shown as a read-only title, plus its parent link. */
export const REF_SELECT = {
  id: true,
  number: true,
  type: true,
  title: true,
  parentId: true,
} as const satisfies Prisma.WorkItemSelect;

/** An item row loaded with {@link REF_SELECT}. */
export type RefRow = Prisma.WorkItemGetPayload<{ select: typeof REF_SELECT }>;

/**
 * Extracts the facts the permission checks need from an item row.
 * `hasChildren` reflects the children the caller can see; deleting counts
 * every child separately.
 *
 * @param row The item.
 * @returns The facts.
 */
export function itemFacts(row: ItemRow): ItemFacts {
  return {
    createdById: row.createdById,
    assigneeIds: row.assignees.map((a) => a.userId),
    bucketId: row.bucketId,
    teamId: row.teamId,
    hasChildren: row._count.children > 0,
  };
}

/**
 * Converts an item to a read-only reference.
 *
 * @param projectKey The project key, for the display key.
 * @param row Any row with the reference columns.
 * @returns The reference.
 */
export function toItemRef(
  projectKey: string,
  row: Pick<RefRow, 'id' | 'number' | 'type' | 'title'>,
): ItemRefDto {
  return {
    id: row.id,
    number: row.number,
    key: `${projectKey}-${row.number}`,
    type: row.type,
    title: row.title,
  };
}

/**
 * Converts an item to its API shape.
 *
 * @param projectKey The project key, for the display key.
 * @param row The item with {@link itemInclude}.
 * @param ancestors The item's ancestors, root first.
 * @param can What the caller may do with it.
 * @returns The DTO.
 */
export function toItemDto(
  projectKey: string,
  row: ItemRow,
  ancestors: ItemRefDto[],
  can: ItemCapabilitiesDto,
): WorkItemDto {
  return {
    ...toItemRef(projectKey, row),
    parentId: row.parentId,
    ancestors,
    description: row.description,
    status: row.status,
    priority: row.priority,
    bucketId: row.bucketId,
    sprintId: row.sprintId,
    teamId: row.teamId,
    startDate: fromDbDate(row.startDate),
    dueDate: fromDbDate(row.dueDate),
    position: row.position,
    createdById: row.createdById,
    assigneeIds: row.assignees.map((a) => a.userId),
    labelIds: row.labels.map((l) => l.labelId),
    checklist: {
      done: row.checklist.filter((c) => c.done).length,
      total: row.checklist.length,
    },
    childCount: row._count.children,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    can,
  };
}

/**
 * Converts a checklist line to its API shape.
 *
 * @param line The row.
 * @returns The DTO.
 */
export function toChecklistItemDto(line: ChecklistItem): ChecklistItemDto {
  return { id: line.id, text: line.text, done: line.done, position: line.position };
}
