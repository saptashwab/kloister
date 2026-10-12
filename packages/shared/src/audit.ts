/**
 * Actions written to the audit log. Later milestones add item actions.
 */
export const AuditAction = {
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
  /** An admin opened or read a project they are not a member of (SPEC §3.1). */
  ADMIN_CROSS_PROJECT_ACCESS: 'ADMIN_CROSS_PROJECT_ACCESS',
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
