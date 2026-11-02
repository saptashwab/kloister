import { Injectable } from '@nestjs/common';
import {
  CALENDAR_RANGE_MAX_DAYS,
  type CalendarItemDto,
  ItemStatus,
  type MyCalendarDto,
  ProjectPermission,
} from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { invalidField } from '../common/api-exception.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import type { Prisma } from '../generated/prisma/client.js';
import { toItemRef } from '../items/item.mapper.js';
import { ItemsService } from '../items/items.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type ProjectAccess, ProjectAccessService } from '../projects/project-access.service.js';

/** Columns of a calendar entry. */
const CALENDAR_SELECT = {
  id: true,
  number: true,
  projectId: true,
  type: true,
  title: true,
  status: true,
  startDate: true,
  startSecondHalf: true,
  dueDate: true,
  dueFirstHalf: true,
  adHoc: true,
  updatedAt: true,
  createdById: true,
  bucketId: true,
  teamId: true,
  sprintId: true,
  assignees: { select: { userId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  labels: { select: { labelId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.WorkItemSelect;

/** One row as the calendar reads it. */
type CalendarRow = Prisma.WorkItemGetPayload<{ select: typeof CALENDAR_SELECT }>;

/** Most undated items listed beside the calendar. */
const UNDATED_MAX = 200;

/** Milliseconds in a day. */
const DAY_MS = 86_400_000;

/**
 * The My work calendar (SPEC §6.5, docs/M13-PLAN.md §4): the caller's own
 * items across their unarchived projects and their personal space, with the
 * holidays that apply.
 *
 * Authorization (SPEC §3.4): like My work, the accesses come from
 * {@link ProjectAccessService.memberAccesses} (members only: admins get no
 * cross-project reads, so no `ADMIN_CROSS_PROJECT_ACCESS` entries) plus the
 * caller's own personal space, and the query goes through
 * {@link ItemsService.scopedAcross}, so an item is listed only if the caller
 * could open it. `canPlan` follows {@link ProjectAccessService.canPlanItem}.
 */
@Injectable()
export class CalendarService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param access Project access and item rules.
   * @param items The visibility filter.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly items: ItemsService,
  ) {}

  /**
   * Lists the caller's dated items that touch a date range, their open undated
   * items, the projects involved and every active holiday of those projects
   * and of the instance (each project says whether it uses the instance ones).
   *
   * Permissions: any signed-in user; their own items only, within their
   * visibility in each project.
   *
   * @param auth The caller.
   * @param from First day.
   * @param to Last day.
   * @returns The calendar.
   */
  async mine(auth: AuthContext, from: string, to: string): Promise<MyCalendarDto> {
    const days = (toDbDate(to).getTime() - toDbDate(from).getTime()) / DAY_MS;
    if (days < 0) throw invalidField('to', 'The range ends before it starts');
    if (days >= CALENDAR_RANGE_MAX_DAYS)
      throw invalidField('to', `A calendar covers at most ${CALENDAR_RANGE_MAX_DAYS} days`);
    const userId = auth.user.id;
    const accesses = await this.access.memberAccesses(auth);
    const personal = await this.access.ownPersonalAccess(auth);
    if (personal !== null) accesses.push(personal);
    const empty: MyCalendarDto = { from, to, items: [], undated: [], projects: [], holidays: [] };
    if (accesses.length === 0) return empty;
    const mine: Prisma.WorkItemWhereInput = {
      OR: [
        { assignees: { some: { userId } } },
        ...(personal === null ? [] : [{ projectId: personal.project.id }]),
      ],
    };
    const first = toDbDate(from);
    const last = toDbDate(to);
    const dated = await this.prisma.workItem.findMany({
      where: this.items.scopedAcross(accesses, {
        AND: [
          mine,
          {
            OR: [
              { startDate: { lte: last }, dueDate: { gte: first } },
              { startDate: null, dueDate: { gte: first, lte: last } },
              { dueDate: null, startDate: { gte: first, lte: last } },
            ],
          },
        ],
      }),
      select: CALENDAR_SELECT,
      orderBy: [{ dueDate: 'asc' }, { priority: 'asc' }, { id: 'asc' }],
    });
    const undated = await this.prisma.workItem.findMany({
      where: this.items.scopedAcross(accesses, {
        AND: [mine, { startDate: null, dueDate: null, status: { not: ItemStatus.DONE } }],
      }),
      select: CALENDAR_SELECT,
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: UNDATED_MAX,
    });
    const byProject = new Map(accesses.map((a) => [a.project.id, a]));
    const used = new Set([...dated, ...undated].map((r) => r.projectId));
    const projects = accesses.filter((a) => used.has(a.project.id));
    // Every active holiday of the listed projects, not only those in the
    // range: a move keeps an item's working days across its whole span.
    const holidays = await this.prisma.holiday.findMany({
      where: {
        deletedAt: null,
        OR: [
          { projectId: null },
          {
            projectId: {
              in: projects.filter((a) => a.project.ownerId === null).map((a) => a.project.id),
            },
          },
        ],
      },
      orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
    });
    const entry = (row: CalendarRow) =>
      toCalendarItem(this.access, byProject.get(row.projectId)!, row);
    return {
      from,
      to,
      items: dated.map(entry),
      undated: undated.map(entry),
      projects: projects.map((a) => ({
        id: a.project.id,
        key: a.project.key,
        name: a.project.name,
        autoMoveDependents: a.settings.autoMoveDependents,
        useInstanceHolidays: a.settings.useInstanceHolidays,
        canSwitch: this.access.has(a, ProjectPermission.MANAGE_PROJECT),
      })),
      holidays: holidays.map((h) => ({
        projectId: h.projectId,
        name: h.name,
        startDate: fromDbDate(h.startDate)!,
        endDate: fromDbDate(h.endDate)!,
      })),
    };
  }
}

/**
 * Converts a row to a calendar entry.
 *
 * @param rules Item permission rules.
 * @param access The caller's access to the item's project.
 * @param row The row.
 * @returns The entry.
 */
function toCalendarItem(
  rules: ProjectAccessService,
  access: ProjectAccess,
  row: CalendarRow,
): CalendarItemDto {
  const assigneeIds = row.assignees.map((a) => a.userId);
  return {
    ...toItemRef(access.project.key, row),
    projectId: row.projectId,
    status: row.status,
    startDate: fromDbDate(row.startDate),
    startSecondHalf: row.startSecondHalf,
    dueDate: fromDbDate(row.dueDate),
    dueFirstHalf: row.dueFirstHalf,
    adHoc: row.adHoc,
    assigneeIds,
    labelIds: row.labels.map((l) => l.labelId),
    updatedAt: row.updatedAt.toISOString(),
    canPlan:
      !access.project.archivedAt &&
      rules.canPlanItem(access, {
        createdById: row.createdById,
        assigneeIds,
        bucketId: row.bucketId,
        teamId: row.teamId,
        hasChildren: false,
        // A dated item is scheduled (M9.3); undated ones are listed, not moved.
        scheduled: true,
      }),
  };
}
