import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AuditAction,
  ErrorCode,
  isScopedRole,
  permissionsFor,
  PROJECT_KEY_PATTERN,
  type ProjectPermission,
  ProjectPermission as P,
  type ProjectRole,
  type ProjectSettings,
  SystemRole,
  Visibility,
} from '@kloister/shared';
import { isUUID } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { ApiException } from '../common/api-exception.js';
import type { Project } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseProjectSettings } from './project-settings.js';

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
   * member (read-only access, audited as `ADMIN_CROSS_PROJECT_ACCESS`).
   */
  role: ProjectRole | null;
  /** Effective visibility: always `ALL` for PM, Lead and non-member admins. */
  visibility: Visibility;
  /** Visible buckets when {@link visibility} is `BUCKETS`; empty otherwise. */
  allowedBucketIds: readonly string[];
  /** Granted permissions (SPEC §3.2). */
  permissions: ReadonlySet<ProjectPermission>;
}

/**
 * The facts about a work item that permission checks need. Work items arrive
 * in M3; the checks are defined here so every item endpoint uses the same
 * rules.
 */
export interface ItemFacts {
  /** Creator's user id. */
  createdById: string;
  /** Assignee user ids. */
  assigneeIds: readonly string[];
  /** Bucket id; null for Epics and Features outside the board. */
  bucketId: string | null;
  /** True when the item has child items. */
  hasChildren: boolean;
}

/**
 * Prisma-compatible `where` fragment restricting work items to the caller's
 * visibility scope (SPEC §3.3). Combine it with `AND` into every item query.
 * M3 narrows this to `Prisma.WorkItemWhereInput` once the table exists.
 */
export type ItemScopeFilter =
  | Record<string, never>
  | { bucketId: { in: string[] } }
  | { OR: [{ createdById: string }, { assignees: { some: { userId: string } } }] };

/** Where a project reference from the URL points. */
type ProjectLookup = { id: string } | { key: string };

/**
 * The single place where project authorization is decided (SPEC §3.4).
 *
 * - {@link resolve} loads the caller's membership. Non-members get 404 so
 *   project existence is not revealed; system admins who are not members get
 *   read-only access and every such request is audited (SPEC §3.1).
 * - {@link has} answers the role table in SPEC §3.2.
 * - The item checks combine the role table with the visibility scope and
 *   "own" conditions, and {@link itemScopeFilter} builds the scope into
 *   queries. Items outside the scope must be answered with 404, not 403.
 *
 * Admins who are members are bound by their membership like anyone else.
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
   * members get read-only access and an `ADMIN_CROSS_PROJECT_ACCESS` entry is
   * written before anything is returned; everyone else gets 404.
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
      include: { members: { where: { userId } } },
    });
    if (project === null) throw projectNotFound();

    const { members, ...row } = project;
    const settings = parseProjectSettings(row.settings);
    const member = members[0];
    if (member !== undefined) {
      const scoped = isScopedRole(member.role);
      return {
        project: row,
        settings,
        userId,
        role: member.role,
        visibility: scoped ? member.visibility : Visibility.ALL,
        allowedBucketIds:
          scoped && member.visibility === Visibility.BUCKETS ? member.allowedBucketIds : [],
        permissions: new Set(permissionsFor(member.role, settings)),
      };
    }

    if (auth.user.systemRole !== SystemRole.ADMIN) throw projectNotFound();
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
      visibility: Visibility.ALL,
      allowedBucketIds: [],
      permissions: new Set(permissionsFor(null, settings)),
    };
  }

  /**
   * Reports whether the caller's role grants a permission (SPEC §3.2).
   * Conditional rows (own items, no children) need the item checks below.
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
   * archived. The guard sets it for every non-GET request except unarchive.
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
   * Builds the visibility filter for work item queries (SPEC §3.3).
   *
   * @param access The caller's access.
   * @returns An empty filter for `ALL`, a bucket filter for `BUCKETS`, or an
   *   assigned-or-created filter for `OWN`.
   */
  itemScopeFilter(access: ProjectAccess): ItemScopeFilter {
    switch (access.visibility) {
      case Visibility.ALL:
        return {};
      case Visibility.BUCKETS:
        return { bucketId: { in: [...access.allowedBucketIds] } };
      case Visibility.OWN:
        return {
          OR: [{ createdById: access.userId }, { assignees: { some: { userId: access.userId } } }],
        };
    }
  }

  /**
   * Reports whether an item is inside the caller's visibility scope. Items
   * outside it must be answered with 404 (SPEC §3.4).
   *
   * @param access The caller's access.
   * @param item The item.
   * @returns True if the caller may see the item in full.
   */
  canViewItem(access: ProjectAccess, item: ItemFacts): boolean {
    if (!this.has(access, P.VIEW_ITEMS)) return false;
    switch (access.visibility) {
      case Visibility.ALL:
        return true;
      case Visibility.BUCKETS:
        return item.bucketId !== null && access.allowedBucketIds.includes(item.bucketId);
      case Visibility.OWN:
        return this.isOwn(access, item);
    }
  }

  /**
   * Reports whether ancestors of visible items are shown as read-only titles
   * only (SPEC §3.3), i.e. whether the caller's scope is restricted.
   *
   * @param access The caller's access.
   * @returns True under `BUCKETS` and `OWN` scope.
   */
  ancestorsAreTitleOnly(access: ProjectAccess): boolean {
    return access.visibility !== Visibility.ALL;
  }

  /**
   * Edit rule: any visible item with `EDIT_ANY_ITEM`, or own items with
   * `EDIT_OWN_ITEMS`.
   *
   * @param access The caller's access.
   * @param item The item.
   * @returns True if the caller may edit the item.
   */
  canEditItem(access: ProjectAccess, item: ItemFacts): boolean {
    return (
      this.canViewItem(access, item) &&
      this.anyOrOwn(access, item, P.EDIT_ANY_ITEM, P.EDIT_OWN_ITEMS)
    );
  }

  /**
   * Move rule: any visible card with `MOVE_ANY_ITEM`, or own/assigned cards
   * with `MOVE_OWN_ITEMS`.
   *
   * @param access The caller's access.
   * @param item The item.
   * @returns True if the caller may move the card between buckets.
   */
  canMoveItem(access: ProjectAccess, item: ItemFacts): boolean {
    return (
      this.canViewItem(access, item) &&
      this.anyOrOwn(access, item, P.MOVE_ANY_ITEM, P.MOVE_OWN_ITEMS)
    );
  }

  /**
   * Delete rule: PM and Lead may delete any visible item, with or without
   * cascade; Members only items they created that have no children, and
   * never with cascade (SPEC §3.2, §4.1). Rejecting a non-cascade delete of
   * an item with children is a separate validation rule (M3).
   *
   * @param access The caller's access.
   * @param item The item.
   * @param cascade Whether `?cascade=true` was requested.
   * @returns True if the caller may delete the item.
   */
  canDeleteItem(access: ProjectAccess, item: ItemFacts, cascade: boolean): boolean {
    if (!this.canViewItem(access, item)) return false;
    if (this.has(access, P.DELETE_ANY_ITEM)) return true;
    return (
      this.has(access, P.DELETE_OWN_ITEMS) &&
      !cascade &&
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
   * the project setting is on). The caller must separately be allowed to
   * create or edit the item.
   *
   * @param access The caller's access.
   * @param assigneeIds Users the caller is adding as assignees.
   * @returns True if the assignment is allowed.
   */
  canAssign(access: ProjectAccess, assigneeIds: readonly string[]): boolean {
    return assigneeIds.every((id) => id === access.userId) || this.has(access, P.ASSIGN_OTHERS);
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
