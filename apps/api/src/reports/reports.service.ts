import { Injectable } from '@nestjs/common';
import {
  addDays,
  AuditAction,
  dueNow,
  earliestStart,
  type HalfDay,
  isOverdueAt,
  ItemStatus,
  ItemType,
  mondayOf,
  type OverviewReportDto,
  type PlanHealthReportDto,
  ProjectRole,
  RECENT_DONE_DAYS,
  type ReportBucketCountDto,
  type ReportItemDto,
  type ScheduleDates,
  SHARE_MAX,
  slotHalfDay,
  type SprintChangeDto,
  type SprintReportDto,
  SprintState,
  startSlot,
  workingDaysIn,
  workingDuration,
  WORKLOAD_WEEKS_DEFAULT,
  type WorkloadReportDto,
} from '@kloister/shared';
import { notFound } from '../common/api-exception.js';
import { fromDbDate, fromDbTime } from '../common/dates.js';
import { toSprintDto } from '../board/board.mapper.js';
import type { Prisma } from '../generated/prisma/client.js';
import { HolidaysService } from '../holidays/holidays.service.js';
import { toItemRef } from '../items/item.mapper.js';
import { ItemsService } from '../items/items.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import {
  burndown,
  type SprintItem,
  type SprintMove,
  sprintChanges,
  sprintWorkingDays,
  spreadWorkload,
  startsBeforePredecessor,
  workloadCell,
  workloadWeeks,
} from './report-logic.js';
import type { SprintReportQueryDto, WorkloadQueryDto } from './reports.dto.js';

/** Columns every report reads. */
const REPORT_SELECT = {
  id: true,
  number: true,
  type: true,
  title: true,
  status: true,
  bucketId: true,
  sprintId: true,
  adHoc: true,
  startDate: true,
  startSecondHalf: true,
  dueDate: true,
  dueFirstHalf: true,
  dueTime: true,
  startNoEarlierThan: true,
  startNoEarlierThanSecondHalf: true,
  completedAt: true,
  createdAt: true,
  assignees: {
    select: { userId: true, share: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.WorkItemSelect;

/** One item row as the reports read it. */
type ReportRow = Prisma.WorkItemGetPayload<{ select: typeof REPORT_SELECT }>;

/** Milliseconds in a day. */
const DAY_MS = 86_400_000;

/**
 * Project reports (SPEC §6.5, docs/M13-PLAN.md §3): Overview, Sprint,
 * Workload and Plan health.
 *
 * Authorization (SPEC §3.4): `ProjectAccessGuard` resolves the project and
 * requires `VIEW_ITEMS`, which every member (Viewers included) and admin has;
 * personal spaces have no Sprint or Plan health report (404). Every item
 * query goes through {@link ItemsService.scoped}, so the numbers, lists and
 * workload cells come only from items the caller can see; dependency links
 * count only when both ends are visible, and sprint history is read only for
 * visible items. Hidden items are never counted, listed or hinted at.
 */
@Injectable()
export class ReportsService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param items The visibility filter.
   * @param holidays The project's working calendar.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly holidays: HolidaysService,
  ) {}

  /**
   * Counts the visible items by status, due date, bucket and recent work.
   *
   * Permissions: `VIEW_ITEMS` (guard); visible items only.
   *
   * @param access The caller's access.
   * @param at The moment to report for; now by default (server time).
   * @returns The overview.
   */
  async overview(access: ProjectAccess, at: Date = new Date()): Promise<OverviewReportDto> {
    const rows = await this.rows(access);
    const now = dueNow(at);
    const weekStart = mondayOf(now.date);
    const weekEnd = addDays(weekStart, 6);
    const recent = new Date(at.getTime() - RECENT_DONE_DAYS * DAY_MS);
    const byStatus = {
      [ItemStatus.NOT_STARTED]: 0,
      [ItemStatus.IN_PROGRESS]: 0,
      [ItemStatus.BLOCKED]: 0,
      [ItemStatus.DONE]: 0,
    };
    let overdue = 0;
    let dueThisWeek = 0;
    let doneRecently = 0;
    let adHocOpen = 0;
    const openPerBucket = new Map<string | null, number>();
    for (const row of rows) {
      byStatus[row.status]++;
      const due = { dueDate: fromDbDate(row.dueDate), dueTime: fromDbTime(row.dueTime) };
      if (row.status === ItemStatus.DONE) {
        if (row.completedAt !== null && row.completedAt >= recent) doneRecently++;
        continue;
      }
      if (isOverdueAt({ ...due, status: row.status }, now)) overdue++;
      else if (due.dueDate !== null && due.dueDate >= now.date && due.dueDate <= weekEnd)
        dueThisWeek++;
      if (row.adHoc) adHocOpen++;
      openPerBucket.set(row.bucketId, (openPerBucket.get(row.bucketId) ?? 0) + 1);
    }
    const buckets = await this.prisma.bucket.findMany({
      where: { projectId: access.project.id },
      orderBy: { position: 'asc' },
      select: { id: true, name: true },
    });
    const openByBucket: ReportBucketCountDto[] = buckets.map((b) => ({
      bucketId: b.id,
      name: b.name,
      count: openPerBucket.get(b.id) ?? 0,
    }));
    const offBoard = openPerBucket.get(null) ?? 0;
    if (offBoard > 0) openByBucket.push({ bucketId: null, name: 'Off the board', count: offBoard });
    return {
      today: now.date,
      weekStart,
      weekEnd,
      total: rows.length,
      byStatus,
      overdue,
      dueThisWeek,
      doneRecently,
      openByBucket,
      adHocOpen,
    };
  }

  /**
   * Reports on a sprint: progress, burndown, changes after the start (from
   * item history) and unfinished items due after it ends.
   *
   * Permissions: `VIEW_ITEMS` (guard; personal spaces 404); visible items
   * only. A sprint of another project is 404.
   *
   * @param access The caller's access.
   * @param query The sprint (the active one by default).
   * @param at The moment to report for; now by default.
   * @returns The sprint report.
   */
  async sprint(
    access: ProjectAccess,
    query: SprintReportQueryDto,
    at: Date = new Date(),
  ): Promise<SprintReportDto> {
    const projectId = access.project.id;
    const sprint =
      query.sprint === undefined
        ? await this.prisma.sprint.findFirst({ where: { projectId, state: SprintState.ACTIVE } })
        : await this.prisma.sprint.findFirst({ where: { id: query.sprint, projectId } });
    if (sprint === null && query.sprint !== undefined) throw notFound('Sprint');
    if (sprint === null)
      return {
        sprint: null,
        startedAt: null,
        items: { done: 0, remaining: 0 },
        days: { done: 0, remaining: 0 },
        sprintDays: { total: 0, elapsed: 0 },
        burndown: [],
        added: [],
        removed: [],
        atRisk: [],
      };
    const cal = await this.holidays.calendar(access);
    const today = dueNow(at).date;
    const start = fromDbDate(sprint.startDate)!;
    const end = fromDbDate(sprint.endDate)!;
    // Additions count from the moment the sprint was started, or its first day.
    const started = await this.prisma.auditLog.findFirst({
      where: {
        projectId,
        entityType: 'Sprint',
        entityId: sprint.id,
        action: AuditAction.SPRINT_STARTED,
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const firstDay = new Date(`${start}T00:00:00.000Z`);
    const startedAt = started?.createdAt ?? firstDay;
    const since = startedAt < firstDay ? startedAt : firstDay;

    const rows = await this.rows(access);
    const history = await this.sprintMoves(
      projectId,
      rows.map((r) => r.id),
      since,
    );
    const touched = rows.filter(
      (r) =>
        r.sprintId === sprint.id ||
        (history.get(r.id) ?? []).some((m) => m.from === sprint.id || m.to === sprint.id),
    );
    const items: SprintItem[] = touched.map((r) => ({
      ...datesOf(r),
      id: r.id,
      sprintId: r.sprintId,
      createdAt: r.createdAt,
      completedAt: r.status === ItemStatus.DONE ? r.completedAt : null,
      moves: history.get(r.id) ?? [],
    }));
    const byId = new Map(touched.map((r) => [r.id, r]));
    const added: SprintChangeDto[] = [];
    const removed: SprintChangeDto[] = [];
    for (const item of items) {
      const change = sprintChanges(item, sprint.id, startedAt);
      const ref = this.reportItem(access, byId.get(item.id)!);
      if (change.added !== null) added.push({ item: ref, at: change.added.toISOString() });
      if (change.removed !== null) removed.push({ item: ref, at: change.removed.toISOString() });
    }
    const current = touched.filter((r) => r.sprintId === sprint.id);
    const done = current.filter((r) => r.status === ItemStatus.DONE);
    const open = current.filter((r) => r.status !== ItemStatus.DONE);
    const days = sprintWorkingDays(start, end, cal);
    const daysOf = (list: ReportRow[]) =>
      list.reduce((sum, r) => sum + workingDuration(datesOf(r), cal), 0);
    return {
      sprint: toSprintDto(sprint),
      startedAt: startedAt.toISOString(),
      items: { done: done.length, remaining: open.length },
      days: { done: daysOf(done), remaining: daysOf(open) },
      sprintDays: {
        total: days.length,
        elapsed: today < start ? 0 : workingDaysIn(start, today < end ? today : end, cal),
      },
      burndown: burndown(items, sprint.id, days, today, cal),
      added: byTime(added),
      removed: byTime(removed),
      atRisk: open
        .filter((r) => r.dueDate !== null && fromDbDate(r.dueDate)! > end)
        .map((r) => this.reportItem(access, r)),
    };
  }

  /**
   * Spreads the visible, dated, unfinished items of the plan over people and
   * weeks: each item's working days in a week (holidays and half days
   * counted) times each assignee's share. In a personal space all work is the
   * owner's.
   *
   * Permissions: `VIEW_ITEMS` (guard); visible items only.
   *
   * @param access The caller's access.
   * @param query The first week and the number of weeks.
   * @param at The moment to report for; now by default.
   * @returns The workload.
   */
  async workload(
    access: ProjectAccess,
    query: WorkloadQueryDto,
    at: Date = new Date(),
  ): Promise<WorkloadReportDto> {
    const cal = await this.holidays.calendar(access);
    const weeks = workloadWeeks(
      mondayOf(query.from ?? dueNow(at).date),
      query.weeks ?? WORKLOAD_WEEKS_DEFAULT,
      cal,
    );
    const ownerId = access.project.ownerId;
    const rows = (await this.rows(access)).filter(
      (r) => r.status !== ItemStatus.DONE && !r.adHoc && r.startDate !== null && r.dueDate !== null,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const lines = spreadWorkload(
      rows.map((r) => ({
        ...datesOf(r),
        id: r.id,
        assignees: ownerId === null ? r.assignees : [{ userId: ownerId, share: SHARE_MAX }],
      })),
      weeks,
      cal,
    );
    // Everyone who can be given work is listed, also with nothing planned.
    const people =
      ownerId !== null
        ? [ownerId]
        : (
            await this.prisma.projectMember.findMany({
              where: {
                projectId: access.project.id,
                role: { not: ProjectRole.VIEWER },
                user: { isActive: true },
              },
              orderBy: { user: { displayName: 'asc' } },
              select: { userId: true },
            })
          ).map((m) => m.userId);
    const ordered = [
      ...people.map((userId) => lines.find((l) => l.userId === userId) ?? { userId, weeks: [] }),
      ...lines.filter((l) => l.userId !== null && !people.includes(l.userId)),
      ...lines.filter((l) => l.userId === null),
    ];
    return {
      weeks,
      rows: ordered.map((line) => ({
        userId: line.userId,
        cells: weeks.map((week, w) =>
          workloadCell(line.weeks[w] ?? [], week.available, (part) => ({
            item: this.reportItem(access, byId.get(part.itemId)!),
            days: part.days,
            share: part.share,
          })),
        ),
      })),
    };
  }

  /**
   * Lists what needs attention in the plan: unfinished items past due, items
   * starting before their predecessors finish, Stories and Tasks of the active
   * sprint without both dates, and pins that hold items later than their
   * predecessors require. Ad-hoc items are not part of the plan.
   *
   * Permissions: `VIEW_ITEMS` (guard; personal spaces 404); visible items
   * and links whose both ends are visible only.
   *
   * @param access The caller's access.
   * @param at The moment to report for; now by default.
   * @returns The plan health lists.
   */
  async planHealth(access: ProjectAccess, at: Date = new Date()): Promise<PlanHealthReportDto> {
    const projectId = access.project.id;
    const cal = await this.holidays.calendar(access);
    const now = dueNow(at);
    const rows = await this.rows(access);
    const open = rows.filter((r) => r.status !== ItemStatus.DONE);
    const plan = open.filter((r) => !r.adHoc);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const edges = await this.prisma.workItemDependency.findMany({
      where: {
        projectId,
        blockedItem: this.items.scoped(access, { adHoc: false }),
        blockingItem: this.items.scoped(access, { adHoc: false }),
      },
      select: { blockingItemId: true, blockedItemId: true },
    });
    const preds = new Map<string, string[]>();
    for (const e of edges)
      preds.set(e.blockedItemId, [...(preds.get(e.blockedItemId) ?? []), e.blockingItemId]);

    const conflicts = plan
      .map((r) => ({
        row: r,
        late: (preds.get(r.id) ?? [])
          .map((id) => byId.get(id))
          .filter(
            (p): p is ReportRow =>
              p !== undefined && startsBeforePredecessor(datesOf(r), datesOf(p), cal),
          ),
      }))
      .filter((c) => c.late.length > 0)
      .map((c) => ({
        item: this.reportItem(access, c.row),
        predecessors: c.late.map((p) => this.reportItem(access, p)),
      }));

    const datesById = new Map(rows.map((r) => [r.id, datesOf(r)]));
    const pinnedLate = plan
      .filter((r) => r.startNoEarlierThan !== null)
      .flatMap((r) => {
        const pin: HalfDay = {
          date: fromDbDate(r.startNoEarlierThan)!,
          second: r.startNoEarlierThanSecondHalf,
        };
        const earliest = earliestStart(preds.get(r.id) ?? [], datesById, cal);
        // Without dated visible predecessors a pin holds nothing back.
        if (earliest === null || startSlot(pin.date, pin.second, cal) <= earliest) return [];
        return [
          {
            item: this.reportItem(access, r),
            pin,
            earliest: slotHalfDay(earliest, cal),
          },
        ];
      });

    const sprint = await this.prisma.sprint.findFirst({
      where: { projectId, state: SprintState.ACTIVE },
    });
    return {
      pastDue: open
        .filter((r) =>
          isOverdueAt(
            {
              dueDate: fromDbDate(r.dueDate),
              dueTime: fromDbTime(r.dueTime),
              status: r.status,
            },
            now,
          ),
        )
        .map((r) => this.reportItem(access, r)),
      conflicts,
      sprint: sprint === null ? null : toSprintDto(sprint),
      undatedInSprint:
        sprint === null
          ? []
          : plan
              .filter(
                (r) =>
                  r.sprintId === sprint.id &&
                  (r.type === ItemType.STORY || r.type === ItemType.TASK) &&
                  (r.startDate === null || r.dueDate === null),
              )
              .map((r) => this.reportItem(access, r)),
      pinnedLate,
    };
  }

  /**
   * The visible items of the project, oldest number first.
   *
   * @param access The caller's access.
   * @returns The rows.
   */
  rows(access: ProjectAccess): Promise<ReportRow[]> {
    return this.prisma.workItem.findMany({
      where: this.items.scoped(access, {}),
      select: REPORT_SELECT,
      orderBy: { number: 'asc' },
    });
  }

  /**
   * The sprint changes in the history of the given items since a moment:
   * their own sprint edits and following their Story (M12), oldest first.
   * Only ids of visible items are passed in.
   *
   * @param projectId Project id.
   * @param itemIds Visible item ids.
   * @param since Earliest change to read.
   * @returns The changes per item id.
   */
  private async sprintMoves(
    projectId: string,
    itemIds: string[],
    since: Date,
  ): Promise<Map<string, SprintMove[]>> {
    const entries = await this.prisma.auditLog.findMany({
      where: {
        projectId,
        entityType: 'WorkItem',
        entityId: { in: itemIds },
        action: { in: [AuditAction.ITEM_UPDATED, AuditAction.SPRINT_FOLLOWED] },
        createdAt: { gt: since },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { entityId: true, createdAt: true, meta: true },
    });
    const moves = new Map<string, SprintMove[]>();
    for (const entry of entries) {
      const change = sprintChangeOf(entry.meta);
      if (change === null || entry.entityId === null) continue;
      moves.set(entry.entityId, [
        ...(moves.get(entry.entityId) ?? []),
        { at: entry.createdAt, ...change },
      ]);
    }
    return moves;
  }

  /**
   * Converts a row to the item shape reports list.
   *
   * @param access The caller's access.
   * @param row The row.
   * @returns The report item.
   */
  reportItem(access: ProjectAccess, row: ReportRow): ReportItemDto {
    return {
      ...toItemRef(access.project.key, row),
      status: row.status,
      startDate: fromDbDate(row.startDate),
      dueDate: fromDbDate(row.dueDate),
      assigneeIds: row.assignees.map((a) => a.userId),
    };
  }
}

/**
 * The scheduling fields of a row.
 *
 * @param row The row.
 * @returns Its dates.
 */
function datesOf(row: ReportRow): ScheduleDates {
  return {
    startDate: fromDbDate(row.startDate),
    startSecondHalf: row.startSecondHalf,
    dueDate: fromDbDate(row.dueDate),
    dueFirstHalf: row.dueFirstHalf,
  };
}

/**
 * Reads the sprint change of an audit entry, if it has one.
 *
 * @param meta The entry's meta.
 * @returns From and to, or null.
 */
function sprintChangeOf(meta: Prisma.JsonValue): { from: string | null; to: string | null } | null {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const changes = meta['changes'];
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) return null;
  const sprint = changes['sprintId'];
  if (sprint === null || typeof sprint !== 'object' || Array.isArray(sprint)) return null;
  const id = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return { from: id(sprint['from']), to: id(sprint['to']) };
}

/**
 * Sorts changes oldest first.
 *
 * @param changes The changes.
 * @returns The same list, sorted.
 */
function byTime(changes: SprintChangeDto[]): SprintChangeDto[] {
  return changes.sort((a, b) => a.at.localeCompare(b.at));
}
