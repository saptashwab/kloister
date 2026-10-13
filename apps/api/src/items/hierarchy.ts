import { ALLOWED_PARENT_TYPES, isAllowedParent, type ItemType } from '@kloister/shared';
import { isUUID } from 'class-validator';
import { invalidField } from '../common/api-exception.js';

/** Deepest ancestor chain followed; the type rules allow four levels. */
export const MAX_HIERARCHY_DEPTH = 10;

/** Where an item reference from the URL points. */
export type ItemLookup = { id: string } | { number: number };

/**
 * Parses an item reference from the URL: the item's uuid or its
 * per-project number (deep links use `/p/KLO/items/42`, SPEC §6).
 *
 * @param ref The path segment.
 * @returns The lookup, or null if it is neither.
 */
export function parseItemRef(ref: string): ItemLookup | null {
  if (isUUID(ref)) return { id: ref.toLowerCase() };
  if (!/^[1-9]\d{0,8}$/.test(ref)) return null;
  return { number: Number(ref) };
}

/**
 * Throws 400 unless an item of type `child` may sit under one of type
 * `parent` (SPEC §4.1).
 *
 * @param child The child's type.
 * @param parent The parent's type.
 */
export function assertParentType(child: ItemType, parent: ItemType): void {
  if (isAllowedParent(child, parent)) return;
  const allowed = ALLOWED_PARENT_TYPES[child];
  throw invalidField(
    'parentId',
    allowed.length === 0
      ? `A ${child} cannot have a parent`
      : `A ${child} can only sit under ${allowed.join(' or ')}`,
  );
}

/**
 * Throws 400 if an item changing to `type` would no longer be an allowed
 * parent of its existing children (SPEC §4.1).
 *
 * @param type The item's new type.
 * @param childTypes The distinct types of its children.
 */
export function assertChildrenFit(type: ItemType, childTypes: readonly ItemType[]): void {
  const misfit = childTypes.find((child) => !isAllowedParent(child, type));
  if (misfit !== undefined) {
    throw invalidField('type', `A ${type} cannot contain the ${misfit} items under this one`);
  }
}

/**
 * Reports whether linking an item under a parent would create a cycle: the
 * item may not be the parent itself or one of the parent's ancestors.
 *
 * @param itemId The item being re-parented.
 * @param parentChain The new parent's id followed by its ancestors' ids.
 * @returns True if the link would close a loop.
 */
export function closesCycle(itemId: string, parentChain: readonly string[]): boolean {
  return parentChain.includes(itemId);
}
