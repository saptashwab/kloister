import { HttpStatus, Injectable } from '@nestjs/common';
import {
  DEFAULT_PAGE_LIMIT,
  ErrorCode,
  ItemStatus,
  SystemRole,
  type UserWorkDto,
  type WorkSummaryDto,
} from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { ApiException } from '../common/api-exception.js';
import { parseProjectSettings } from '../projects/project-settings.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import { toPage } from '../common/pagination.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectAccessService } from '../projects/project-access.service.js';
import { ItemsService } from './items.service.js';
import type { WorkQueryDto } from './work.dto.js';

/** Columns read for one row of the list. */
const WORK_SELECT = {
  id: true,
  number: true,
  projectId: true,
  type: true,
  title: true,
  status: true,
  priority: true,
  dueDate: true,
  project: { select: { key: true, name: true, ownerId: true, settings: true } },
  bucket: { select: { id: true, name: true } },
  labels: { select: { label: true } },
  createdById: true,
  bucketId: true,
  teamId: true,
  assignees: { select: { userId: true } },
} satisfies Prisma.WorkItemSelect;

/** One row as read by {@link WORK_SELECT}. */
type WorkRow = Prisma.WorkItemGetPayload<{ select: typeof WORK_SELECT }>;

/**
 * My work and "all their work" (SPEC §6): items assigned to a person (and
 * optionally created by them) across every readable membership project.
 * Own work also includes the caller's personal tasks without assignments.
 * Other people's personal spaces are never included. The ordinary
 * projects are limited by the caller's
 * own visibility scope there.
 *
 * Authorization (SPEC §3.4): the caller's accesses come from
 * {@link ProjectAccessService.memberAccesses} and the query goes through
 * {@link ItemsService.scopedAcross}, so an item appears only if the caller
 * could open it in its project. Non-admins may only look up people who share
 * one of those projects with them; anyone else is 404, so the endpoint does
 * not reveal which accounts exist. Admins may look up any user (they manage
 * users anyway), but still see items of their own projects only.
 */
@Injectable()
export class WorkService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param access Project access and visibility rules.
   * @param items Item query scoping.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly items: ItemsService,
  ) {}

  /**
   * Lists the items assigned to a person that the caller can see, due date
   * first and undated items last.
   *
   * Permissions: any signed-in user; see the class comment for who may be
   * looked up and which items are returned.
   *
   * @param auth The caller.
   * @param userId The person.
   * @param query Pagination and whether to include Done items.
   * @returns The person and one page of their items.
   */
  async listForUser(auth: AuthContext, userId: string, query: WorkQueryDto): Promise<UserWorkDto> {
    const accesses = await this.access.memberAccesses(auth);
    const person = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, displayName: true, email: true },
    });
    if (person === null) throw personNotFound();
    if (auth.user.systemRole !== SystemRole.ADMIN && userId !== auth.user.id) {
      // Only people who share a project with the caller can be looked up.
      const shared = await this.prisma.projectMember.count({
        where: { userId, projectId: { in: accesses.map((a) => a.project.id) } },
      });
      if (shared === 0) throw personNotFound();
    }

    const isMe = userId === auth.user.id;
    if (isMe && query.source !== 'PROJECTS') {
      const personal = await this.access.ownPersonalAccess(auth);
      if (personal !== null) accesses.push(personal);
    }
    const selected = accesses.filter(
      (a) =>
        (query.projectId === undefined || a.project.id === query.projectId) &&
        (query.source !== 'PERSONAL' || a.project.ownerId === auth.user.id),
    );
    const empty: UserWorkDto = { user: person, items: [], nextCursor: null };
    if (selected.length === 0) return empty;
    const personalIds = selected
      .filter((a) => a.project.ownerId === auth.user.id)
      .map((a) => a.project.id);
    const where = this.items.scopedAcross(selected, {
      OR: [
        { assignees: { some: { userId } } },
        ...(query.includeCreated === true ? [{ createdById: userId }] : []),
        ...(isMe ? [{ projectId: { in: personalIds } }] : []),
      ],
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.labelId === undefined ? {} : { labels: { some: { labelId: query.labelId } } }),
      ...(query.dueFrom === undefined && query.dueTo === undefined
        ? {}
        : {
            dueDate: {
              ...(query.dueFrom === undefined ? {} : { gte: toDbDate(query.dueFrom) }),
              ...(query.dueTo === undefined ? {} : { lte: toDbDate(query.dueTo) }),
            },
          }),
      ...(query.includeDone === true ? {} : { status: { not: ItemStatus.DONE } }),
    });
    // Keyset paging on (due date, id) with undated items last. The rows after
    // the cursor are selected explicitly rather than with Prisma's cursor,
    // which compares the nullable due date and could skip undated items.
    let after: Prisma.WorkItemWhereInput = {};
    if (query.cursor !== undefined) {
      // A cursor naming an item the caller cannot see gives an empty page, so
      // it cannot be used to probe for hidden items.
      const cursor = await this.prisma.workItem.findFirst({
        where: { AND: [where, { id: query.cursor }] },
        select: { id: true, dueDate: true },
      });
      if (cursor === null) return empty;
      after =
        cursor.dueDate === null
          ? { dueDate: null, id: { gt: cursor.id } }
          : {
              OR: [
                { dueDate: { gt: cursor.dueDate } },
                { dueDate: cursor.dueDate, id: { gt: cursor.id } },
                { dueDate: null },
              ],
            };
    }
    const rows = await this.prisma.workItem.findMany({
      where: { AND: [where, after] },
      select: WORK_SELECT,
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      // One extra row tells whether another page follows.
      take: (query.limit ?? DEFAULT_PAGE_LIMIT) + 1,
    });
    const page = toPage(rows, query, (row) => {
      const access = selected.find((a) => a.project.id === row.projectId);
      return {
        ...toWorkSummary(row),
        canEdit:
          access !== undefined &&
          this.access.canEditItem(access, {
            createdById: row.createdById,
            bucketId: row.bucketId,
            teamId: row.teamId,
            assigneeIds: row.assignees.map((a) => a.userId),
            hasChildren: false,
          }),
      };
    });
    return { user: person, items: page.items, nextCursor: page.nextCursor };
  }
}

/**
 * Converts a row to its list entry.
 *
 * @param row The row.
 * @returns The entry.
 */
function toWorkSummary(row: WorkRow): WorkSummaryDto {
  return {
    id: row.id,
    number: row.number,
    key: row.project.key === null ? `#${row.number}` : `${row.project.key}-${row.number}`,
    projectId: row.projectId,
    projectKey: row.project.key,
    projectName: row.project.ownerId === null ? row.project.name : 'Personal',
    personal: row.project.ownerId !== null,
    bucket: row.bucket,
    labels: row.labels.map(({ label }) => ({
      id: label.id,
      name: label.name,
      colour: label.colour,
      projectId: label.projectId,
    })),
    labelStyle: parseProjectSettings(row.project.settings).labelStyle,
    canEdit: false,
    type: row.type,
    title: row.title,
    status: row.status,
    priority: row.priority,
    dueDate: fromDbDate(row.dueDate),
  };
}

/**
 * The 404 for unknown people and people the caller shares no project with.
 *
 * @returns The exception.
 */
function personNotFound(): ApiException {
  return new ApiException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'User not found');
}
