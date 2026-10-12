import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from '@kloister/shared';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * Reads the known settings from a project's `settings` JSON, falling back to
 * the defaults for anything missing or malformed. A bad stored value can
 * therefore never grant a permission (e.g. `membersCanAssignOthers: "yes"`
 * reads as false).
 *
 * @param raw The stored JSON value.
 * @returns Validated settings.
 */
export function parseProjectSettings(raw: Prisma.JsonValue): ProjectSettings {
  const value = isObject(raw) ? raw : {};
  return {
    membersCanAssignOthers:
      typeof value['membersCanAssignOthers'] === 'boolean'
        ? value['membersCanAssignOthers']
        : DEFAULT_PROJECT_SETTINGS.membersCanAssignOthers,
  };
}

/**
 * Merges a settings change into the stored JSON, keeping keys this version
 * does not know about (added by later milestones) untouched.
 *
 * @param raw The stored JSON value.
 * @param change Settings to change.
 * @returns The JSON to store.
 */
export function mergeProjectSettings(
  raw: Prisma.JsonValue,
  change: Partial<ProjectSettings>,
): Prisma.InputJsonObject {
  const base = isObject(raw) ? raw : {};
  return { ...(base as Prisma.InputJsonObject), ...change };
}

/**
 * Narrows a JSON value to a plain object.
 *
 * @param value Any JSON value.
 * @returns True for non-array objects.
 */
function isObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
