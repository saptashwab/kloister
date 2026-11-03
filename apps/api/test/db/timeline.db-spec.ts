import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  AuditAction,
  type AuditEntryDto,
  type Page,
  type ProjectDto,
  type RescheduleResultDto,
  type TimelineDto,
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

// The project timeline (SPEC §6.4, M9) against a real database: visible
// links, preview/apply/only rescheduling with dependent moves and pins, the
// permission matrix, non-disclosure of hidden items and the project switch.

const NAMES = ['admin', 'pm', 'lead', 'member', 'viewer', 'own', 'outsider'] as const;
type Name = (typeof NAMES)[number];

describe('timeline (db)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let ids: Record<Name, string>;
  let projectId: string;
  /** A (done, finishes 5 Nov 1st half) precedes B and C (pinned); P (hidden from `own`) precedes M. */
  let items: Record<'a' | 'b' | 'c' | 'p' | 'm', string>;
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
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    body?: object,
  ): Promise<Res> {
    const sid = (sessions[name] ??= await login(app, `${name}@example.org`));
    return call(app, method, url, { sid, ...(body === undefined ? {} : { body }) });
  }

  /**
   * Sets an item's dates and pin directly.
   *
   * @param id Item id.
   * @param dates Dates (`YYYY-MM-DD`) and halves.
   * @param dates.start Start date.
   * @param dates.due Due date.
   * @param dates.startSecondHalf Starts in the 2nd half.
   * @param dates.dueFirstHalf Finishes after the 1st half.
   * @param dates.pin Pin date.
   */
  async function setDates(
    id: string,
    dates: {
      start: string;
      due: string;
      startSecondHalf?: boolean;
      dueFirstHalf?: boolean;
      pin?: string;
    },
  ): Promise<void> {
    await prisma.workItem.update({
      where: { id },
      data: {
        startDate: new Date(`${dates.start}T00:00:00Z`),
        dueDate: new Date(`${dates.due}T00:00:00Z`),
        startSecondHalf: dates.startSecondHalf ?? false,
        dueFirstHalf: dates.dueFirstHalf ?? false,
        startNoEarlierThan: dates.pin === undefined ? null : new Date(`${dates.pin}T00:00:00Z`),
      },
    });
  }

  /**
   * Reads an item's stored dates as wire strings.
   *
   * @param id Item id.
   * @returns Start and due.
   */
  async function stored(id: string): Promise<{ start: string | null; due: string | null }> {
    const row = await prisma.workItem.findUniqueOrThrow({ where: { id } });
    return {
      start: row.startDate?.toISOString().slice(0, 10) ?? null,
      due: row.dueDate?.toISOString().slice(0, 10) ?? null,
    };
  }

  const url = (suffix = ''): string => `/api/v1/projects/${projectId}/timeline${suffix}`;
  /** Shortens A so B can start earlier. */
  const shortenA = () => ({ item: items.a, dueDate: '2026-11-04', dueFirstHalf: false });

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
      await seedProject(prisma, 'WEB', [
        { userId: ids.pm, role: 'PM' },
        { userId: ids.lead, role: 'LEAD' },
        { userId: ids.member, role: 'MEMBER' },
        { userId: ids.viewer, role: 'VIEWER' },
        { userId: ids.own, role: 'MEMBER', visibility: 'OWN' },
      ])
    ).id;
    const bucketId = (await seedBucket(prisma, projectId, 'To Do')).id;
    const task = (createdById: string, status?: 'DONE') =>
      seedItem(prisma, projectId, { createdById, bucketId, ...(status ? { status } : {}) });
    items = {
      a: (await task(ids.pm, 'DONE')).id,
      b: (await task(ids.pm)).id,
      c: (await task(ids.pm)).id,
      p: (await task(ids.pm)).id,
      m: (await task(ids.own)).id,
    };
    await setDates(items.a, { start: '2026-11-04', due: '2026-11-05', dueFirstHalf: true });
    await setDates(items.b, {
      start: '2026-11-05',
      startSecondHalf: true,
      due: '2026-11-11',
      dueFirstHalf: true,
    });
    await setDates(items.c, { start: '2026-11-09', due: '2026-11-18', pin: '2026-11-09' });
    await setDates(items.p, { start: '2026-11-02', due: '2026-11-03' });
    await setDates(items.m, { start: '2026-11-04', due: '2026-11-05' });
    for (const [blocking, blocked] of [
      [items.a, items.b],
      [items.a, items.c],
      [items.p, items.m],
    ] as const) {
      await prisma.workItemDependency.create({
        data: { projectId, blockingItemId: blocking, blockedItemId: blocked },
      });
    }
  });

  describe('GET /timeline', () => {
    it('lists only links whose both ends the caller can see', async () => {
      const pm = (await as('pm', 'GET', url())).json() as TimelineDto;
      expect(pm.edges).toHaveLength(3);
      const viewer = await as('viewer', 'GET', url());
      expect(viewer.statusCode).toBe(200);
      // `own` sees M but not its predecessor P, so the link is not listed.
      const own = (await as('own', 'GET', url())).json() as TimelineDto;
      expect(own.edges).toEqual([]);
      expect(JSON.stringify(own)).not.toContain(items.p);
    });

    it('is 404 for outsiders and personal spaces, readable for admins', async () => {
      expect((await as('outsider', 'GET', url())).statusCode).toBe(404);
      expect((await as('admin', 'GET', url())).statusCode).toBe(200);
      const personal = (await as('pm', 'POST', '/api/v1/me/personal')).json() as ProjectDto;
      const res = await as('pm', 'GET', `/api/v1/projects/${personal.id}/timeline`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /timeline/msproject (v1.3.2)', () => {
    /**
     * Downloads the Microsoft Project file as a user.
     *
     * @param name Seeded user.
     * @returns Status, type and the XML.
     */
    async function download(name: Name): Promise<{ status: number; type: unknown; xml: string }> {
      const res = await as(name, 'GET', url('/msproject'));
      return {
        status: res.statusCode,
        type: res.headers['content-type'],
        xml: res.rawPayload.toString('utf8'),
      };
    }
    /**
     * The display key of a seeded item.
     *
     * @param id Item id.
     * @returns E.g. `WEB-3`.
     */
    const keyOf = async (id: string) =>
      `WEB-${(await prisma.workItem.findUniqueOrThrow({ where: { id } })).number}`;

    it('gives every reader the plan they can see, with dates, links and holidays', async () => {
      await prisma.holiday.create({
        data: {
          projectId,
          name: 'Team day',
          startDate: new Date('2026-11-06T00:00:00Z'),
          endDate: new Date('2026-11-06T00:00:00Z'),
          createdById: ids.pm,
        },
      });
      const pm = await download('pm');
      expect(pm.status).toBe(200);
      expect(pm.type).toBe('application/xml; charset=utf-8');
      expect(pm.xml).toContain('<Project xmlns="http://schemas.microsoft.com/project">');
      for (const id of Object.values(items))
        expect(pm.xml).toContain(`<WBS>${await keyOf(id)}</WBS>`);
      expect(pm.xml.match(/<PredecessorLink>/g)).toHaveLength(3);
      // B starts in the 2nd half of 5 Nov and finishes after the 1st half of 11 Nov.
      expect(pm.xml).toContain(
        '<Start>2026-11-05T13:00:00</Start><Finish>2026-11-11T12:00:00</Finish>',
      );
      expect(pm.xml).toContain('<Name>Team day</Name>');
      for (const name of ['viewer', 'admin'] as const)
        expect((await download(name)).status).toBe(200);
    });

    it('leaves out hidden items and their links, and is 404 where the timeline is', async () => {
      const own = await download('own');
      expect(own.status).toBe(200);
      expect(own.xml).toContain(`<WBS>${await keyOf(items.m)}</WBS>`);
      expect(own.xml).not.toContain(`<WBS>${await keyOf(items.p)}</WBS>`);
      expect(own.xml).not.toContain('<PredecessorLink>');
      expect((await download('outsider')).status).toBe(404);
      const personal = (await as('pm', 'POST', '/api/v1/me/personal')).json() as ProjectDto;
      const res = await as('pm', 'GET', `/api/v1/projects/${personal.id}/timeline/msproject`);
      expect(res.statusCode).toBe(404);
    });

    it('leaves ad-hoc items out and shows a hidden parent as a title only', async () => {
      await prisma.workItem.update({ where: { id: items.c }, data: { adHoc: true } });
      const pm = await download('pm');
      expect(pm.xml).not.toContain(`<WBS>${await keyOf(items.c)}</WBS>`);
      // A to C was the third link; it goes with C.
      expect(pm.xml.match(/<PredecessorLink>/g)).toHaveLength(2);
      const parent = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        type: 'STORY',
        title: 'Private story',
      });
      await prisma.workItem.update({
        where: { id: parent.id },
        data: { description: '<p>Secret details</p>' },
      });
      await prisma.workItem.update({ where: { id: items.m }, data: { parentId: parent.id } });
      const own = await download('own');
      expect(own.xml).toContain('<Name>Private story</Name>');
      expect(own.xml).toContain('not visible to you in Kloister (title only)');
      expect(own.xml).not.toContain('Secret details');
    });

    it('records every admin download in projects they are not a member of', async () => {
      for (let i = 0; i < 2; i++) expect((await download('admin')).status).toBe(200);
      const audits = await prisma.auditLog.findMany({
        where: { action: AuditAction.ADMIN_CROSS_PROJECT_ACCESS, actorId: ids.admin },
      });
      expect(audits.map((a) => (a.meta as { via: string }).via)).toEqual([
        'GET /api/v1/projects/:id/timeline/msproject',
        'GET /api/v1/projects/:id/timeline/msproject',
      ]);
    });
  });

  describe('POST /timeline/reschedule', () => {
    it('previews dependent moves earlier, keeps a pinned item and changes nothing', async () => {
      const res = await as('pm', 'POST', url('/reschedule'), {
        mode: 'preview',
        changes: [shortenA()],
      });
      expect(res.statusCode).toBe(200);
      const plan = res.json() as RescheduleResultDto;
      expect(plan.changes.map((c) => [c.item.id, c.requested])).toEqual([
        [items.a, true],
        [items.b, false],
      ]);
      expect(plan.changes[1]?.to).toEqual({
        startDate: '2026-11-05',
        startSecondHalf: false,
        dueDate: '2026-11-10',
        dueFirstHalf: false,
      });
      expect(plan.kept).toEqual([expect.objectContaining({ reason: 'PINNED' })]);
      expect(plan.items).toEqual([]);
      expect(await stored(items.b)).toEqual({ start: '2026-11-05', due: '2026-11-11' });
    });

    it('applies a previewed plan with one reschedule id and names the trigger', async () => {
      const preview = (
        await as('pm', 'POST', url('/reschedule'), { mode: 'preview', changes: [shortenA()] })
      ).json() as RescheduleResultDto;
      const res = await as('pm', 'POST', url('/reschedule'), {
        mode: 'apply',
        changes: [shortenA()],
        expect: Object.fromEntries(preview.changes.map((c) => [c.item.id, c.version])),
        previewed: preview.changes
          .filter((c) => !c.requested)
          .map((c) => ({ id: c.item.id, to: c.to })),
      });
      expect(res.statusCode).toBe(200);
      const result = res.json() as RescheduleResultDto;
      expect(result.items).toHaveLength(2);
      expect(await stored(items.b)).toEqual({ start: '2026-11-05', due: '2026-11-10' });
      const entries = await prisma.auditLog.findMany({
        where: { entityId: { in: [items.a, items.b] }, action: 'ITEM_UPDATED' },
      });
      const metas = entries.map((e) => e.meta as Record<string, unknown>);
      expect(new Set(metas.map((m) => m['rescheduleId']))).toEqual(new Set([result.rescheduleId]));
      const moved = entries.find((e) => e.entityId === items.b)?.meta as Record<string, unknown>;
      expect(moved['rescheduleTriggerId']).toBe(items.a);
    });

    it('refuses an apply whose plan or versions changed since the preview', async () => {
      const stale = await as('pm', 'POST', url('/reschedule'), {
        mode: 'apply',
        changes: [shortenA()],
        previewed: [],
      });
      expect(stale.statusCode).toBe(409);
      const version = await as('pm', 'POST', url('/reschedule'), {
        mode: 'apply',
        changes: [shortenA()],
        expect: { [items.a]: '2000-01-01T00:00:00.000Z' },
      });
      expect(version.statusCode).toBe(409);
      expect(await stored(items.a)).toEqual({ start: '2026-11-04', due: '2026-11-05' });
    });

    it('pins a later start and undoes exactly with only', async () => {
      const later = (
        await as('pm', 'POST', url('/reschedule'), {
          mode: 'apply',
          changes: [{ item: items.b, startDate: '2026-11-09', startSecondHalf: false }],
        })
      ).json() as RescheduleResultDto;
      const change = later.changes[0];
      expect(change.pinTo).toEqual({ date: '2026-11-09', second: false });
      const undo = await as('pm', 'POST', url('/reschedule'), {
        mode: 'only',
        changes: [{ item: items.b, ...change.from, pinTo: change.pinFrom }],
        expect: Object.fromEntries(later.items.map((i) => [i.id, i.updatedAt])),
      });
      expect(undo.statusCode).toBe(200);
      const row = await prisma.workItem.findUniqueOrThrow({ where: { id: items.b } });
      expect(row.startNoEarlierThan).toBeNull();
      expect(row.startSecondHalf).toBe(true);
      expect(await stored(items.b)).toEqual({ start: '2026-11-05', due: '2026-11-11' });
    });

    it('applies the permission matrix', async () => {
      const body = { mode: 'preview', changes: [shortenA()] };
      expect((await as('lead', 'POST', url('/reschedule'), body)).statusCode).toBe(200);
      expect((await as('viewer', 'POST', url('/reschedule'), body)).statusCode).toBe(403);
      expect((await as('admin', 'POST', url('/reschedule'), body)).statusCode).toBe(403);
      expect((await as('outsider', 'POST', url('/reschedule'), body)).statusCode).toBe(404);
      // A Member may edit only their own items.
      expect((await as('member', 'POST', url('/reschedule'), body)).statusCode).toBe(403);
      // A hidden item is 404, before any version check could hint at it.
      const hidden = await as('own', 'POST', url('/reschedule'), {
        mode: 'apply',
        changes: [{ item: items.p, dueDate: '2026-11-04' }],
        expect: { [items.p]: 'x' },
      });
      expect(hidden.statusCode).toBe(404);
      await prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
      expect((await as('pm', 'POST', url('/reschedule'), body)).statusCode).toBe(409);
      expect((await as('pm', 'GET', url())).statusCode).toBe(200);
    });

    it('keeps the schedule to PMs and Leads unless a PM opens it to Members (M9.2)', async () => {
      const body = { mode: 'preview', changes: [{ item: items.m, startDate: '2026-11-02' }] };
      const refused = await as('own', 'POST', url('/reschedule'), body);
      expect(refused.statusCode).toBe(403);
      expect(JSON.stringify(refused.json())).toContain('Only PMs and Leads');
      const setting = { settings: { planLeadsOnly: false } };
      const project = `/api/v1/projects/${projectId}`;
      expect((await as('lead', 'PATCH', project, setting)).statusCode).toBe(403);
      expect((await as('member', 'PATCH', project, setting)).statusCode).toBe(403);
      const opened = await as('pm', 'PATCH', project, setting);
      expect((opened.json() as ProjectDto).settings.planLeadsOnly).toBe(false);
      expect((await as('own', 'POST', url('/reschedule'), body)).statusCode).toBe(200);
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'PROJECT_UPDATED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(JSON.stringify(audit?.meta)).toContain('settings.planLeadsOnly');
      // Personal spaces have no such setting.
      const personal = (await as('pm', 'POST', '/api/v1/me/personal')).json() as ProjectDto;
      const personalPatch = await as('pm', 'PATCH', `/api/v1/projects/${personal.id}`, setting);
      expect(personalPatch.statusCode).toBe(400);
    });

    it('never lets a hidden predecessor shape or reveal a plan', async () => {
      await prisma.project.update({
        where: { id: projectId },
        data: { settings: { planLeadsOnly: false } },
      });
      // M starts before hidden P allows, but `own` cannot see P, so M is not snapped.
      const plan = (
        await as('own', 'POST', url('/reschedule'), {
          mode: 'preview',
          changes: [{ item: items.m, startDate: '2026-11-02' }],
        })
      ).json() as RescheduleResultDto;
      expect(plan.changes.map((c) => c.snapped)).toEqual([false]);
      expect(JSON.stringify(plan)).not.toContain(items.p);
      // A PM's change of P moves M; M's history hides P from `own`.
      await as('pm', 'POST', url('/reschedule'), {
        mode: 'apply',
        changes: [{ item: items.p, dueDate: '2026-11-06' }],
      });
      expect(await stored(items.m)).toEqual({ start: '2026-11-09', due: '2026-11-10' });
      const history = (
        await as('own', 'GET', `/api/v1/projects/${projectId}/items/${items.m}/activity`)
      ).json() as Page<AuditEntryDto>;
      expect(history.items[0]?.meta).toMatchObject({ rescheduleTriggerId: null, redacted: true });
      expect(JSON.stringify(history)).not.toContain(items.p);
    });
  });

  describe('half days and the project switch', () => {
    it('rejects a same-day item that would finish before it starts', async () => {
      const res = await as('pm', 'PATCH', `/api/v1/projects/${projectId}/items/${items.b}`, {
        startDate: '2026-11-05',
        startSecondHalf: true,
        dueDate: '2026-11-05',
        dueFirstHalf: true,
      });
      expect(res.statusCode).toBe(400);
      // A date change that names no halves (an import, a bulk edit) never
      // fails on them: B starts in the 2nd half, so it now finishes at the end.
      const plain = await as('pm', 'PATCH', `/api/v1/projects/${projectId}/items/${items.b}`, {
        dueDate: '2026-11-05',
      });
      expect(plain.statusCode).toBe(200);
      expect(plain.json()).toMatchObject({ startSecondHalf: true, dueFirstHalf: false });
    });

    it('lets PMs switch automatic moving, on by default for new projects only', async () => {
      const project = (await as('pm', 'GET', `/api/v1/projects/${projectId}`)).json() as ProjectDto;
      expect(project.settings.autoMoveDependents).toBe(false);
      const body = { settings: { autoMoveDependents: true } };
      expect((await as('lead', 'PATCH', `/api/v1/projects/${projectId}`, body)).statusCode).toBe(
        403,
      );
      const switched = await as('pm', 'PATCH', `/api/v1/projects/${projectId}`, body);
      expect((switched.json() as ProjectDto).settings.autoMoveDependents).toBe(true);
      const created = await as('admin', 'POST', '/api/v1/projects', {
        key: 'NEW',
        name: 'New',
        pmUserIds: [ids.pm],
      });
      expect((created.json() as ProjectDto).settings.autoMoveDependents).toBe(true);
      const personal = (await as('pm', 'POST', '/api/v1/me/personal')).json() as ProjectDto;
      const refused = await as('pm', 'PATCH', `/api/v1/projects/${personal.id}`, body);
      expect(refused.statusCode).toBe(400);
    });
  });
});
