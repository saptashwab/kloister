import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  addDays,
  dueNow,
  mondayOf,
  type MyCalendarDto,
  type OverviewReportDto,
  type PlanHealthReportDto,
  type ProjectDto,
  type SprintReportDto,
  type WorkItemDetailDto,
  type WorkloadReportDto,
} from '@kloister/shared';
import ExcelJS from 'exceljs';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  call,
  login,
  type Res,
  resetDb,
  seedBucket,
  seedItem,
  seedProject,
  seedSprint,
  seedUser,
  startApp,
} from './support.js';

// Assignee shares, reports and the My work calendar (M13) against a real
// database: permissions for every new endpoint, shares under the plan setting,
// sprint additions read from item history, and reports that never count,
// list or hint at items the caller cannot see.

const NAMES = ['pm', 'lead', 'member', 'scoped', 'viewer', 'outsider'] as const;
type Name = (typeof NAMES)[number];

/**
 * Midnight UTC of a calendar date, as stored in date columns.
 *
 * @param date `YYYY-MM-DD`.
 * @returns The Date.
 */
const day = (date: string): Date => new Date(`${date}T00:00:00.000Z`);

describe('shares, reports and calendar (db)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let ids: Record<Name, string>;
  let projectId: string;
  let todo: string;
  let sessions: Partial<Record<Name, string>> = {};
  // Every date is relative to the server's today, as the reports are.
  const today = dueNow(new Date()).date;
  const monday = mondayOf(today);

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Signs in a seeded user and sends one request.
   *
   * @param name Seeded user.
   * @param method HTTP method.
   * @param url Path.
   * @param body JSON body.
   * @returns The response.
   */
  async function as(
    name: Name,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: object,
  ): Promise<Res> {
    const sid = (sessions[name] ??= await login(app, `${name}@example.org`));
    return call(app, method, url, { sid, ...(body === undefined ? {} : { body }) });
  }

  const base = (suffix = ''): string => `/api/v1/projects/${projectId}${suffix}`;

  /**
   * Seeds a Task with dates.
   *
   * @param fields Creator, assignees, dates and more.
   * @param fields.createdById Creator.
   * @param fields.assigneeIds Assignees.
   * @param fields.start Start date, or null.
   * @param fields.due Due date, or null.
   * @param fields.sprintId Sprint.
   * @param fields.status Status.
   * @returns The item id.
   */
  async function task(fields: {
    createdById: string;
    assigneeIds?: string[];
    start?: string | null;
    due?: string | null;
    sprintId?: string | null;
    status?: 'NOT_STARTED' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE';
  }): Promise<string> {
    const item = await seedItem(prisma, projectId, {
      createdById: fields.createdById,
      bucketId: todo,
      assigneeIds: fields.assigneeIds,
      sprintId: fields.sprintId ?? null,
      status: fields.status,
    });
    await prisma.workItem.update({
      where: { id: item.id },
      data: {
        startDate: fields.start ? day(fields.start) : null,
        dueDate: fields.due ? day(fields.due) : null,
        completedAt: fields.status === 'DONE' ? new Date() : null,
      },
    });
    return item.id;
  }

  beforeEach(async () => {
    sessions = {};
    await resetDb(prisma);
    const seeded: Partial<Record<Name, string>> = {};
    for (const name of NAMES)
      seeded[name] = (await seedUser(prisma, { email: `${name}@example.org` })).id;
    ids = seeded as Record<Name, string>;
    const project = await seedProject(prisma, 'KLO', [
      { userId: ids.pm, role: 'PM' },
      { userId: ids.lead, role: 'LEAD' },
      { userId: ids.member, role: 'MEMBER' },
      { userId: ids.scoped, role: 'MEMBER', visibility: 'OWN' },
      { userId: ids.viewer, role: 'VIEWER', visibility: 'OWN' },
    ]);
    projectId = project.id;
    todo = (await seedBucket(prisma, projectId, 'To Do')).id;
  });

  describe('assignee shares', () => {
    it('stores shares, keeps them for plain ids and validates them', async () => {
      const created = await as('pm', 'POST', base('/items'), {
        type: 'TASK',
        title: 'Shared',
        assignees: [
          { userId: ids.member, share: 100 },
          { userId: ids.lead, share: 25 },
        ],
      });
      expect(created.statusCode).toBe(201);
      const item = created.json() as WorkItemDetailDto;
      // Assignees added together come back in id order, so compare as sets.
      const sorted = (list: { userId: string; share: number }[]) =>
        [...list].sort((a, b) => a.userId.localeCompare(b.userId));
      expect(sorted(item.assigneeShares)).toEqual(
        sorted([
          { userId: ids.member, share: 100 },
          { userId: ids.lead, share: 25 },
        ]),
      );
      // Plain ids keep the shares of people who stay; new people get 100%.
      const kept = await as('pm', 'PATCH', base(`/items/${item.id}`), {
        assigneeIds: [ids.lead, ids.pm],
      });
      expect(sorted((kept.json() as WorkItemDetailDto).assigneeShares)).toEqual(
        sorted([
          { userId: ids.lead, share: 25 },
          { userId: ids.pm, share: 100 },
        ]),
      );
      for (const share of [0, 33, 105]) {
        const bad = await as('pm', 'PATCH', base(`/items/${item.id}`), {
          assignees: [{ userId: ids.lead, share }],
        });
        expect(bad.statusCode).toBe(400);
      }
      const both = await as('pm', 'PATCH', base(`/items/${item.id}`), {
        assigneeIds: [ids.lead],
        assignees: [{ userId: ids.lead, share: 50 }],
      });
      expect(both.statusCode).toBe(400);
      // The database refuses shares outside 5–100 in steps of 5 too.
      await expect(
        prisma.workItemAssignee.updateMany({
          where: { workItemId: item.id, userId: ids.lead },
          data: { share: 33 },
        }),
      ).rejects.toThrow();
      // A share-only change is an ordinary item update with the shares recorded.
      const changed = await as('pm', 'PATCH', base(`/items/${item.id}`), {
        assignees: [
          { userId: ids.lead, share: 50 },
          { userId: ids.pm, share: 100 },
        ],
      });
      expect(changed.statusCode).toBe(200);
      const history = await prisma.auditLog.findMany({
        where: { entityId: item.id, action: 'ITEM_UPDATED' },
      });
      expect(JSON.stringify(history.map((h) => h.meta))).toContain('assigneeShares');
    });

    it('follows the plan setting: Members change shares only of their own unscheduled items or with the setting off', async () => {
      const assigned = await task({
        createdById: ids.pm,
        assigneeIds: [ids.member],
        due: addDays(monday, 3),
      });
      const set = { assignees: [{ userId: ids.member, share: 50 }] };
      expect((await as('member', 'PATCH', base(`/items/${assigned}`), set)).statusCode).toBe(403);
      expect((await as('lead', 'PATCH', base(`/items/${assigned}`), set)).statusCode).toBe(200);
      // Viewers have no edit permission at all (route guard).
      expect((await as('viewer', 'PATCH', base(`/items/${assigned}`), set)).statusCode).toBe(403);
      // A Member's own unscheduled item is theirs to plan (M9.3).
      const own = await task({ createdById: ids.member, assigneeIds: [ids.member] });
      expect((await as('member', 'PATCH', base(`/items/${own}`), set)).statusCode).toBe(200);
      // Removing yourself is an assignment change, not a share change.
      const leaving = await task({
        createdById: ids.pm,
        assigneeIds: [ids.member],
        due: addDays(monday, 3),
      });
      const left = await as('member', 'PATCH', base(`/items/${leaving}`), { assigneeIds: [] });
      expect(left.statusCode).toBe(200);
      expect((left.json() as WorkItemDetailDto).assigneeIds).toEqual([]);
      // With the setting off, Members plan their items, shares included.
      await as('pm', 'PATCH', base(), { settings: { planLeadsOnly: false } });
      expect(
        (
          await as('member', 'PATCH', base(`/items/${assigned}`), {
            assignees: [{ userId: ids.member, share: 25 }],
          })
        ).statusCode,
      ).toBe(200);
    });
  });

  describe('report permissions', () => {
    it('applies BUCKETS and TEAMS scopes, opens archived projects and audits admin visits', async () => {
      const done = await seedBucket(prisma, projectId, 'Done');
      const users = await Promise.all(
        ['buckets', 'teams', 'admin'].map((name) =>
          seedUser(prisma, {
            email: `${name}-scope@example.org`,
            systemRole: name === 'admin' ? 'ADMIN' : 'USER',
          }),
        ),
      );
      const [bucketsUser, teamsUser, adminUser] = users as [
        (typeof users)[number],
        (typeof users)[number],
        (typeof users)[number],
      ];
      await prisma.projectMember.createMany({
        data: [
          {
            projectId,
            userId: bucketsUser.id,
            role: 'VIEWER',
            visibility: 'BUCKETS',
            allowedBucketIds: [todo],
          },
          { projectId, userId: teamsUser.id, role: 'MEMBER', visibility: 'TEAMS' },
        ],
      });
      const team = await prisma.team.create({
        data: {
          projectId,
          name: 'Web',
          members: { create: [{ userId: teamsUser.id, role: 'MEMBER' }] },
        },
      });
      await task({ createdById: ids.pm });
      const teamItem = await task({ createdById: ids.pm });
      await prisma.workItem.update({ where: { id: teamItem }, data: { teamId: team.id } });
      const doneItem = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        bucketId: done.id,
      });
      const total = async (email: string) => {
        const sid = await login(app, email);
        const res = await call(app, 'GET', base('/reports/overview'), { sid });
        expect(res.statusCode).toBe(200);
        return (res.json() as OverviewReportDto).total;
      };
      expect(await total('pm@example.org')).toBe(3);
      // Only the To Do bucket's two items, not the Done one.
      expect(await total('buckets-scope@example.org')).toBe(2);
      expect(await total('teams-scope@example.org')).toBe(1);
      expect(doneItem.id).toBeTruthy();

      // An administrator who is not a member reads through All projects; the visit is audited.
      const adminSid = await login(app, 'admin-scope@example.org');
      const read = await call(app, 'GET', base('/reports/workload'), { sid: adminSid });
      expect(read.statusCode).toBe(200);
      expect(
        await prisma.auditLog.count({
          where: { actorId: adminUser.id, action: 'ADMIN_CROSS_PROJECT_ACCESS', projectId },
        }),
      ).toBeGreaterThan(0);

      // Archived projects stay readable.
      await prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
      expect((await as('member', 'GET', base('/reports/overview'))).statusCode).toBe(200);
      expect((await as('member', 'GET', base('/reports/plan-health'))).statusCode).toBe(200);
    });

    it('lets every member read every report, Viewers included, and hides projects from others', async () => {
      const paths = [
        '/reports/overview',
        '/reports/sprint',
        '/reports/workload',
        '/reports/plan-health',
      ];
      for (const name of ['pm', 'lead', 'member', 'scoped', 'viewer'] as const)
        for (const path of paths) expect((await as(name, 'GET', base(path))).statusCode).toBe(200);
      for (const path of paths)
        expect((await as('outsider', 'GET', base(path))).statusCode).toBe(404);
      expect((await call(app, 'GET', base('/reports/overview'))).statusCode).toBe(401);
      expect((await as('pm', 'GET', base('/reports/workload?weeks=27'))).statusCode).toBe(400);
      const other = await seedProject(prisma, 'OTH', [{ userId: ids.pm, role: 'PM' }]);
      const foreign = await seedSprint(prisma, other.id, 'Theirs');
      expect((await as('pm', 'GET', base(`/reports/sprint?sprint=${foreign.id}`))).statusCode).toBe(
        404,
      );
    });

    it('gives a personal space Overview and Workload for its owner only', async () => {
      const created = await as('member', 'POST', '/api/v1/me/personal');
      const personal = created.json() as ProjectDto;
      const at = (path: string) => `/api/v1/projects/${personal.id}/reports/${path}`;
      expect((await as('member', 'GET', at('overview'))).statusCode).toBe(200);
      const workload = (await as('member', 'GET', at('workload'))).json() as WorkloadReportDto;
      expect(workload.rows.map((r) => r.userId)).toEqual([ids.member]);
      expect((await as('member', 'GET', at('sprint'))).statusCode).toBe(404);
      expect((await as('member', 'GET', at('plan-health'))).statusCode).toBe(404);
      expect((await as('pm', 'GET', at('overview'))).statusCode).toBe(404);
    });
  });

  describe('reports never count hidden items', () => {
    it('counts, lists and loads only what the caller can see', async () => {
      const sprint = await seedSprint(prisma, projectId, 'S1', 'ACTIVE');
      await prisma.sprint.update({
        where: { id: sprint.id },
        data: { startDate: day(monday), endDate: day(addDays(monday, 11)) },
      });
      // Visible to the OWN-scoped Member: assigned to them.
      const mine = await task({
        createdById: ids.pm,
        assigneeIds: [ids.scoped],
        start: monday,
        due: addDays(monday, 1),
        sprintId: sprint.id,
      });
      // Hidden from them: someone else's overdue item, a predecessor and sprint work.
      const hidden = await task({
        createdById: ids.pm,
        assigneeIds: [ids.member],
        start: addDays(monday, -14),
        due: addDays(monday, -10),
        sprintId: sprint.id,
      });
      await task({
        createdById: ids.pm,
        assigneeIds: [ids.member, ids.scoped],
        start: monday,
        due: addDays(monday, 4),
      });
      // The scoped Member has half of the shared item.
      await prisma.workItemAssignee.updateMany({
        where: { userId: ids.scoped, workItemId: { not: mine } },
        data: { share: 50 },
      });
      // A hidden predecessor that finishes after "mine" starts.
      await prisma.workItemDependency.create({
        data: { projectId, blockingItemId: hidden, blockedItemId: mine },
      });
      await prisma.workItem.update({
        where: { id: hidden },
        data: { dueDate: day(addDays(monday, 3)) },
      });

      const pmOverview = (
        await as('pm', 'GET', base('/reports/overview'))
      ).json() as OverviewReportDto;
      expect(pmOverview.total).toBe(3);
      const overview = (
        await as('scoped', 'GET', base('/reports/overview'))
      ).json() as OverviewReportDto;
      expect(overview.total).toBe(2);
      // Only their two items can be overdue, whatever day the tests run.
      const pastDue = [addDays(monday, 1), addDays(monday, 4)].filter((d) => d < today).length;
      expect(overview.overdue).toBe(pastDue);

      const health = (
        await as('scoped', 'GET', base('/reports/plan-health'))
      ).json() as PlanHealthReportDto;
      expect(health.conflicts).toEqual([]);
      expect(health.pastDue.some((i) => i.id === hidden)).toBe(false);
      const pmHealth = (
        await as('pm', 'GET', base('/reports/plan-health'))
      ).json() as PlanHealthReportDto;
      expect(pmHealth.conflicts.map((c) => c.item.id)).toEqual([mine]);

      const sprintReport = (
        await as('scoped', 'GET', base('/reports/sprint'))
      ).json() as SprintReportDto;
      expect(sprintReport.items.done + sprintReport.items.remaining).toBe(1);

      const workload = (
        await as('scoped', 'GET', base(`/reports/workload?from=${monday}&weeks=1`))
      ).json() as WorkloadReportDto;
      const entries = workload.rows.flatMap((r) => r.cells.flatMap((c) => c.entries));
      expect(entries.some((e) => e.item.id === hidden)).toBe(false);
      const scopedRow = workload.rows.find((r) => r.userId === ids.scoped)!;
      // Their own item: 2 days at 100%, plus 5 days of the shared item at 50%.
      expect(scopedRow.cells[0].planned).toBe(4.5);
      // The hidden item of another person adds nothing to that person's row.
      const memberRow = workload.rows.find((r) => r.userId === ids.member)!;
      expect(memberRow.cells[0].planned).toBe(5);

      // The Excel export gets the same reports in a Reports sheet.
      const download = await as('scoped', 'GET', base('/snapshots'));
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Uint8Array.from(download.rawPayload).buffer);
      const rows: string[] = [];
      workbook
        .getWorksheet('Reports')
        ?.eachRow((row) => rows.push([2, 3].map((c) => row.getCell(c).text).join(',')));
      expect(rows.some((r) => r.includes('Visible items,2'))).toBe(true);
    });
  });

  describe('sprint report from history', () => {
    it('counts items by when they joined or left after the start', async () => {
      const sprint = await seedSprint(prisma, projectId, 'S1');
      await prisma.sprint.update({
        where: { id: sprint.id },
        data: { startDate: day(monday), endDate: day(addDays(monday, 11)) },
      });
      const planned = await task({ createdById: ids.pm, sprintId: sprint.id });
      const later = await task({ createdById: ids.pm });
      const leaving = await task({ createdById: ids.pm, sprintId: sprint.id });
      const risky = await task({
        createdById: ids.pm,
        sprintId: sprint.id,
        due: addDays(monday, 20),
      });
      expect((await as('pm', 'POST', base(`/sprints/${sprint.id}/start`))).statusCode).toBe(200);
      // Changes after the start must carry a later timestamp than the start.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        (await as('pm', 'PATCH', base(`/items/${later}`), { sprintId: sprint.id })).statusCode,
      ).toBe(200);
      expect(
        (await as('pm', 'PATCH', base(`/items/${leaving}`), { sprintId: null })).statusCode,
      ).toBe(200);
      const report = (await as('member', 'GET', base('/reports/sprint'))).json() as SprintReportDto;
      expect(report.sprint?.id).toBe(sprint.id);
      expect(report.added.map((c) => c.item.id)).toEqual([later]);
      expect(report.removed.map((c) => c.item.id)).toEqual([leaving]);
      expect(report.added.some((c) => c.item.id === planned)).toBe(false);
      expect(report.atRisk.map((i) => i.id)).toEqual([risky]);
      expect(report.items.remaining).toBe(3);
    });
  });

  describe('My work calendar', () => {
    it('lists the caller’s own visible dated items and validates the range', async () => {
      const mine = await task({
        createdById: ids.pm,
        assigneeIds: [ids.scoped],
        start: monday,
        due: addDays(monday, 2),
      });
      await task({ createdById: ids.pm, assigneeIds: [ids.member], due: monday });
      const undated = await task({ createdById: ids.pm, assigneeIds: [ids.scoped] });
      const url = `/api/v1/me/calendar?from=${monday}&to=${addDays(monday, 41)}`;
      const res = await as('scoped', 'GET', url);
      expect(res.statusCode).toBe(200);
      const calendar = res.json() as MyCalendarDto;
      expect(calendar.items.map((i) => i.id)).toEqual([mine]);
      expect(calendar.items[0].canPlan).toBe(false);
      expect(calendar.undated.map((i) => i.id)).toEqual([undated]);
      expect(calendar.projects.map((p) => p.id)).toEqual([projectId]);
      const pm = (await as('pm', 'GET', url)).json() as MyCalendarDto;
      expect(pm.items).toEqual([]);
      expect(pm.projects.find((p) => p.id === projectId)).toBeUndefined();
      expect(
        (await as('scoped', 'GET', `/api/v1/me/calendar?from=${monday}&to=${addDays(monday, -1)}`))
          .statusCode,
      ).toBe(400);
      expect(
        (await as('scoped', 'GET', `/api/v1/me/calendar?from=${monday}&to=${addDays(monday, 100)}`))
          .statusCode,
      ).toBe(400);
      expect((await call(app, 'GET', url)).statusCode).toBe(401);
    });

    it('includes personal tasks, leaves archived projects out and lists every active holiday', async () => {
      const personal = (await as('scoped', 'POST', '/api/v1/me/personal')).json() as ProjectDto;
      const created = await as('scoped', 'POST', `/api/v1/projects/${personal.id}/items`, {
        type: 'TASK',
        title: 'Private task',
        startDate: monday,
        dueDate: monday,
      });
      expect(created.statusCode).toBe(201);
      const projectItem = await task({
        createdById: ids.pm,
        assigneeIds: [ids.scoped],
        due: monday,
      });
      await prisma.holiday.create({
        data: {
          projectId,
          name: 'Long ago',
          startDate: day('2020-01-01'),
          endDate: day('2020-01-01'),
          createdById: ids.pm,
        },
      });
      const url = `/api/v1/me/calendar?from=${monday}&to=${addDays(monday, 6)}`;
      const before = (await as('scoped', 'GET', url)).json() as MyCalendarDto;
      expect(before.items.map((i) => i.title).sort()).toEqual(['Item 1', 'Private task'].sort());
      // Holidays outside the range still count for moves.
      expect(before.holidays.map((h) => h.name)).toContain('Long ago');
      expect(before.projects.find((p) => p.id === projectId)?.useInstanceHolidays).toBe(true);
      await prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
      const after = (await as('scoped', 'GET', url)).json() as MyCalendarDto;
      expect(after.items.some((i) => i.id === projectItem)).toBe(false);
      expect(after.items.map((i) => i.title)).toEqual(['Private task']);
    });
  });
});
