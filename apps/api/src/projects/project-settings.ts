import {
  DEFAULT_PROJECT_SETTINGS,
  ItemStatus,
  type ProjectSettings,
  type StatusToBucket,
} from '@kloister/shared';
import { isUUID } from 'class-validator';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * Reads the known settings from a project's `settings` JSON, falling back to
 * the defaults for anything missing or malformed. A bad stored value can
 * therefore never grant a permission (e.g. `membersCanAssignOthers: "yes"`
 * reads as false), and a malformed `statusToBucket` entry is dropped.
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
    statusToBucket: parseStatusToBucket(value['statusToBucket']),
  };
}

/**
 * Keeps the well-formed entries of a stored status → bucket map: known
 * status keys with uuid values. Whether the bucket still exists is checked
 * where the map is used.
 *
 * @param raw The stored value.
 * @returns The map.
 */
function parseStatusToBucket(raw: Prisma.JsonValue | undefined): StatusToBucket {
  if (raw === undefined || !isObject(raw)) return {};
  const statuses = Object.values(ItemStatus) as string[];
  const map: StatusToBucket = {};
  for (const [status, bucketId] of Object.entries(raw)) {
    if (statuses.includes(status) && typeof bucketId === 'string' && isUUID(bucketId)) {
      map[status as ItemStatus] = bucketId.toLowerCase();
    }
  }
  return map;
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
  return { ...(base as Prisma.InputJsonObject), ...(change as Prisma.InputJsonObject) };
}

/**
 * Removes a deleted bucket from the status → bucket map, keeping every other
 * stored key as it is.
 *
 * @param raw The stored JSON value.
 * @param bucketId The deleted bucket.
 * @returns The JSON to store, or null when nothing referred to the bucket.
 */
export function withoutBucket(
  raw: Prisma.JsonValue,
  bucketId: string,
): Prisma.InputJsonObject | null {
  const map = parseProjectSettings(raw).statusToBucket;
  const kept = Object.fromEntries(Object.entries(map).filter(([, id]) => id !== bucketId));
  if (Object.keys(kept).length === Object.keys(map).length) return null;
  return mergeProjectSettings(raw, { statusToBucket: kept });
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
