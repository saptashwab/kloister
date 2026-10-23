/**
 * Actions written to the audit log. Item actions also feed the item's
 * activity history (SPEC §6).
 */
export const AuditAction = {
  /** Destination configuration changed, without profile content. */
  ADO_CONFIGURED: 'ADO_CONFIGURED',
  /** Recoverable outgoing intent reserved. */
  ADO_PREPARED: 'ADO_PREPARED',
  /** Selected incoming rows applied atomically. */
  ADO_APPLIED: 'ADO_APPLIED',
  /** Pending creates explicitly cancelled with duplicate-risk acknowledgement. */
  ADO_CANCELLED: 'ADO_CANCELLED',
  LOGIN_SUCCEEDED: 'LOGIN_SUCCEEDED',
  LOGIN_FAILED: 'LOGIN_FAILED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  LOGOUT: 'LOGOUT',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  PASSWORD_CHANGE_FAILED: 'PASSWORD_CHANGE_FAILED',
  PASSWORD_RESET: 'PASSWORD_RESET',
  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  ADMIN_BOOTSTRAPPED: 'ADMIN_BOOTSTRAPPED',
  PROJECT_CREATED: 'PROJECT_CREATED',
  PROJECT_UPDATED: 'PROJECT_UPDATED',
  PROJECT_ARCHIVED: 'PROJECT_ARCHIVED',
  PROJECT_UNARCHIVED: 'PROJECT_UNARCHIVED',
  MEMBER_ADDED: 'MEMBER_ADDED',
  MEMBER_UPDATED: 'MEMBER_UPDATED',
  MEMBER_REMOVED: 'MEMBER_REMOVED',
  TEAM_CREATED: 'TEAM_CREATED',
  TEAM_UPDATED: 'TEAM_UPDATED',
  TEAM_DELETED: 'TEAM_DELETED',
  TEAM_MEMBER_SET: 'TEAM_MEMBER_SET',
  TEAM_MEMBER_REMOVED: 'TEAM_MEMBER_REMOVED',
  ITEM_CREATED: 'ITEM_CREATED',
  ITEM_UPDATED: 'ITEM_UPDATED',
  /** The card changed bucket; reordering inside a bucket is not audited. */
  ITEM_MOVED: 'ITEM_MOVED',
  ITEM_DELETED: 'ITEM_DELETED',
  CHECKLIST_ITEM_ADDED: 'CHECKLIST_ITEM_ADDED',
  CHECKLIST_ITEM_UPDATED: 'CHECKLIST_ITEM_UPDATED',
  CHECKLIST_ITEM_REMOVED: 'CHECKLIST_ITEM_REMOVED',
  DEPENDENCY_ADDED: 'DEPENDENCY_ADDED',
  DEPENDENCY_REMOVED: 'DEPENDENCY_REMOVED',
  /** A note was added; the body stays out of the log. */
  NOTE_ADDED: 'NOTE_ADDED',
  NOTE_UPDATED: 'NOTE_UPDATED',
  NOTE_DELETED: 'NOTE_DELETED',
  ATTACHMENT_ADDED: 'ATTACHMENT_ADDED',
  ATTACHMENT_DELETED: 'ATTACHMENT_DELETED',
  BUCKET_CREATED: 'BUCKET_CREATED',
  BUCKET_UPDATED: 'BUCKET_UPDATED',
  BUCKET_DELETED: 'BUCKET_DELETED',
  LABEL_CREATED: 'LABEL_CREATED',
  LABEL_UPDATED: 'LABEL_UPDATED',
  LABEL_DELETED: 'LABEL_DELETED',
  SPRINT_CREATED: 'SPRINT_CREATED',
  SPRINT_UPDATED: 'SPRINT_UPDATED',
  SPRINT_STARTED: 'SPRINT_STARTED',
  SPRINT_CLOSED: 'SPRINT_CLOSED',
  SPRINT_DELETED: 'SPRINT_DELETED',
  /** An admin opened or read a project they are not a member of (SPEC §3.1). */
  ADMIN_CROSS_PROJECT_ACCESS: 'ADMIN_CROSS_PROJECT_ACCESS',
  /** An admin saved an app setting; `meta.key` names it, `meta.value` holds the new value. */
  SETTINGS_UPDATED: 'SETTINGS_UPDATED',
  /** An admin uploaded the logo or a font file (`meta.file`). */
  BRANDING_FILE_UPLOADED: 'BRANDING_FILE_UPLOADED',
  /** An admin removed the logo or a font file (`meta.file`). */
  BRANDING_FILE_REMOVED: 'BRANDING_FILE_REMOVED',
  /** An admin asked for a backup now; the result follows as its own entry. */
  BACKUP_REQUESTED: 'BACKUP_REQUESTED',
  /** A backup finished (`meta`: trigger, file, size, times, pruned files). */
  BACKUP_SUCCEEDED: 'BACKUP_SUCCEEDED',
  /** A backup failed (`meta`: trigger, times, error). */
  BACKUP_FAILED: 'BACKUP_FAILED',
} as const;

/** One of the {@link AuditAction} values. */
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/** An audit log entry as returned by `GET /admin/audit`. */
export interface AuditEntryDto {
  /** Entry id (uuid). */
  id: string;
  /** Acting user id, or null for anonymous/CLI actions. */
  actorId: string | null;
  /** Acting user's email at read time, or null. */
  actorEmail: string | null;
  /** Acting user's display name at read time, or null (M8.5). */
  actorName?: string | null;
  /** Project key at read time; null for personal spaces or no project. */
  projectKey?: string | null;
  /** Project name at read time, or null. */
  projectName?: string | null;
  /**
   * The entity by name at read time: item key, user or member name, project
   * key, bucket/label/sprint/team name; null when deleted or not named.
   */
  entityLabel?: string | null;
  /** What happened. */
  action: string;
  /** Kind of entity affected, e.g. `User`. */
  entityType: string;
  /** Id of the affected entity, if any. */
  entityId: string | null;
  /** Project the action belongs to, if any. */
  projectId: string | null;
  /** Action-specific detail (never contains secrets). */
  meta: Record<string, unknown>;
  /** ISO timestamp. */
  createdAt: string;
}
