import type { AdoSelection, ItemType } from '@kloister/shared';
import { invalidField } from '../common/api-exception.js';

/** Minimal scoped selection facts. */
export interface SelectionItem {
  /** Local identity. */
  id: string;
  /** Existing parent. */
  parentId: string | null;
  /** Local type. */
  type: ItemType;
  /** Completion state. */
  status: string;
  /** Optional sprint. */
  sprintId: string | null;
  /** Attached labels. */
  labels: { labelId: string }[];
}

/**
 * Selects items and optional ancestors, never ordinary descendants or dependencies.
 * @param items Entire already-scoped project set.
 * @param selection Reviewed filter/scope.
 * @returns Depth-first rows and explicit-selection identities.
 */
export function selectItems<T extends SelectionItem>(
  items: T[],
  selection: AdoSelection,
): { items: T[]; selected: Set<string> } {
  const byId = new Map(items.map((i) => [i.id, i]));
  const manual = new Set(selection.itemIds ?? []);
  if (selection.scope === 'manual' && [...manual].some((id) => !byId.has(id)))
    throw invalidField('itemIds', 'Selected item not found');
  if (selection.scope === 'subtree' && !byId.has(selection.rootId ?? ''))
    throw invalidField('rootId', 'Subtree root not found');
  const descendants = new Set([selection.rootId]);
  if (selection.scope === 'subtree') {
    for (let changed = true; changed;) {
      changed = false;
      for (const i of items)
        if (i.parentId !== null && descendants.has(i.parentId) && !descendants.has(i.id)) {
          descendants.add(i.id);
          changed = true;
        }
    }
  }
  const selected = new Set(
    items
      .filter((i) => {
        const scope =
          selection.scope === 'project' ||
          (selection.scope === 'manual' && manual.has(i.id)) ||
          (selection.scope === 'sprint' && i.sprintId === selection.rootId) ||
          (selection.scope === 'subtree' && descendants.has(i.id));
        const labels = new Set(i.labels.map((l) => l.labelId));
        return (
          scope &&
          (!selection.excludeDone || i.status !== 'DONE') &&
          (selection.labelIds.length === 0 ||
            (selection.labelMode === 'all'
              ? selection.labelIds.every((id) => labels.has(id))
              : selection.labelIds.some((id) => labels.has(id))))
        );
      })
      .map((i) => i.id),
  );
  const included = new Set(selected);
  if (selection.ancestors)
    for (const id of selected) {
      let current = byId.get(id);
      const seen = new Set<string>();
      while (current?.parentId) {
        if (seen.has(current.parentId)) throw invalidField('parentId', 'Hierarchy cycle');
        seen.add(current.parentId);
        included.add(current.parentId);
        current = byId.get(current.parentId);
        if (!current) throw invalidField('parentId', 'Ancestor is not fully readable');
      }
    }
  const result: T[] = [],
    visited = new Set<string>();
  const visit = (i: T): void => {
    if (visited.has(i.id)) return;
    visited.add(i.id);
    const parent = byId.get(i.parentId ?? '');
    if (parent && included.has(parent.id)) visit(parent);
    result.push(i);
  };
  for (const i of items) if (included.has(i.id)) visit(i);
  return { items: result, selected };
}
