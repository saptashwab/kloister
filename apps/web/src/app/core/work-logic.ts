import type { WorkSummaryDto } from '@kloister/shared';
import { endOfWeek } from './board-logic';

/** Work source and narrowing filters, evaluated over every loaded page. */
export interface WorkFilter {
  /** Project or private personal source. */
  source: 'ALL' | 'PROJECTS' | 'PERSONAL';
  /** Project uuid, or empty for all. */
  projectId: string;
  /** Item type, or empty for all. */
  type: string;
  /** Label uuid, or empty for all. */
  labelId: string;
  /** Due-date group, or empty for all. */
  due: string;
}

/** One list section or project board. */
export interface WorkGroup {
  /** Stable section identity. */
  id: string;
  /** Heading text. */
  name: string;
  /** Matching items, in server order. */
  items: WorkSummaryDto[];
}

/**
 * Classifies a due date using the viewer's calendar day and Monday–Sunday week.
 * @param item The item.
 * @param today Calendar day in ISO format.
 * @returns The due-date section.
 */
export function workDueGroup(
  item: Pick<WorkSummaryDto, 'dueDate' | 'status'>,
  today: string,
): string {
  if (item.dueDate === null) return 'No date';
  if (item.dueDate < today) return item.status === 'DONE' ? 'Later' : 'Overdue';
  if (item.dueDate === today) return 'Today';
  return item.dueDate <= endOfWeek(today) ? 'This week' : 'Later';
}

/**
 * Applies work filters without merging project-specific bucket/label identities.
 * @param items Complete readable work list.
 * @param filter Current filters.
 * @param today Calendar day.
 * @returns Matching items.
 */
export function filterWork(
  items: WorkSummaryDto[],
  filter: WorkFilter,
  today: string,
): WorkSummaryDto[] {
  return items.filter(
    (i) =>
      (filter.source === 'ALL' || i.personal === (filter.source === 'PERSONAL')) &&
      (!filter.projectId || i.projectId === filter.projectId) &&
      (!filter.type || i.type === filter.type) &&
      (!filter.labelId || i.labels.some((l) => l.id === filter.labelId)) &&
      (!filter.due || workDueGroup(i, today) === filter.due),
  );
}

/**
 * Groups a readable list by due date or by its own projects.
 * @param items Matching items.
 * @param byProject Whether to group by project.
 * @param today Calendar day.
 * @returns Nonempty sections in due order or project-name order.
 */
export function groupWork(items: WorkSummaryDto[], byProject: boolean, today: string): WorkGroup[] {
  if (!byProject)
    return ['Overdue', 'Today', 'This week', 'Later', 'No date']
      .map((name) => ({
        id: name,
        name,
        items: items.filter((i) => workDueGroup(i, today) === name),
      }))
      .filter((g) => g.items.length > 0);
  const groups = new Map<string, WorkGroup>();
  for (const item of items) {
    const group = groups.get(item.projectId) ?? {
      id: item.projectId,
      name: item.projectName,
      items: [],
    };
    group.items.push(item);
    groups.set(group.id, group);
  }
  return [...groups.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}
