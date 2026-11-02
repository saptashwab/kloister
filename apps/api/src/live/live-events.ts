import { AuditAction, type PresenceAction, type PresenceField } from '@kloister/shared';
import type { AuditRecord, DbClient } from '../audit/audit.service.js';
import type { ItemFacts } from '../projects/project-access.service.js';
import { currentClientId } from './client-id.js';

/** PostgreSQL notification channel of live updates (M10 plan section 5.2). */
export const LIVE_CHANNEL = 'kloister_events';

/**
 * Longest payload sent; PostgreSQL refuses more than 8,000 bytes. A larger
 * message becomes a project resync.
 */
export const LIVE_PAYLOAD_MAX = 7_000;

/** The visibility facts of an item, as carried on the channel. */
export interface WireFacts {
  /** Creator. */
  c: string;
  /** Assignees. */
  a: string[];
  /** Bucket, or null. */
  b: string | null;
  /** Team, or null. */
  t: string | null;
}

/** One item touched by an audited change. */
export interface WireItem {
  /** Item id. */
  id: string;
  /** Facts after the change; null when the item is gone. */
  f: WireFacts | null;
  /** Facts before the change, when the change can alter who sees the item. */
  b?: WireFacts;
}

/** Fields shared by the messages of one audited change. */
interface ChangeBase {
  /** Project id. */
  p: string;
  /** Actor, or null. */
  u: string | null;
  /** The acting tab's client id, or null. */
  c: string | null;
}

/** Messages on {@link LIVE_CHANNEL}. They hold ids and visibility facts only. */
export type LiveMessage =
  | (ChangeBase & { k: 'item'; i: WireItem[] })
  | (ChangeBase & { k: 'links'; i: WireItem[] })
  | (Omit<ChangeBase, 'p'> & { k: 'board'; p: string | null })
  | { k: 'access'; p: string }
  | { k: 'resync'; p: string }
  | { k: 'notify'; users: string[] }
  | { k: 'session'; users: string[] }
  | { k: 'setting' }
  | PresenceMessage;

/** A stream's presence, sent by the API process holding the stream. */
export interface PresenceMessage {
  /** Kind. */
  k: 'presence';
  /** Stream id. */
  s: string;
  /** The person. */
  u: string;
  /** Their project; null when the stream left it (the entry is removed). */
  p: string | null;
  /** Item open, or null. */
  i: string | null;
  /** That item's facts, for the per-viewer visibility check. */
  f: WireFacts | null;
  /** Action, or null. */
  a: PresenceAction | null;
  /** Field, or null. */
  fl: PresenceField | null;
}

/** What an audited action means for live updates. */
type LiveKind = 'item' | 'links' | 'board' | 'access' | 'session' | 'setting' | null;

/**
 * The live meaning of every audited action (M10 plan section 5.2). It is a
 * full record, so a new action does not compile until it is mapped here or
 * marked as not live (null).
 */
export const AUDIT_LIVE_KIND: Record<AuditAction, LiveKind> = {
  [AuditAction.ITEM_CREATED]: 'item',
  [AuditAction.ITEM_UPDATED]: 'item',
  [AuditAction.ITEM_MOVED]: 'item',
  [AuditAction.ITEM_DELETED]: 'item',
  [AuditAction.ITEM_TRASHED]: 'item',
  [AuditAction.ITEM_RESTORED]: 'item',
  // Purged items were already gone; trash pages refresh their list.
  [AuditAction.ITEM_PURGED]: 'board',
  [AuditAction.SPRINT_FOLLOWED]: 'item',
  [AuditAction.CHECKLIST_ITEM_ADDED]: 'item',
  [AuditAction.CHECKLIST_ITEM_UPDATED]: 'item',
  [AuditAction.CHECKLIST_ITEM_REMOVED]: 'item',
  [AuditAction.NOTE_ADDED]: 'item',
  [AuditAction.NOTE_UPDATED]: 'item',
  [AuditAction.NOTE_DELETED]: 'item',
  [AuditAction.ATTACHMENT_ADDED]: 'item',
  [AuditAction.ATTACHMENT_DELETED]: 'item',
  [AuditAction.DEPENDENCY_ADDED]: 'links',
  [AuditAction.DEPENDENCY_REMOVED]: 'links',
  [AuditAction.BUCKET_CREATED]: 'board',
  [AuditAction.BUCKET_UPDATED]: 'board',
  [AuditAction.BUCKET_DELETED]: 'board',
  [AuditAction.LABEL_CREATED]: 'board',
  [AuditAction.LABEL_UPDATED]: 'board',
  [AuditAction.LABEL_DELETED]: 'board',
  [AuditAction.SPRINT_CREATED]: 'board',
  [AuditAction.SPRINT_UPDATED]: 'board',
  [AuditAction.SPRINT_STARTED]: 'board',
  [AuditAction.SPRINT_CLOSED]: 'board',
  [AuditAction.SPRINT_DELETED]: 'board',
  [AuditAction.HOLIDAY_ADDED]: 'board',
  [AuditAction.HOLIDAY_REMOVED]: 'board',
  [AuditAction.HOLIDAYS_REVIEWED]: 'board',
  [AuditAction.MEMBER_ADDED]: 'access',
  [AuditAction.MEMBER_UPDATED]: 'access',
  [AuditAction.MEMBER_REMOVED]: 'access',
  [AuditAction.TEAM_CREATED]: 'access',
  [AuditAction.TEAM_UPDATED]: 'access',
  [AuditAction.TEAM_DELETED]: 'access',
  [AuditAction.TEAM_MEMBER_SET]: 'access',
  [AuditAction.TEAM_MEMBER_REMOVED]: 'access',
  [AuditAction.PROJECT_UPDATED]: 'access',
  [AuditAction.PROJECT_ARCHIVED]: 'access',
  [AuditAction.PROJECT_UNARCHIVED]: 'access',
  // Streams of these users are checked against their sessions at once.
  [AuditAction.LOGOUT]: 'session',
  [AuditAction.PASSWORD_CHANGED]: 'session',
  [AuditAction.PASSWORD_RESET]: 'session',
  [AuditAction.USER_UPDATED]: 'session',
  // Only the live switch itself matters (meta.key 'live').
  [AuditAction.SETTINGS_UPDATED]: 'setting',
  // Not live: sign-in, accounts, admin pages, backups, exports and transfers.
  // ADO imports change items through the item actions above.
  [AuditAction.LOGIN_SUCCEEDED]: null,
  [AuditAction.LOGIN_FAILED]: null,
  [AuditAction.ACCOUNT_LOCKED]: null,
  [AuditAction.PASSWORD_CHANGE_FAILED]: null,
  [AuditAction.USER_CREATED]: null,
  [AuditAction.ADMIN_BOOTSTRAPPED]: null,
  [AuditAction.PROJECT_CREATED]: null,
  [AuditAction.ADMIN_CROSS_PROJECT_ACCESS]: null,
  [AuditAction.BRANDING_FILE_UPLOADED]: null,
  [AuditAction.BRANDING_FILE_REMOVED]: null,
  [AuditAction.BACKUP_REQUESTED]: null,
  [AuditAction.BACKUP_SUCCEEDED]: null,
  [AuditAction.BACKUP_FAILED]: null,
  [AuditAction.ADO_CONFIGURED]: null,
  [AuditAction.ADO_PREPARED]: null,
  [AuditAction.ADO_APPLIED]: null,
  [AuditAction.ADO_CANCELLED]: null,
};

/**
 * Converts item facts to their wire form.
 *
 * @param facts The facts.
 * @returns The compact form.
 */
export function toWire(facts: ItemFacts): WireFacts {
  return { c: facts.createdById, a: [...facts.assigneeIds], b: facts.bucketId, t: facts.teamId };
}

/**
 * Converts wire facts back for {@link ProjectAccessService.canViewItem}.
 *
 * @param wire The compact form.
 * @returns The facts; children do not matter for viewing.
 */
export function fromWire(wire: WireFacts): ItemFacts {
  return {
    createdById: wire.c,
    assigneeIds: wire.a,
    bucketId: wire.b,
    teamId: wire.t,
    hasChildren: false,
  };
}

/**
 * Builds the live message of an audited change, reading the touched items'
 * current facts on the change's own client (so inside its transaction).
 *
 * @param db The change's client.
 * @param record The audit record.
 * @param clientId The acting tab, if known.
 * @returns The message, or null when the action is not live.
 */
export async function auditMessage(
  db: DbClient,
  record: AuditRecord,
  clientId: string | null,
): Promise<LiveMessage | null> {
  const kind = AUDIT_LIVE_KIND[record.action];
  const meta = record.meta ?? {};
  switch (kind) {
    case null:
      return null;
    case 'setting':
      return meta['key'] === 'live' ? { k: 'setting' } : null;
    case 'session': {
      const users = [record.actorId, record.entityType === 'User' ? record.entityId : null];
      const ids = [...new Set(users.filter((u): u is string => typeof u === 'string'))];
      return ids.length === 0 ? null : { k: 'session', users: ids };
    }
    case 'access':
      return record.projectId ? { k: 'access', p: record.projectId } : null;
    case 'board':
      return { k: 'board', p: record.projectId ?? null, u: record.actorId, c: clientId };
    case 'item':
    case 'links': {
      const projectId = record.projectId;
      if (!projectId || !record.entityId) return null;
      // A cascade trashes or restores a whole subtree with one entry; reload instead.
      if (
        (record.action === AuditAction.ITEM_DELETED ||
          record.action === AuditAction.ITEM_TRASHED ||
          record.action === AuditAction.ITEM_RESTORED) &&
        meta['cascade'] === true
      )
        return { k: 'resync', p: projectId };
      const other = kind === 'links' ? meta['blockingItemId'] : undefined;
      const ids = [record.entityId, ...(typeof other === 'string' ? [other] : [])];
      const rows = await db.workItem.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          createdById: true,
          bucketId: true,
          teamId: true,
          deletedAt: true,
          assignees: { select: { userId: true } },
        },
      });
      // A trashed item is gone for every viewer (M12).
      const found = new Map(rows.filter((r) => r.deletedAt === null).map((r) => [r.id, r]));
      const before = record.live?.before;
      const items: WireItem[] = ids.map((id) => {
        const row = found.get(id);
        const f =
          row === undefined
            ? null
            : {
                c: row.createdById,
                a: row.assignees.map((a) => a.userId),
                b: row.bucketId,
                t: row.teamId,
              };
        return id === record.entityId && before !== undefined
          ? { id, f, b: toWire(before) }
          : { id, f };
      });
      return { k: kind, p: projectId, u: record.actorId, c: clientId, i: items };
    }
  }
}

/**
 * Serialises a message, falling back to a project resync when it is too
 * large for a notification.
 *
 * @param message The message; recipient lists are sent in chunks small enough.
 * @returns The payload text, or null when it cannot be sent.
 */
export function payloadOf(message: LiveMessage): string | null {
  const text = JSON.stringify(message);
  if (Buffer.byteLength(text) <= LIVE_PAYLOAD_MAX) return text;
  return 'p' in message && typeof message.p === 'string'
    ? JSON.stringify({ k: 'resync', p: message.p } satisfies LiveMessage)
    : null;
}

/**
 * Sends a message on the channel through the given client. Inside a
 * transaction PostgreSQL delivers it only at commit, so refused or
 * rolled-back changes are never announced.
 *
 * @param db Database or transaction client.
 * @param message The message.
 * @returns Resolves once queued.
 */
export async function sendLive(db: DbClient, message: LiveMessage): Promise<void> {
  const payload = payloadOf(message);
  if (payload !== null) await db.$executeRaw`SELECT pg_notify(${LIVE_CHANNEL}, ${payload})`;
}

/** Recipients per notification message, well inside the payload limit. */
const USERS_PER_MESSAGE = 100;

/**
 * Tells the recipients' streams that they have new notifications, inside
 * the transaction that created them.
 *
 * @param db The change's client.
 * @param userIds The recipients.
 * @returns Resolves once queued.
 */
export async function publishNotifications(
  db: DbClient,
  userIds: readonly string[],
): Promise<void> {
  for (let start = 0; start < userIds.length; start += USERS_PER_MESSAGE)
    await sendLive(db, { k: 'notify', users: userIds.slice(start, start + USERS_PER_MESSAGE) });
}

/**
 * Announces an audited change, inside the change's own transaction.
 *
 * @param db The change's client.
 * @param record The audit record.
 * @returns Resolves once queued; nothing is sent for actions that are not live.
 */
export async function publishAudit(db: DbClient, record: AuditRecord): Promise<void> {
  const message = await auditMessage(db, record, currentClientId());
  if (message !== null) await sendLive(db, message);
}
