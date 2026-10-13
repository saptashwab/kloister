import { HttpStatus, Injectable } from '@nestjs/common';
import {
  assignsPmsOnly,
  AuditAction,
  ErrorCode,
  isScopedRole,
  permissionsFor,
  PROJECT_KEY_PATTERN,
  type ProjectPermission,
  ProjectPermission as P,
  ProjectRole,
  type ProjectSettings,
  SystemRole,
  TeamRole,
  Visibility,
} from '@kloister/shared';
import { isUUID } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { ApiException } from '../common/api-exception.js';
import type { Prisma, Project } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseProjectSettings } from './project-settings.js';

/** The caller's place in one team of the project. */
export interface TeamPlace {
  /** Team id. */
  teamId: string;
  /** The caller's role in that team. */
  role: TeamRole;
}

/**
 * The caller's resolved access to one project. Built once per request by
 * {@link ProjectAccessService.resolve} and passed to every check, so all
 * decisions for a request use the same membership snapshot.
 */
export interface ProjectAccess {
  /** The project row. */
  project: Project;
  /** Validated project settings. */
  settings: ProjectSettings;
  /** The caller's user id. */
  userId: string;
  /**
   * The caller's project role, or null for a system admin who is not a
   * member (read-only plus assigning PMs, audited as
   * `ADMIN_CROSS_PROJECT_ACCESS`).
   */
  role: ProjectRole | null;
  /** True when the caller has the ADMIN system role. */
  isSystemAdmin: boolean;
  /** Effective visibility: always `ALL` for PM, Lead and non-member admins. */
  visibility: Visibility;
  /** Visible buckets when {@link visibility} is `BUCKETS`; empty otherwise. */
  allowedBucketIds: readonly string[];
  /** The caller's teams in this project (SPEC §3.5); empty for non-members. */
  teams: readonly TeamPlace[];
  /** Granted permissions (SPEC §3.2, plus `ASSIGN_PMS` for admins, SPEC §3.1). */
  permissions: ReadonlySet<ProjectPermission>;
}

/**
 * The facts about a work item that permission checks need, so every item
 * endpoint uses the same rules.
 */
export interface ItemFacts {
  /** Creator's user id. */
  createdById: string;
  /** Assignee user ids. */
  assigneeIds: readonly string[];
  /** Bucket id; null for Epics and Features outside the board. */
  bucketId: string | null;
  /** Team id; null for items outside any team. */
  teamId: string | null;
  /** True when the item has child items. */
  hasChildren: boolean;
}

/**
 * Prisma `where` fragment restricting work items to the caller's visibility
 * scope (SPEC §3.3), widened by the items of teams they lead (SPEC §3.5).
 * Combine it with `AND` into every query that returns items to the caller.
 */
export type ItemScopeFilter = Prisma.WorkItemWhereInput;

/** Where a project reference from the URL points. */
type ProjectLookup = { id: string } | { key: string };

/**
 * The single place where project authorization is decided (SPEC §3.4).
 *
 * - {@link resolve} loads the caller's membership and teams. Non-members get
 *   404 so project existence is not revealed; system admins who are not
 *   members get read-only access plus PM assignment, and every such request
 *   is audited (SPEC §3.1).
 * - {@link has} answers the role table in SPEC §3.2.
 * - The item checks combine the role table with the visibility scope, the
 *   "own" conditions and team leadership (SPEC §3.5), and
 *   {@link itemScopeFilter} builds the same visibility into queries. Items
 *   outside it must be answered with 404, not 403.
 *
 * The item checks do not look at `archivedAt`: every item write is a
 * non-GET route behind `ProjectAccessGuard`, which refuses writes to
 * archived projects.
 *
 * Admins who are members are bound by their membership like anyone else,
 * except that every admin may assign PMs (`ASSIGN_PMS`).
 */
@Injectable()
export class ProjectAccessService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param audit Audit log, for cross-project admin access.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Resolves the caller's access to a project referenced by id or key.
   *
   * Permissions: members get their role's access; system admins who are not
   * members get read-only access plus `ASSIGN_PMS`, and an
   * `ADMIN_CROSS_PROJECT_ACCESS` entry is written before anything is
   * returned; everyone else gets 404. Admins always hold `ASSIGN_PMS`.
   *
   * @param auth The signed-in caller.
   * @param ref Project uuid or key (case-insensitive) from the URL.
   * @param via Short description of the request, recorded in the audit entry.
   * @returns The caller's access.
   */
  async resolve(auth: AuthContext, ref: string, via: string): Promise<ProjectAccess> {
    const lookup = parseProjectRef(ref);
    if (lookup === null) throw projectNotFound();
    const userId = auth.user.id;
    const project = await this.prisma.project.findUnique({
      where: lookup,
      include: {
        members: {
          where: { userId },
          include: { teamMemberships: { select: { teamId: true, role: true } } },
        },
      },
    });
    if (project === null) throw projectNotFound();

    const { members, ...row } = project;
    const settings = parseProjectSettings(row.settings);
    const member = members[0];
    const isSystemAdmin = auth.user.systemRole === SystemRole.ADMIN;
    if (member !== undefined) return memberAccess(row, member, userId, isSystemAdmin);

    if (!isSystemAdmin) throw projectNotFound();
    await this.audit.record({
      actorId: userId,
      action: AuditAction.ADMIN_CROSS_PROJECT_ACCESS,
      entityType: 'Project',
      entityId: row.id,
      projectId: row.id,
      meta: { via },
    });
    return {
      project: row,
      settings,
      userId,
      role: null,
      isSystemAdmin,
      visibility: Visibility.ALL,
      allowedBucketIds: [],
      teams: [],
      permissions: new Set(permissionsFor(null, settings, true)),
    };
  }

  /**
   * Resolves the caller's access to every project they are a member of and
   * that is not archived, for lists that span projects (the "all their
   * work" list, SPEC §6). Each access is built exactly as {@link resolve}
   * builds a member's access, so the same scope rules apply per project.
   *
   * Permissions: membership only. Projects a system admin is not a member of
   * are left out, so such a list never reads them (and writes no
   * `ADMIN_CROSS_PROJECT_ACCESS` entries).
   *
   * @param auth The signed-in caller.
   * @returns One access per project, ordered by project key.
   */
  async memberAccesses(auth: AuthContext): Promise<ProjectAccess[]> {
    const userId = auth.user.id;
    const isSystemAdmin = auth.user.systemRole === SystemRole.ADMIN;
    const rows = await this.prisma.projectMember.findMany({
      where: { userId, project: { archivedAt: null } },
      include: { project: true, teamMemberships: { select: { teamId: true, role: true } } },
      orderBy: { project: { key: 'asc' } },
    });
    return rows.map(({ project, ...member }) =>
      memberAccess(project, member, userId, isSystemAdmin),
    );
  }

  /**
   * Reports whether the caller's role grants a permission (SPEC §3.2).
   * Conditional rows (own items, no children, team items) need the item
   * checks below.
   *
   * @param access The caller's access.
   * @param permission The permission.
   * @returns True if granted.
   */
  has(access: ProjectAccess, permission: ProjectPermission): boolean {
    return access.permissions.has(permission);
  }

  /**
   * Throws unless the caller holds a permission and, when the request
   * changes data, the project is not archived.
   *
   * Permissions: 403 `FORBIDDEN` when the role lacks the permission (the
   * caller can already see the project, so 404 would hide nothing); 409
   * `PROJECT_ARCHIVED` when `blockIfArchived` is set and the project is
   * archived. The guard sets it for every non-GET request except unarchive
   * and admin PM assignment.
   *
   * @param access The caller's access.
   * @param permission The permission required.
   * @param blockIfArchived Refuse the request on archived projects (writes).
   */
  assert(access: ProjectAccess, permission: ProjectPermission, blockIfArchived: boolean): void {
    if (!this.has(access, permission)) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Your project role does not allow this',
      );
    }
    if (blockIfArchived && access.project.archivedAt !== null) throw projectArchived();
  }

  /**
   * Builds the visibility filter for work item queries (SPEC §3.3), widened
   * by the items of teams the caller leads (SPEC §3.5).
   *
   * @param access The caller's access.
   * @returns An empty filter for `ALL`; otherwise the scope's condition,
   *   OR-ed with the led teams' items when there are any.
   */
  itemScopeFilter(access: ProjectAccess): ItemScopeFilter {
    const condition = this.scopeCondition(access);
    if (condition === null) return {};
    const led = ledTeamIds(access);
    return led.length === 0 ? condition : { OR: [condition, { teamId: { in: led } }] };
  }

  /**
   * Reports whether an item is visible to the caller: inside their scope, or
   * in a team they lead. Items outside must be answered with 404 (SPEC §3.4).
   *
   * @param access The caller's access.
   * @param item The item.
   * @returns True if the caller may see the item in full.
   */
  canViewItem(access: ProjectAccess, item: ItemFacts): boolean {
    if (!this.has(access, P.VIEW_ITEMS)) return false;
    return this.inScope(access, item) || leadsItemTeam(access, item);
  }

  /**
   * Reports whether ancestors of visible items are shown as read-only titles
   * only (SPEC §3.3), i.e. whether the caller's scope is restricted.
   *
   * @param access The caller's access.
   * @returns True under `BUCKETS`, `OWN` and `TEAMS` scope.
   */
  ancestorsAreTitleOnly(access: ProjectAccess): boolean {
    return access.visibility !== Visibility.ALL;
  }

  /**
   * Edit rule: any visible item with `EDIT_ANY_ITEM`, own items with
   * `EDIT_OWN_ITEMS`, or items of a team the caller leads.
   *
   * @param access The caller's access.
   * @param item The item.
   * @returns True if the caller may edit the item.
   */
  canEditItem(access: ProjectAccess, item: ItemFacts): boolean {
    return (
      this.canViewItem(access, item) &&
      (this.anyOrOwn(access, item, P.EDIT_ANY_ITEM, P.EDIT_OWN_ITEMS) ||
        leadsItemTeam(access, item))
    );
  }

  /**
   * Move rule: any visible card with `MOVE_ANY_ITEM`, own/assigned cards
   * with `MOVE_OWN_ITEMS`, or cards of a team the caller leads.
   *
   * @param access The caller's access.
   * @param item The item.
   * @returns True if the caller may move the card between buckets.
   */
  canMoveItem(access: ProjectAccess, item: ItemFacts): boolean {
    return (
      this.canViewItem(access, item) &&
      (this.anyOrOwn(access, item, P.MOVE_ANY_ITEM, P.MOVE_OWN_ITEMS) ||
        leadsItemTeam(access, item))
    );
  }

  /**
   * Delete rule (SPEC §3.2, §3.5, §4.1): project PMs and Leads may delete any
   * visible item, with or without cascade; team Leads may delete their
   * team's items without cascade (a subtree may span other teams); Members
   * only items they created that have no children, never with cascade.
   * Callers allowed here still get 409 `HAS_CHILDREN` for a non-cascade
   * delete of an item with children (SPEC §4.1).
   *
   * @param access The caller's access.
   * @param item The item.
   * @param cascade Whether `?cascade=true` was requested.
   * @returns True if the caller may delete the item.
   */
  canDeleteItem(access: ProjectAccess, item: ItemFacts, cascade: boolean): boolean {
    if (!this.canViewItem(access, item)) return false;
    if (this.has(access, P.DELETE_ANY_ITEM)) return true;
    if (cascade) return false;
    if (leadsItemTeam(access, item)) return true;
    return (
      this.has(access, P.DELETE_OWN_ITEMS) &&
      !item.hasChildren &&
      item.createdById === access.userId
    );
  }

  /**
   * Notes and attachments rule: any visible item with `ANNOTATE_ITEMS`.
   *
   * @param access The caller's access.
   * @param item The item.
   * @returns True if the caller may add notes and attachments.
   */
  canAnnotateItem(access: ProjectAccess, item: ItemFacts): boolean {
    return this.canViewItem(access, item) && this.has(access, P.ANNOTATE_ITEMS);
  }

  /**
   * Assignment rule: assigning only yourself needs no extra permission;
   * assigning anyone else needs `ASSIGN_OTHERS` (Members get it only when
   * the project setting is on), or leading the item's team. The caller must
   * separately be allowed to create or edit the item.
   *
   * @param access The caller's access.
   * @param assigneeIds Users the caller is adding as assignees.
   * @param item The item's team, when the item has or gets one.
   * @param item.teamId Team id, or null.
   * @returns True if the assignment is allowed.
   */
  canAssign(
    access: ProjectAccess,
    assigneeIds: readonly string[],
    item: { teamId: string | null } = { teamId: null },
  ): boolean {
    return (
      assigneeIds.every((id) => id === access.userId) ||
      this.has(access, P.ASSIGN_OTHERS) ||
      leadsItemTeam(access, item)
    );
  }

  /**
   * Team rule (SPEC §3.5): who may put an item into a team or take it out.
   * Project PMs and Leads may set any team. Anyone else may only move an item
   * between "no team" and the teams they lead; when creating an item, a team
   * Member may also put it into one of their own teams, so callers with the
   * `TEAMS` scope can create items they will see. The caller must separately
   * be allowed to create or edit the item.
   *
   * @param access The caller's access.
   * @param from The item's current team (null for none or a new item).
   * @param to The requested team.
   * @param creating True when the item is being created.
   * @returns True if the change is allowed.
   */
  canSetTeam(
    access: ProjectAccess,
    from: string | null,
    to: string | null,
    creating: boolean,
  ): boolean {
    if (from === to) return true;
    if (access.role === ProjectRole.PM || access.role === ProjectRole.LEAD) return true;
    const led = ledTeamIds(access);
    const leftOk = from === null || led.includes(from);
    const joinOk =
      to === null ||
      led.includes(to) ||
      (creating && access.role === ProjectRole.MEMBER && access.teams.some((t) => t.teamId === to));
    return leftOk && joinOk;
  }

  /**
   * The condition of the caller's visibility scope, or null for `ALL`.
   *
   * @param access The caller's access.
   * @returns The condition.
   */
  private scopeCondition(access: ProjectAccess): Prisma.WorkItemWhereInput | null {
    switch (access.visibility) {
      case Visibility.ALL:
        return null;
      case Visibility.BUCKETS:
        return { bucketId: { in: [...access.allowedBucketIds] } };
      case Visibility.OWN:
        return {
          OR: [{ createdById: access.userId }, { assignees: { some: { userId: access.userId } } }],
        };
      case Visibility.TEAMS:
        return { teamId: { in: access.teams.map((t) => t.teamId) } };
    }
  }

  /**
   * Reports whether an item is inside the caller's visibility scope.
   *
   * @param access The caller's access.
   * @param item The item.
   * @returns True if the scope covers the item.
   */
  private inScope(access: ProjectAccess, item: ItemFacts): boolean {
    switch (access.visibility) {
      case Visibility.ALL:
        return true;
      case Visibility.BUCKETS:
        return item.bucketId !== null && access.allowedBucketIds.includes(item.bucketId);
      case Visibility.OWN:
        return this.isOwn(access, item);
      case Visibility.TEAMS:
        return item.teamId !== null && access.teams.some((t) => t.teamId === item.teamId);
    }
  }

  /**
   * Reports whether an item is assigned to or created by the caller.
   *
   * @param access The caller's access.
   * @param item The item.
   * @returns True for own items.
   */
  private isOwn(access: ProjectAccess, item: ItemFacts): boolean {
    return item.createdById === access.userId || item.assigneeIds.includes(access.userId);
  }

  /**
   * Shared shape of the edit and move rules.
   *
   * @param access The caller's access.
   * @param item The item.
   * @param any Permission covering every item.
   * @param own Permission covering own items.
   * @returns True if either applies.
   */
  private anyOrOwn(
    access: ProjectAccess,
    item: ItemFacts,
    any: ProjectPermission,
    own: ProjectPermission,
  ): boolean {
    return this.has(access, any) || (this.has(access, own) && this.isOwn(access, item));
  }
}

/**
 * Builds a project member's access from their membership row: the role's
 * permissions, and the stored visibility scope for Members and Viewers (PMs
 * and Leads always see everything, SPEC §3.3).
 *
 * @param project The project row.
 * @param member The caller's membership with their team places.
 * @param member.role Project role.
 * @param member.visibility Stored visibility scope.
 * @param member.allowedBucketIds Buckets for the `BUCKETS` scope.
 * @param member.teamMemberships The caller's teams in the project.
 * @param userId The caller's user id.
 * @param isSystemAdmin Whether the caller is a system admin.
 * @returns The access.
 */
function memberAccess(
  project: Project,
  member: {
    role: ProjectRole;
    visibility: Visibility;
    allowedBucketIds: string[];
    teamMemberships: TeamPlace[];
  },
  userId: string,
  isSystemAdmin: boolean,
): ProjectAccess {
  const settings = parseProjectSettings(project.settings);
  const scoped = isScopedRole(member.role);
  return {
    project,
    settings,
    userId,
    role: member.role,
    isSystemAdmin,
    visibility: scoped ? member.visibility : Visibility.ALL,
    allowedBucketIds:
      scoped && member.visibility === Visibility.BUCKETS ? member.allowedBucketIds : [],
    teams: member.teamMemberships,
    permissions: new Set(permissionsFor(member.role, settings, isSystemAdmin)),
  };
}

/**
 * Ids of the teams whose items the caller has Lead rights on (SPEC §3.5).
 * Viewers never do, even if a stored row says otherwise, and non-members
 * have no teams.
 *
 * @param access The caller's access.
 * @returns Team ids.
 */
export function ledTeamIds(access: ProjectAccess): string[] {
  if (access.role === null || access.role === ProjectRole.VIEWER) return [];
  return access.teams.filter((t) => t.role === TeamRole.LEAD).map((t) => t.teamId);
}

/**
 * Reports whether the caller leads the item's team.
 *
 * @param access The caller's access.
 * @param item The item's team.
 * @param item.teamId Team id, or null.
 * @returns True if the item has a team the caller leads.
 */
function leadsItemTeam(access: ProjectAccess, item: { teamId: string | null }): boolean {
  return item.teamId !== null && ledTeamIds(access).includes(item.teamId);
}

/**
 * Parses a project reference from the URL.
 *
 * @param ref A project uuid or key.
 * @returns The lookup, or null if it is neither.
 */
export function parseProjectRef(ref: string): ProjectLookup | null {
  if (isUUID(ref)) return { id: ref.toLowerCase() };
  const key = ref.toUpperCase();
  return PROJECT_KEY_PATTERN.test(key) ? { key } : null;
}

/**
 * Reports whether a membership change by this caller is limited to the PM
 * role (SPEC §3.1): true for system admins who are not PMs of the project,
 * and for every system admin while the project is archived (the PM-role
 * exception is then the only write an admin may make, so a project left
 * without an active PM can always be recovered).
 *
 * @param access The caller's access.
 * @returns True when only PM-role changes are allowed.
 */
export function pmAssignmentOnly(access: ProjectAccess): boolean {
  return (
    assignsPmsOnly(access.permissions) ||
    (access.isSystemAdmin && access.project.archivedAt !== null)
  );
}

/**
 * The 409 returned for changes to an archived (read-only) project.
 *
 * @returns The exception to throw.
 */
export function projectArchived(): ApiException {
  return new ApiException(
    HttpStatus.CONFLICT,
    ErrorCode.PROJECT_ARCHIVED,
    'This project is archived and read-only',
  );
}

/**
 * The 404 returned for projects that do not exist or that the caller may
 * not see; the two cases are indistinguishable on purpose.
 *
 * @returns The exception to throw.
 */
export function projectNotFound(): ApiException {
  return new ApiException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Project not found');
}
