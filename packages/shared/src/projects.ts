import type { ItemStatus } from './items.js';

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
  /** Items of the teams the user belongs to (SPEC §3.5). */
  TEAMS: 'TEAMS',
} as const;

/** One of the {@link Visibility} values. */
export type Visibility = (typeof Visibility)[keyof typeof Visibility];

/** Role inside an optional project team (SPEC §3.5). */
export const TeamRole = {
  /** Has Lead rights on the team's items. */
  LEAD: 'LEAD',
  /** Belongs to the team; rights come from the project role. */
  MEMBER: 'MEMBER',
} as const;

/** One of the {@link TeamRole} values. */
export type TeamRole = (typeof TeamRole)[keyof typeof TeamRole];

/** Longest team name accepted. */
export const TEAM_NAME_MAX = 100;

/** Longest team description accepted. */
export const TEAM_DESCRIPTION_MAX = 1000;

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
  /**
   * Grant or take away the PM role: add a user as PM, promote a member to
   * PM, demote or remove a PM (SPEC §3.1). PMs have it through their role;
   * system admins have it in every project, member or not.
   */
  ASSIGN_PMS: 'ASSIGN_PMS',
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
 * "assign items to others" project setting and the admin right to assign
 * PMs.
 *
 * The API is the authority (SPEC §3.4); the web app uses the same function
 * only to hide controls.
 *
 * @param role The member's project role, or null for a system admin who is
 *   not a member (read-only, plus assigning PMs).
 * @param settings The project's settings.
 * @param isSystemAdmin Whether the caller has the ADMIN system role, which
 *   adds `ASSIGN_PMS` in every project.
 * @returns The granted permissions.
 */
export function permissionsFor(
  role: ProjectRole | null,
  settings: Pick<ProjectSettings, 'membersCanAssignOthers'>,
  isSystemAdmin = false,
): ProjectPermission[] {
  const granted: ProjectPermission[] = role === null ? [P.VIEW_ITEMS] : [...ROLE_PERMISSIONS[role]];
  if (role === ProjectRole.MEMBER && settings.membersCanAssignOthers) {
    granted.push(P.ASSIGN_OTHERS);
  }
  if (isSystemAdmin && !granted.includes(P.ASSIGN_PMS)) granted.push(P.ASSIGN_PMS);
  return granted;
}

/**
 * Reports whether a caller may change memberships only as far as the PM
 * role goes: they hold `ASSIGN_PMS` (a system admin) but not
 * `MANAGE_MEMBERS` (not a PM of the project).
 *
 * @param permissions The caller's permissions.
 * @returns True when only PM-role changes are allowed.
 */
export function assignsPmsOnly(permissions: Iterable<ProjectPermission>): boolean {
  const set = new Set(permissions);
  return set.has(P.ASSIGN_PMS) && !set.has(P.MANAGE_MEMBERS);
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
 * Optional map of status to bucket id (SPEC §4.2): when an item's status
 * changes from the detail view, the card moves to the mapped bucket.
 */
export type StatusToBucket = Partial<Record<ItemStatus, string>>;

/**
 * Project settings stored in `Project.settings` (SPEC §4). M8 adds the ADO
 * export settings.
 */
export interface ProjectSettings {
  /** Lets Members assign items to others (SPEC §3.2; default off). */
  membersCanAssignOthers: boolean;
  /** Status → bucket moves; only buckets of the project, empty by default. */
  statusToBucket: StatusToBucket;
  /** How labels are drawn on cards and in the drawer (SPEC §4, §6; set by PMs). */
  labelStyle: LabelStyle;
}

/**
 * Label styles a PM can choose per project (SPEC §4, docs/DESIGN.md §4.2):
 * full-colour pills, soft tinted pills, or tinted pills plus a colour bar
 * across the top of the card.
 */
export const LabelStyle = {
  /** Full-colour fill with automatically chosen text (the default). */
  SOLID: 'SOLID',
  /** Soft fill of the label colour with darker or lighter text. */
  TINTED: 'TINTED',
  /** Tinted pills plus a bar in the first label's colour on the card. */
  COVER: 'COVER',
} as const;

/** One of the {@link LabelStyle} values. */
export type LabelStyle = (typeof LabelStyle)[keyof typeof LabelStyle];

/** Settings of a new project. */
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  membersCanAssignOthers: false,
  statusToBucket: {},
  labelStyle: LabelStyle.SOLID,
};

/** A project as the API returns it, from the caller's point of view. */
export interface ProjectDto {
  /** Project id (uuid). */
  id: string;
  /** Unique key, or null for a personal space. */
  key: string | null;
  /** Personal owner; null for an ordinary project. */
  ownerId: string | null;
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
  /** The caller's teams in this project and their role in each. */
  myTeams: { teamId: string; role: TeamRole }[];
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
  /** The Project Managers (SPEC §3.1): one or more distinct active users. */
  pmUserIds: string[];
}

/** Most PMs that can be named when creating a project. */
export const MAX_INITIAL_PMS = 20;

/** Body of `PATCH /projects/:id` (PM only). Omitted fields are left unchanged. */
export interface UpdateProjectRequest {
  /** New display name. */
  name?: string;
  /** New description. */
  description?: string;
  /** Settings to change; `statusToBucket` replaces the whole map. */
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

/** A team member as returned inside {@link TeamDto}. */
export interface TeamMemberDto {
  /** The member's user id. */
  userId: string;
  /** The member's email. */
  email: string;
  /** The member's display name. */
  displayName: string;
  /** False when the account is deactivated. */
  isActive: boolean;
  /** Role in this team. */
  role: TeamRole;
}

/** A team as returned by `GET /projects/:id/teams`. */
export interface TeamDto {
  /** Team id (uuid). */
  id: string;
  /** Name, unique within the project. */
  name: string;
  /** Plain-text description; may be empty. */
  description: string;
  /** Members ordered by name. */
  members: TeamMemberDto[];
  /** ISO timestamp of creation. */
  createdAt: string;
}

/** Body of `POST /projects/:id/teams` (PM only). */
export interface CreateTeamRequest {
  /** Name, unique within the project. */
  name: string;
  /** Optional description. */
  description?: string;
}

/** Body of `PATCH /projects/:id/teams/:teamId` (PM only). */
export interface UpdateTeamRequest {
  /** New name. */
  name?: string;
  /** New description. */
  description?: string;
}

/** Body of `PUT /projects/:id/teams/:teamId/members/:userId` (PM only). */
export interface SetTeamMemberRequest {
  /** Role in the team. Project Viewers may only be `MEMBER`. */
  role: TeamRole;
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
