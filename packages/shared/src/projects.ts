/**
 * Per-project roles (SPEC §3.2). System admins have no project role unless
 * they are also added as members.
 */
export const ProjectRole = {
  PM: 'PM',
  LEAD: 'LEAD',
  MEMBER: 'MEMBER',
  VIEWER: 'VIEWER',
} as const;

/** One of the {@link ProjectRole} values. */
export type ProjectRole = (typeof ProjectRole)[keyof typeof ProjectRole];

/**
 * Which items a Member or Viewer sees (SPEC §3.3). PMs and Leads always see
 * everything, whatever is stored for them.
 */
export const Visibility = {
  /** Every item in the project. */
  ALL: 'ALL',
  /** Items in the buckets the PM selected. */
  BUCKETS: 'BUCKETS',
  /** Items assigned to or created by the user. */
  OWN: 'OWN',
} as const;

/** One of the {@link Visibility} values. */
export type Visibility = (typeof Visibility)[keyof typeof Visibility];

/**
 * Permission names, one per row of the SPEC §3.2 table. Rows with a
 * condition ("own/assigned only", "own created, no children") are split into
 * an unconditional and an `_OWN` permission; the API checks the condition
 * against the item.
 */
export const ProjectPermission = {
  /** View items within the visibility scope. */
  VIEW_ITEMS: 'VIEW_ITEMS',
  /** Create items. */
  CREATE_ITEMS: 'CREATE_ITEMS',
  /** Edit any item. */
  EDIT_ANY_ITEM: 'EDIT_ANY_ITEM',
  /** Edit items assigned to or created by self. */
  EDIT_OWN_ITEMS: 'EDIT_OWN_ITEMS',
  /** Assign items to other users (Members: only when the project setting allows it). */
  ASSIGN_OTHERS: 'ASSIGN_OTHERS',
  /** Move any card between buckets. */
  MOVE_ANY_ITEM: 'MOVE_ANY_ITEM',
  /** Move cards assigned to or created by self. */
  MOVE_OWN_ITEMS: 'MOVE_OWN_ITEMS',
  /** Delete any item, including with `?cascade=true` (SPEC §4.1). */
  DELETE_ANY_ITEM: 'DELETE_ANY_ITEM',
  /** Delete items created by self that have no children. */
  DELETE_OWN_ITEMS: 'DELETE_OWN_ITEMS',
  /** Add notes and attachments on visible items. */
  ANNOTATE_ITEMS: 'ANNOTATE_ITEMS',
  /** Manage buckets, labels and sprints. */
  MANAGE_BOARD: 'MANAGE_BOARD',
  /** Manage members, roles and visibility. */
  MANAGE_MEMBERS: 'MANAGE_MEMBERS',
  /** Project settings, ADO settings, archive project. */
  MANAGE_PROJECT: 'MANAGE_PROJECT',
  /** ADO CSV export. */
  EXPORT_ADO: 'EXPORT_ADO',
} as const;

/** One of the {@link ProjectPermission} values. */
export type ProjectPermission = (typeof ProjectPermission)[keyof typeof ProjectPermission];

const P = ProjectPermission;

/** Unconditional permissions of each role, straight from the SPEC §3.2 table. */
const ROLE_PERMISSIONS: Record<ProjectRole, readonly ProjectPermission[]> = {
  PM: Object.values(P),
  LEAD: [
    P.VIEW_ITEMS,
    P.CREATE_ITEMS,
    P.EDIT_ANY_ITEM,
    P.EDIT_OWN_ITEMS,
    P.ASSIGN_OTHERS,
    P.MOVE_ANY_ITEM,
    P.MOVE_OWN_ITEMS,
    P.DELETE_ANY_ITEM,
    P.DELETE_OWN_ITEMS,
    P.ANNOTATE_ITEMS,
    P.MANAGE_BOARD,
    P.EXPORT_ADO,
  ],
  MEMBER: [
    P.VIEW_ITEMS,
    P.CREATE_ITEMS,
    P.EDIT_OWN_ITEMS,
    P.MOVE_OWN_ITEMS,
    P.DELETE_OWN_ITEMS,
    P.ANNOTATE_ITEMS,
  ],
  VIEWER: [P.VIEW_ITEMS],
};

/**
 * Resolves the permissions a project role grants, including the Member
 * "assign items to others" project setting.
 *
 * The API is the authority (SPEC §3.4); the web app uses the same function
 * only to hide controls.
 *
 * @param role The member's project role, or null for a system admin who is
 *   not a member (read-only access).
 * @param settings The project's settings.
 * @returns The granted permissions.
 */
export function permissionsFor(
  role: ProjectRole | null,
  settings: Pick<ProjectSettings, 'membersCanAssignOthers'>,
): ProjectPermission[] {
  if (role === null) return [P.VIEW_ITEMS];
  const granted = [...ROLE_PERMISSIONS[role]];
  if (role === ProjectRole.MEMBER && settings.membersCanAssignOthers) {
    granted.push(P.ASSIGN_OTHERS);
  }
  return granted;
}

/**
 * Reports whether a role's visibility scope applies. PMs and Leads always see
 * every item (SPEC §3.3).
 *
 * @param role Project role, or null for a non-member admin.
 * @returns True for Member and Viewer.
 */
export function isScopedRole(role: ProjectRole | null): boolean {
  return role === ProjectRole.MEMBER || role === ProjectRole.VIEWER;
}

/**
 * Project keys: 2–6 uppercase letters, used in item numbers like `KLO-42`
 * (SPEC §4).
 */
export const PROJECT_KEY_PATTERN = /^[A-Z]{2,6}$/;

/** Longest project name accepted. */
export const PROJECT_NAME_MAX = 100;

/** Longest project description accepted. */
export const PROJECT_DESCRIPTION_MAX = 2000;

/**
 * Project settings stored in `Project.settings` (SPEC §4). M3 adds
 * `statusToBucket`, M8 the ADO export settings.
 */
export interface ProjectSettings {
  /** Lets Members assign items to others (SPEC §3.2; default off). */
  membersCanAssignOthers: boolean;
}

/** Settings of a new project. */
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = { membersCanAssignOthers: false };

/** A project as the API returns it, from the caller's point of view. */
export interface ProjectDto {
  /** Project id (uuid). */
  id: string;
  /** Unique key, e.g. `KLO`. */
  key: string;
  /** Display name. */
  name: string;
  /** Plain-text description; may be empty. */
  description: string;
  /** ISO timestamp when archived, or null. Archived projects are read-only. */
  archivedAt: string | null;
  /** Project settings. */
  settings: ProjectSettings;
  /** The caller's role, or null when an admin views a project they are not a member of. */
  myRole: ProjectRole | null;
  /** The caller's effective visibility scope. */
  myVisibility: Visibility;
  /** What the caller may do here; the UI uses this only to hide controls. */
  myPermissions: ProjectPermission[];
  /** ISO timestamp of creation. */
  createdAt: string;
}

/** Body of `POST /projects` (admins only). */
export interface CreateProjectRequest {
  /** Unique key, 2–6 letters; lowercase input is uppercased. */
  key: string;
  /** Display name. */
  name: string;
  /** Optional plain-text description. */
  description?: string;
  /** The first Project Manager (SPEC §3.1). Must be an active user. */
  pmUserId: string;
}

/** Body of `PATCH /projects/:id` (PM only). Omitted fields are left unchanged. */
export interface UpdateProjectRequest {
  /** New display name. */
  name?: string;
  /** New description. */
  description?: string;
  /** Settings to change. */
  settings?: Partial<ProjectSettings>;
}

/** A project member as returned by `GET /projects/:id/members`. */
export interface ProjectMemberDto {
  /** Membership id (uuid). */
  id: string;
  /** The member's user id. */
  userId: string;
  /** The member's email. */
  email: string;
  /** The member's display name. */
  displayName: string;
  /** False when the account is deactivated. */
  isActive: boolean;
  /** Project role. */
  role: ProjectRole;
  /** Stored visibility scope (ignored for PM and Lead). */
  visibility: Visibility;
  /** Buckets visible under `BUCKETS` scope. */
  allowedBucketIds: string[];
  /** ISO timestamp when added. */
  createdAt: string;
}

/** Body of `POST /projects/:id/members` (PM only). */
export interface AddMemberRequest {
  /** User to add; must be active and not already a member. */
  userId: string;
  /** Project role. */
  role: ProjectRole;
  /** Visibility scope; defaults to `ALL`. Forced to `ALL` for PM and Lead. */
  visibility?: Visibility;
  /** Buckets visible under `BUCKETS` scope. */
  allowedBucketIds?: string[];
}

/** Body of `PATCH /projects/:id/members/:userId` (PM only). */
export interface UpdateMemberRequest {
  /** New role. Demoting the last active PM is rejected. */
  role?: ProjectRole;
  /** New visibility scope. */
  visibility?: Visibility;
  /** New bucket list for `BUCKETS` scope. */
  allowedBucketIds?: string[];
}

/** A user that can be added to a project, from `GET /projects/:id/member-candidates`. */
export interface MemberCandidateDto {
  /** User id. */
  id: string;
  /** Email. */
  email: string;
  /** Display name. */
  displayName: string;
}
