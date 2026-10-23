import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AuditAction,
  DEFAULT_BUCKETS,
  DEFAULT_PROJECT_SETTINGS,
  ErrorCode,
  ItemStatus,
  type Page,
  type ProjectDto,
  ProjectRole,
  type ProjectSettings,
  type ProjectSummaryDto,
  type StatusToBucket,
  SystemRole,
  Visibility,
} from '@kloister/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { ApiException, invalidField } from '../common/api-exception.js';
import { pageArgs, toPage } from '../common/pagination.js';
import { toDbDate } from '../common/dates.js';
import { POSITION_STEP } from '../common/positions.js';
import { dueWindows } from '../notifications/due-dates.js';
import { isUniqueViolation, mapTransactionConflict } from '../common/prisma-errors.js';
import type { Prisma, Project } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toProjectDto, toProjectListDto } from './project.mapper.js';
import {
  type ProjectAccess,
  ProjectAccessService,
  projectArchived,
} from './project-access.service.js';
import { mergeProjectSettings, parseProjectSettings } from './project-settings.js';
import type { CreateProjectDto, ListProjectsQueryDto, UpdateProjectDto } from './projects.dto.js';

/** A JSON-safe before/after pair for audit entries. */
type Change = { from: Prisma.InputJsonValue | null; to: Prisma.InputJsonValue | null };

/**
 * Projects: listing, creation by admins, settings and archiving (SPEC §3,
 * §8 `projects`). Every method that acts on one project takes the caller's
 * {@link ProjectAccess}, already checked by `ProjectAccessGuard`.
 */
@Injectable()
export class ProjectsService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param audit Audit log.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: ProjectAccessService,
  ) {}

  /**
   * Lists projects by name.
   *
   * Permissions: `scope=mine` (default) returns only the caller's projects;
   * `scope=all` is for system admins (403 otherwise) and is the UI's "All
   * projects" toggle. Listing is not "opening" a project, so it writes no
   * `ADMIN_CROSS_PROJECT_ACCESS` entries; opening one does. Each row's
   * summary counts only items the caller can see there, and is null where
   * the caller is not a member, so the list never reads other projects.
   *
   * @param auth The caller.
   * @param query Scope, archived filter, search and pagination.
   * @returns One page of projects.
   */
  async list(auth: AuthContext, query: ListProjectsQueryDto): Promise<Page<ProjectDto>> {
    const all = query.scope === 'all';
    if (all && auth.user.systemRole !== SystemRole.ADMIN) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Only administrators can list all projects',
      );
    }
    const userId = auth.user.id;
    const q = query.q?.trim();
    const where: Prisma.ProjectWhereInput = {
      ownerId: null,
      ...(all ? {} : { members: { some: { userId } } }),
      ...(query.includeArchived === true ? {} : { archivedAt: null }),
      ...(q === undefined || q === ''
        ? {}
        : {
            OR: [
              { key: { contains: q, mode: 'insensitive' } },
              { name: { contains: q, mode: 'insensitive' } },
            ],
          }),
    };
    if (
      query.cursor !== undefined &&
      (await this.prisma.project.findFirst({
        where: { AND: [where, { id: query.cursor }] },
        select: { id: true },
      })) === null
    )
      return { items: [], nextCursor: null };
    const rows = await this.prisma.project.findMany({
      where,
      include: {
        members: {
          where: { userId },
          select: {
            role: true,
            visibility: true,
            teamMemberships: { select: { teamId: true, role: true } },
          },
        },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      ...pageArgs(query),
    });
    const summaries = await this.summaries(
      auth,
      rows.filter((r) => r.members.length > 0).map((r) => r.id),
    );
    return toPage(rows, query, ({ members, ...project }) => ({
      ...toProjectListDto(project, members[0] ?? null, auth.user.systemRole === SystemRole.ADMIN),
      summary: summaries.get(project.id) ?? null,
    }));
  }

  /**
   * Creates a project with one or more Project Managers (SPEC §3.1) and the
   * default buckets of SPEC §4.2.
   *
   * Permissions: system admins only (enforced by the controller). The admin
   * does not become a member unless they name themselves as a PM.
   *
   * @param auth The admin.
   * @param dto Key, name, description and the PMs' user ids.
   * @returns The project from the admin's point of view (201).
   */
  async create(auth: AuthContext, dto: CreateProjectDto): Promise<ProjectDto> {
    const pmUserIds = [...new Set(dto.pmUserIds)];
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const pms = await tx.user.findMany({ where: { id: { in: pmUserIds }, isActive: true } });
        if (pms.length !== pmUserIds.length) {
          throw new ApiException(
            HttpStatus.BAD_REQUEST,
            ErrorCode.VALIDATION_FAILED,
            'Every Project Manager must be an active user',
            [{ field: 'pmUserIds', messages: ['must all be active users'] }],
          );
        }
        const project = await tx.project.create({
          data: {
            key: dto.key,
            name: dto.name,
            description: dto.description ?? '',
            settings: { ...DEFAULT_PROJECT_SETTINGS },
            buckets: {
              create: DEFAULT_BUCKETS.map((bucket, index) => ({
                ...bucket,
                position: (index + 1) * POSITION_STEP,
              })),
            },
            members: {
              create: pms.map((pm) => ({
                userId: pm.id,
                role: ProjectRole.PM,
                visibility: Visibility.ALL,
              })),
            },
          },
          include: { members: true },
        });
        const { members, ...row } = project;
        await this.audit.record(
          {
            actorId: auth.user.id,
            action: AuditAction.PROJECT_CREATED,
            entityType: 'Project',
            entityId: row.id,
            projectId: row.id,
            meta: { key: row.key, name: row.name },
          },
          tx,
        );
        for (const pm of pms) {
          await this.audit.record(
            {
              actorId: auth.user.id,
              action: AuditAction.MEMBER_ADDED,
              entityType: 'ProjectMember',
              entityId: members.find((m) => m.userId === pm.id)?.id ?? null,
              projectId: row.id,
              meta: { userId: pm.id, email: pm.email, role: ProjectRole.PM },
            },
            tx,
          );
        }
        return row;
      });
      const membership = pmUserIds.includes(auth.user.id)
        ? { role: ProjectRole.PM, visibility: Visibility.ALL }
        : null;
      return toProjectListDto(created, membership, true);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          ErrorCode.CONFLICT,
          'A project with this key already exists',
        );
      }
      throw error;
    }
  }

  /**
   * Returns the project.
   *
   * Permissions: any member, or an admin (audited by the access check).
   *
   * @param access The caller's access.
   * @returns The project.
   */
  get(access: ProjectAccess): ProjectDto {
    return toProjectDto(access);
  }

  /**
   * Changes name, description or settings. The key never changes, because
   * item numbers such as `KLO-42` are built from it.
   *
   * Permissions: PM only (`MANAGE_PROJECT`, checked by the guard).
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param dto Fields to change.
   * @returns The updated project.
   */
  async update(
    auth: AuthContext,
    access: ProjectAccess,
    dto: UpdateProjectDto,
  ): Promise<ProjectDto> {
    if (access.project.ownerId !== null && dto.settings?.membersCanAssignOthers !== undefined)
      throw invalidField(
        'settings.membersCanAssignOthers',
        'Personal spaces do not have assignments',
      );
    const id = access.project.id;
    // The row is re-read inside a serializable transaction so settings are
    // merged into the latest stored JSON (concurrent edits to different keys
    // conflict instead of one being lost) and a concurrent archive is seen.
    let updated: Project;
    try {
      updated = await this.prisma.$transaction(
        async (tx) => {
          const current = await tx.project.findUniqueOrThrow({ where: { id } });
          if (current.archivedAt !== null) throw projectArchived();
          const changes: Record<string, Change> = {};
          const data: Prisma.ProjectUpdateInput = {};
          if (dto.name !== undefined && dto.name !== current.name) {
            changes['name'] = { from: current.name, to: dto.name };
            data.name = dto.name;
          }
          if (dto.description !== undefined && dto.description !== current.description) {
            changes['description'] = { from: current.description, to: dto.description };
            data.description = dto.description;
          }
          const settingsChange = dto.settings ?? {};
          const settings = parseProjectSettings(current.settings);
          const changedSettings: Partial<ProjectSettings> = {};
          if (
            settingsChange.membersCanAssignOthers !== undefined &&
            settingsChange.membersCanAssignOthers !== settings.membersCanAssignOthers
          ) {
            changedSettings['membersCanAssignOthers'] = settingsChange.membersCanAssignOthers;
            changes['settings.membersCanAssignOthers'] = {
              from: settings.membersCanAssignOthers,
              to: settingsChange.membersCanAssignOthers,
            };
          }
          const statusToBucket = settingsChange.statusToBucket;
          if (statusToBucket !== undefined && !sameMap(statusToBucket, settings.statusToBucket)) {
            const bucketIds = [...new Set(Object.values(statusToBucket))];
            const found = await tx.bucket.count({
              where: { projectId: id, id: { in: bucketIds } },
            });
            if (found !== bucketIds.length) {
              throw invalidField(
                'settings.statusToBucket',
                'Every status must map to a bucket of this project',
              );
            }
            changedSettings.statusToBucket = statusToBucket;
            changes['settings.statusToBucket'] = {
              from: settings.statusToBucket,
              to: statusToBucket,
            };
          }
          if (
            settingsChange.labelStyle !== undefined &&
            settingsChange.labelStyle !== settings.labelStyle
          ) {
            changedSettings.labelStyle = settingsChange.labelStyle;
            changes['settings.labelStyle'] = {
              from: settings.labelStyle,
              to: settingsChange.labelStyle,
            };
          }
          if (Object.keys(changedSettings).length > 0) {
            data.settings = mergeProjectSettings(current.settings, changedSettings);
          }
          if (Object.keys(changes).length === 0) return current;

          const project = await tx.project.update({ where: { id }, data });
          await this.audit.record(
            {
              actorId: auth.user.id,
              action: AuditAction.PROJECT_UPDATED,
              entityType: 'Project',
              entityId: id,
              projectId: id,
              meta: { changes },
            },
            tx,
          );
          return project;
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      throw mapTransactionConflict(error);
    }
    return toProjectDto(access, updated);
  }

  /**
   * Archives or unarchives the project. Archived projects stay readable by
   * their members but refuse every change until unarchived.
   *
   * Permissions: PM only (`MANAGE_PROJECT`, checked by the guard).
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param archived True to archive, false to unarchive.
   * @returns The updated project.
   */
  async setArchived(
    auth: AuthContext,
    access: ProjectAccess,
    archived: boolean,
  ): Promise<ProjectDto> {
    const current = access.project;
    if ((current.archivedAt !== null) === archived) return toProjectDto(access);
    const updated = await this.prisma.$transaction(async (tx) => {
      const project = await tx.project.update({
        where: { id: current.id },
        data: { archivedAt: archived ? new Date() : null },
      });
      await this.audit.record(
        {
          actorId: auth.user.id,
          action: archived ? AuditAction.PROJECT_ARCHIVED : AuditAction.PROJECT_UNARCHIVED,
          entityType: 'Project',
          entityId: current.id,
          projectId: current.id,
        },
        tx,
      );
      return project;
    });
    return toProjectDto(access, updated);
  }

  /**
   * Counts what the caller can see in each project of a list page (M8.5):
   * open items, overdue items and the newest recorded change to a visible
   * item. Every count goes through the caller's own visibility filter, so a
   * Member with `OWN` sees only their own work. Last activity comes from item
   * audit entries, not `updatedAt`, because moving a hidden card renumbers
   * visible siblings and would reveal it.
   *
   * Permissions: membership only; non-member projects get no summary.
   *
   * @param auth The caller.
   * @param projectIds Projects on the page that the caller is a member of.
   * @returns Summaries by project id.
   */
  private async summaries(
    auth: AuthContext,
    projectIds: string[],
  ): Promise<Map<string, ProjectSummaryDto>> {
    const result = new Map<string, ProjectSummaryDto>();
    if (projectIds.length === 0) return result;
    const accesses = await this.access.memberAccessesIn(auth, projectIds);
    // Overdue follows the server clock, like the daily due-date check.
    const window = dueWindows(new Date());
    const today = toDbDate(window.today);
    // Projects are summarized in parallel; each needs a few small queries.
    await Promise.all(
      accesses.map(async (access) => {
        const scope = this.access.itemScopeFilter(access);
        const visible: Prisma.WorkItemWhereInput = {
          AND: [{ projectId: access.project.id }, scope],
        };
        const open: Prisma.WorkItemWhereInput = {
          AND: [visible, { status: { not: ItemStatus.DONE } }],
        };
        const [openCount, overdue, lastActivityAt] = await Promise.all([
          this.prisma.workItem.count({ where: open }),
          this.prisma.workItem.count({
            where: {
              AND: [
                open,
                {
                  OR: [
                    { dueDate: { lt: today } },
                    { dueDate: today, dueTime: { lt: window.minutes } },
                  ],
                },
              ],
            },
          }),
          this.lastActivity(access.project.id, Object.keys(scope).length === 0 ? null : visible),
        ]);
        result.set(access.project.id, { open: openCount, overdue, lastActivityAt });
      }),
    );
    return result;
  }

  /**
   * The newest audit entry about a visible item of a project. With full
   * visibility every item entry counts; otherwise only entries about the
   * visible items, read in batches so a large project never builds one huge
   * id list.
   *
   * @param projectId The project.
   * @param visible The caller's item filter, or null when they see every item.
   * @returns ISO time, or null without entries.
   */
  private async lastActivity(
    projectId: string,
    visible: Prisma.WorkItemWhereInput | null,
  ): Promise<string | null> {
    const newest = async (entityId?: { in: string[] }): Promise<Date | null> =>
      (
        await this.prisma.auditLog.aggregate({
          where: { projectId, entityType: 'WorkItem', ...(entityId ? { entityId } : {}) },
          _max: { createdAt: true },
        })
      )._max.createdAt;
    if (visible === null) return (await newest())?.toISOString() ?? null;
    const ids = (await this.prisma.workItem.findMany({ where: visible, select: { id: true } })).map(
      (i) => i.id,
    );
    let latest: Date | null = null;
    for (let start = 0; start < ids.length; start += SUMMARY_ID_BATCH) {
      const found = await newest({ in: ids.slice(start, start + SUMMARY_ID_BATCH) });
      if (found !== null && (latest === null || found > latest)) latest = found;
    }
    return latest?.toISOString() ?? null;
  }
}

/**
 * Compares two status → bucket maps.
 *
 * @param a First map.
 * @param b Second map.
 * @returns True if both map the same statuses to the same buckets.
 */
function sameMap(a: StatusToBucket, b: StatusToBucket): boolean {
  const keys = Object.keys(a) as (keyof StatusToBucket)[];
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** Visible item ids per last-activity query, well below the database's parameter limit. */
const SUMMARY_ID_BATCH = 5000;
