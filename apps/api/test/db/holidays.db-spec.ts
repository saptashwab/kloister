import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type {
  HolidayDto,
  ProjectDto,
  ProjectHolidaysDto,
  RescheduleResultDto,
} from '@kloister/shared';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  call,
  login,
  type Res,
  resetDb,
  seedBucket,
  seedItem,
  seedProject,
  seedUser,
  startApp,
} from './support.js';

// Holidays (SPEC §6.4, M9.1) against a real database: the permission matrix
// for project and instance holidays, the project calendar with the instance
// switch, the review notice and the planner skipping holidays.

const NAMES = ['admin', 'pm', 'lead', 'member', 'viewer', 'outsider'] as const;
type Name = (typeof NAMES)[number];

describe('holidays (db)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let ids: Record<Name, string>;
  let projectId: string;
  let sessions: Partial<Record<Name, string>> = {};

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

  const project = (suffix = ''): string => `/api/v1/projects/${projectId}/holidays${suffix}`;
  const holiday = { name: 'Founders day', startDate: '2026-11-04', endDate: '2026-11-04' };

  beforeEach(async () => {
    sessions = {};
    await resetDb(prisma);
    const seeded: Partial<Record<Name, string>> = {};
    for (const name of NAMES) {
      seeded[name] = (
        await seedUser(prisma, {
          email: `${name}@example.org`,
          systemRole: name === 'admin' ? 'ADMIN' : 'USER',
        })
      ).id;
    }
    ids = seeded as Record<Name, string>;
    projectId = (
      await seedProject(prisma, 'HOL', [
        { userId: ids.pm, role: 'PM' },
        { userId: ids.lead, role: 'LEAD' },
        { userId: ids.member, role: 'MEMBER' },
        { userId: ids.viewer, role: 'VIEWER' },
      ])
    ).id;
  });

  it('lets PMs and Leads manage project holidays and everyone in the project read them', async () => {
    expect((await as('pm', 'POST', project(), holiday)).statusCode).toBe(201);
    const lead = await as('lead', 'POST', project(), { ...holiday, name: 'Team day' });
    expect(lead.statusCode).toBe(201);
    expect((await as('member', 'POST', project(), holiday)).statusCode).toBe(403);
    expect((await as('viewer', 'POST', project(), holiday)).statusCode).toBe(403);
    expect((await as('admin', 'POST', project(), holiday)).statusCode).toBe(403);
    expect((await as('outsider', 'GET', project())).statusCode).toBe(404);
    const list = (await as('viewer', 'GET', project())).json() as ProjectHolidaysDto;
    expect(list.holidays.map((h) => h.name).sort()).toEqual(['Founders day', 'Team day']);
    const id = (lead.json() as HolidayDto).id;
    expect((await as('member', 'DELETE', project(`/${id}`))).statusCode).toBe(403);
    expect((await as('lead', 'DELETE', project(`/${id}`))).statusCode).toBe(204);
    expect((await as('lead', 'DELETE', project(`/${id}`))).statusCode).toBe(404);
    const bad = await as('pm', 'POST', project(), { ...holiday, endDate: '2026-11-01' });
    expect(bad.statusCode).toBe(400);
    const audit = await prisma.auditLog.count({ where: { action: { startsWith: 'HOLIDAY_' } } });
    expect(audit).toBe(3);
  });

  it('refuses personal spaces and archived projects', async () => {
    const personal = (await as('pm', 'POST', '/api/v1/me/personal')).json() as ProjectDto;
    const res = await as('pm', 'GET', `/api/v1/projects/${personal.id}/holidays`);
    expect(res.statusCode).toBe(404);
    await prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    expect((await as('pm', 'POST', project(), holiday)).statusCode).toBe(409);
    expect((await as('pm', 'GET', project())).statusCode).toBe(200);
  });

  it('keeps instance holidays to admins, shows them as changes until reviewed', async () => {
    expect((await as('pm', 'POST', '/api/v1/admin/holidays', holiday)).statusCode).toBe(403);
    const created = await as('admin', 'POST', '/api/v1/admin/holidays', holiday);
    expect(created.statusCode).toBe(201);
    const before = (await as('lead', 'GET', project())).json() as ProjectHolidaysDto;
    expect(before.holidays.map((h) => h.scope)).toEqual(['INSTANCE']);
    expect(before.instanceChanges).toHaveLength(1);
    // Only PMs and Leads review; afterwards the notice is gone.
    expect((await as('member', 'POST', project('/reviewed'))).statusCode).toBe(403);
    expect((await as('lead', 'POST', project('/reviewed'))).statusCode).toBe(204);
    const after = (await as('lead', 'GET', project())).json() as ProjectHolidaysDto;
    expect(after.instanceChanges).toEqual([]);
    // A removal after the review is a change again.
    const id = (created.json() as HolidayDto).id;
    expect((await as('admin', 'DELETE', `/api/v1/admin/holidays/${id}`)).statusCode).toBe(204);
    const removed = (await as('lead', 'GET', project())).json() as ProjectHolidaysDto;
    expect(removed.holidays).toEqual([]);
    expect(removed.instanceChanges.map((h) => h.deletedAt === null)).toEqual([false]);
    // A project can switch the instance holidays off (PM setting).
    await as('admin', 'POST', '/api/v1/admin/holidays', holiday);
    const off = await as('pm', 'PATCH', `/api/v1/projects/${projectId}`, {
      settings: { useInstanceHolidays: false },
    });
    expect(off.statusCode).toBe(200);
    const none = (await as('lead', 'GET', project())).json() as ProjectHolidaysDto;
    expect(none).toMatchObject({ holidays: [], instanceChanges: [], useInstanceHolidays: false });
  });

  it('moves dependent items past holidays', async () => {
    const bucketId = (await seedBucket(prisma, projectId, 'To Do')).id;
    const pred = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId });
    const succ = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId });
    const day = (date: string) => new Date(`${date}T00:00:00Z`);
    await prisma.workItem.update({
      where: { id: pred.id },
      data: { startDate: day('2026-11-02'), dueDate: day('2026-11-02') },
    });
    await prisma.workItem.update({
      where: { id: succ.id },
      data: { startDate: day('2026-11-06'), dueDate: day('2026-11-06') },
    });
    await prisma.workItemDependency.create({
      data: { projectId, blockingItemId: pred.id, blockedItemId: succ.id },
    });
    await as('pm', 'POST', project(), {
      ...holiday,
      startDate: '2026-11-03',
      endDate: '2026-11-04',
    });
    const plan = (
      await as('pm', 'POST', `/api/v1/projects/${projectId}/timeline/reschedule`, {
        mode: 'preview',
        changes: [{ item: succ.id }],
      })
    ).json() as RescheduleResultDto;
    // Tuesday and Wednesday are holidays: the successor starts on Thursday.
    expect(plan.changes[0]?.to).toMatchObject({ startDate: '2026-11-05', dueDate: '2026-11-05' });
  });

  it('keeps holidays in their own scope and checks every route', async () => {
    const other = (await seedProject(prisma, 'OTH', [{ userId: ids.pm, role: 'PM' }])).id;
    const theirs = (
      await as('pm', 'POST', `/api/v1/projects/${other}/holidays`, holiday)
    ).json() as HolidayDto;
    const instance = (
      await as('admin', 'POST', '/api/v1/admin/holidays', holiday)
    ).json() as HolidayDto;
    const own = (await as('pm', 'POST', project(), holiday)).json() as HolidayDto;
    // Another project's holiday and an instance holiday are not this project's to remove.
    expect((await as('pm', 'DELETE', project(`/${theirs.id}`))).statusCode).toBe(404);
    expect((await as('pm', 'DELETE', project(`/${instance.id}`))).statusCode).toBe(404);
    // The admin route only removes instance holidays.
    const adminDelete = await as('admin', 'DELETE', `/api/v1/admin/holidays/${own.id}`);
    expect(adminDelete.statusCode).toBe(404);
    expect((await as('pm', 'GET', '/api/v1/admin/holidays')).statusCode).toBe(403);
    expect((await as('pm', 'DELETE', `/api/v1/admin/holidays/${instance.id}`)).statusCode).toBe(
      403,
    );
    expect((await as('viewer', 'POST', project('/reviewed'))).statusCode).toBe(403);
    const instanceAudit = await prisma.auditLog.count({
      where: { action: 'HOLIDAY_ADDED', projectId: null },
    });
    expect(instanceAudit).toBe(1);
    // Only PMs switch the instance holidays; the switch is audited and counts as a review.
    const body = { settings: { useInstanceHolidays: false } };
    expect((await as('lead', 'PATCH', `/api/v1/projects/${projectId}`, body)).statusCode).toBe(403);
    expect((await as('pm', 'PATCH', `/api/v1/projects/${projectId}`, body)).statusCode).toBe(200);
    const updated = await prisma.auditLog.findFirst({
      where: { action: 'PROJECT_UPDATED', entityId: projectId },
      orderBy: { createdAt: 'desc' },
    });
    expect(JSON.stringify(updated?.meta)).toContain('settings.useInstanceHolidays');
    await as('pm', 'PATCH', `/api/v1/projects/${projectId}`, {
      settings: { useInstanceHolidays: true },
    });
    const back = (await as('lead', 'GET', project())).json() as ProjectHolidaysDto;
    expect(back.instanceChanges).toEqual([]);
    await prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    expect((await as('pm', 'POST', project('/reviewed'))).statusCode).toBe(409);
  });

  it('reviews only the changes shown', async () => {
    const first = (
      await as('admin', 'POST', '/api/v1/admin/holidays', holiday)
    ).json() as HolidayDto;
    // A moment apart, so the two changes have different times.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await as('admin', 'POST', '/api/v1/admin/holidays', {
      ...holiday,
      name: 'Later day',
    });
    expect(second.statusCode).toBe(201);
    // The PM saw only the first change; the second stays unreviewed.
    const reviewed = await as('pm', 'POST', project('/reviewed'), { through: first.createdAt });
    expect(reviewed.statusCode).toBe(204);
    const left = (await as('pm', 'GET', project())).json() as ProjectHolidaysDto;
    expect(left.instanceChanges.map((h) => h.name)).toEqual(['Later day']);
  });
});
