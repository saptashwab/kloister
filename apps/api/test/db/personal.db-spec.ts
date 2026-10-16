import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type {
  ProjectDto,
  UserWorkDto,
  WorkItemDetailDto,
  Page,
  AuditEntryDto,
  NotificationDto,
} from '@kloister/shared';
import { NotificationsService } from '../../src/notifications/notifications.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  call,
  login,
  resetDb,
  seedUser,
  seedProject,
  seedBucket,
  seedItem,
  startApp,
  upload,
  PASSWORD,
} from './support.js';

// Private spaces and My work use the real API in CI only. Every personal
// endpoint is exercised without granting an ordinary membership to its owner.
describe('personal spaces and My work (db)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let owner: string;
  let other: string;
  let admin: string;
  let personal: ProjectDto;
  let item: WorkItemDetailDto;
  let sessions: { owner: string; other: string; admin: string };
  beforeAll(async () => {
    ({ app, prisma } = await startApp());
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(prisma);
    owner = (await seedUser(prisma, { email: 'owner@example.org' })).id;
    other = (await seedUser(prisma, { email: 'other@example.org' })).id;
    admin = (await seedUser(prisma, { email: 'admin@example.org', systemRole: 'ADMIN' })).id;
    sessions = {
      owner: await login(app, 'owner@example.org'),
      other: await login(app, 'other@example.org'),
      admin: await login(app, 'admin@example.org'),
    };
    const res = await call(app, 'POST', '/api/v1/me/personal', { sid: sessions.owner });
    expect(res.statusCode).toBe(200);
    personal = res.json() as ProjectDto;
    const bucket = await prisma.bucket.findFirstOrThrow({
      where: { projectId: personal.id },
      orderBy: { position: 'asc' },
    });
    const created = await call(app, 'POST', `/api/v1/projects/${personal.id}/items`, {
      sid: sessions.owner,
      body: { type: 'TASK', title: 'Private training', bucketId: bucket.id },
    });
    expect(created.statusCode).toBe(201);
    item = created.json() as WorkItemDetailDto;
  });

  it('creates exactly one caller-owned space atomically, without members or assignments', async () => {
    expect(personal.key).toBeNull();
    expect(personal.ownerId).toBe(owner);
    expect(item.key).toBe('#1');
    expect(item.assigneeIds).toEqual([]);
    const results = await Promise.all([
      call(app, 'POST', '/api/v1/me/personal', { sid: sessions.owner }),
      call(app, 'POST', '/api/v1/me/personal', { sid: sessions.owner, body: { ownerId: other } }),
    ]);
    expect(results.map((r) => (r.json() as ProjectDto).id)).toEqual([personal.id, personal.id]);
    expect(await prisma.project.count({ where: { ownerId: owner } })).toBe(1);
    expect(await prisma.projectMember.count({ where: { projectId: personal.id } })).toBe(0);
    expect(await prisma.workItemAssignee.count({ where: { projectId: personal.id } })).toBe(0);
    expect(await prisma.bucket.count({ where: { projectId: personal.id } })).toBe(4);
  });

  it('permits owner bucket creation/reorder while hiding the same operations from others', async () => {
    const base = `/api/v1/projects/${personal.id}/buckets`;
    const created = await call(app, 'POST', base, {
      sid: sessions.owner,
      body: { name: 'Review', onEnterMode: 'NONE', onEnterStatus: null },
    });
    expect(created.statusCode).toBe(201);
    const bucket = created.json() as { id: string; onEnterMode: string; onEnterStatus: null };
    expect(bucket.onEnterMode).toBe('NONE');
    expect(bucket.onEnterStatus).toBeNull();
    for (const caller of ['other', 'admin'] as const) {
      expect(
        (
          await call(app, 'POST', `${base}/${bucket.id}/move`, {
            sid: sessions[caller],
            body: { afterId: null },
          })
        ).statusCode,
      ).toBe(404);
    }
    expect(
      (
        await call(app, 'POST', `${base}/${bucket.id}/move`, {
          sid: sessions.owner,
          body: { afterId: null },
        })
      ).statusCode,
    ).toBe(200);
    const first = await prisma.bucket.findFirstOrThrow({
      where: { projectId: personal.id },
      orderBy: { position: 'asc' },
    });
    expect(first.id).toBe(bucket.id);
    expect(await prisma.projectMember.count({ where: { projectId: personal.id } })).toBe(0);
  });

  for (const caller of ['owner', 'other', 'admin'] as const) {
    it(`${caller}: me/personal always resolves the caller's own space`, async () => {
      const sid = sessions[caller];
      const before = await call(app, 'GET', '/api/v1/me/personal', { sid });
      expect(before.statusCode).toBe(caller === 'owner' ? 200 : 404);
      const ensured = await call(app, 'POST', '/api/v1/me/personal', {
        sid,
        body: { ownerId: owner },
      });
      const project = ensured.json() as ProjectDto;
      expect(project.ownerId).toBe({ owner, other, admin }[caller]);
      expect((await call(app, 'GET', '/api/v1/me/personal', { sid })).statusCode).toBe(200);
      if (caller !== 'owner') expect(project.id).not.toBe(personal.id);
    });
  }

  const routes: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; body?: object }[] = [
    { method: 'GET', path: '' },
    { method: 'PATCH', path: '', body: { name: 'Stolen' } },
    { method: 'GET', path: '/buckets' },
    { method: 'POST', path: '/buckets', body: { name: 'Leak' } },
    { method: 'GET', path: '/labels' },
    { method: 'POST', path: '/labels', body: { name: 'Leak', colour: '#123456' } },
    { method: 'GET', path: '/sprints' },
    {
      method: 'POST',
      path: '/sprints',
      body: { name: 'Leak', startDate: '2026-10-15', endDate: '2026-10-22' },
    },
    { method: 'GET', path: '/items' },
    { method: 'POST', path: '/items', body: { type: 'TASK', title: 'Leak' } },
    { method: 'GET', path: '/items/1' },
    { method: 'PATCH', path: '/items/1', body: { status: 'DONE' } },
    { method: 'DELETE', path: '/items/1' },
    { method: 'POST', path: '/items/1/move', body: { bucketId: null } },
    { method: 'GET', path: '/items/1/checklist' },
    { method: 'POST', path: '/items/1/checklist', body: { text: 'Leak' } },
    { method: 'GET', path: '/items/1/children' },
    { method: 'GET', path: '/items/1/activity' },
    { method: 'GET', path: '/items/1/notes' },
    { method: 'POST', path: '/items/1/notes', body: { body: 'Leak' } },
    { method: 'GET', path: '/items/1/attachments' },
    { method: 'GET', path: '/members' },
    { method: 'POST', path: '/members', body: { role: 'PM' } },
    { method: 'GET', path: '/member-candidates' },
    { method: 'GET', path: '/teams' },
    { method: 'POST', path: '/teams', body: { name: 'Leak' } },
    { method: 'POST', path: '/archive' },
  ];
  for (const caller of ['other', 'admin'] as const)
    for (const route of routes) {
      it(`${caller}: ${route.method} ${route.path || '/'} hides another owner's personal space`, async () => {
        const res = await call(app, route.method, `/api/v1/projects/${personal.id}${route.path}`, {
          sid: sessions[caller],
          ...(route.body ? { body: route.body } : {}),
        });
        expect(res.statusCode).toBe(404);
        expect(
          await prisma.auditLog.count({ where: { action: 'ADMIN_CROSS_PROJECT_ACCESS' } }),
        ).toBe(0);
      });
    }

  it('owner has board, sprint, item, checklist and note rights but no membership/team/archive routes', async () => {
    const sid = sessions.owner;
    for (const path of ['members', 'member-candidates', 'teams'])
      expect(
        (await call(app, 'GET', `/api/v1/projects/${personal.id}/${path}`, { sid })).statusCode,
      ).toBe(404);
    for (const path of ['archive', 'unarchive'])
      expect(
        (await call(app, 'POST', `/api/v1/projects/${personal.id}/${path}`, { sid })).statusCode,
      ).toBe(404);
    expect(
      (
        await call(app, 'POST', `/api/v1/projects/${personal.id}/members`, {
          sid,
          body: { userId: admin, role: 'PM' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(app, 'POST', `/api/v1/projects/${personal.id}/teams`, {
          sid,
          body: { name: 'Forbidden' },
        })
      ).statusCode,
    ).toBe(404);
    for (const body of [
      { assigneeIds: [owner] },
      { assigneeIds: [admin] },
      { teamId: randomUUID() },
    ]) {
      expect(
        (await call(app, 'PATCH', `/api/v1/projects/${personal.id}/items/1`, { sid, body }))
          .statusCode,
      ).toBe(400);
    }
    expect(
      (
        await call(app, 'POST', `/api/v1/projects/${personal.id}/items`, {
          sid,
          body: { type: 'EPIC', title: 'Forbidden owner assignment', assigneeIds: [owner] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(app, 'PATCH', `/api/v1/projects/${personal.id}`, {
          sid,
          body: { settings: { membersCanAssignOthers: true } },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(app, 'PATCH', `/api/v1/projects/${personal.id}`, {
          sid,
          body: { settings: { labelStyle: 'TINTED' } },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(app, 'POST', `/api/v1/projects/${personal.id}/labels`, {
          sid,
          body: { name: 'Private', colour: '#123456' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await call(app, 'POST', `/api/v1/projects/${personal.id}/sprints`, {
          sid,
          body: { name: 'Training', startDate: '2026-10-15', endDate: '2026-10-22' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await call(app, 'POST', `/api/v1/projects/${personal.id}/items/1/checklist`, {
          sid,
          body: { text: 'Finish lesson' },
        })
      ).statusCode,
    ).toBe(201);
    const note = await call(app, 'POST', `/api/v1/projects/${personal.id}/items/1/notes`, {
      sid,
      body: { body: `<p><span data-mention="${admin}">@Admin</span> personal note</p>` },
    });
    expect(note.statusCode).toBe(201);
    expect(JSON.stringify(note.json())).not.toContain('data-mention');
    expect(await prisma.notification.count({ where: { type: 'MENTIONED' } })).toBe(0);
  });

  it('excludes personal metadata and activity from all project and admin audit lists, including cursors', async () => {
    for (const sid of Object.values(sessions)) {
      const projects = await call(app, 'GET', '/api/v1/projects', { sid });
      expect(JSON.stringify(projects.json())).not.toContain(personal.id);
    }
    const all = await call(app, 'GET', '/api/v1/projects?scope=all&includeArchived=true', {
      sid: sessions.admin,
    });
    expect(JSON.stringify(all.json())).not.toContain(personal.id);
    const hiddenCursor = await call(
      app,
      'GET',
      `/api/v1/projects?scope=all&cursor=${personal.id}`,
      { sid: sessions.admin },
    );
    expect(hiddenCursor.json()).toEqual({ items: [], nextCursor: null });
    const history = (
      await call(app, 'GET', `/api/v1/projects/${personal.id}/items/1/activity`, {
        sid: sessions.owner,
      })
    ).json() as Page<AuditEntryDto>;
    expect(history.items.length).toBeGreaterThan(0);
    for (const query of [
      '',
      `?projectId=${personal.id}`,
      `?actorId=${owner}`,
      `?cursor=${history.items[0]?.id}`,
    ]) {
      const audit = await call(app, 'GET', `/api/v1/admin/audit${query}`, { sid: sessions.admin });
      expect(audit.statusCode).toBe(200);
      expect(JSON.stringify(audit.json())).not.toContain(personal.id);
      expect(JSON.stringify(audit.json())).not.toContain('Private training');
    }
  });

  it('My work includes every personal task and scoped assigned/created project work, with filters and Done opt-in', async () => {
    const project = await seedProject(prisma, 'OWN', [
      { userId: owner, role: 'MEMBER', visibility: 'OWN' },
      { userId: other, role: 'PM' },
    ]);
    const bucket = await seedBucket(prisma, project.id, 'Project bucket');
    const assigned = await seedItem(prisma, project.id, {
      createdById: other,
      bucketId: bucket.id,
      assigneeIds: [owner],
    });
    const created = await seedItem(prisma, project.id, { createdById: owner, bucketId: bucket.id });
    await seedItem(prisma, project.id, { createdById: other, bucketId: bucket.id });
    const done = await seedItem(prisma, personal.id, {
      createdById: owner,
      bucketId: item.bucketId,
      status: 'DONE',
    });
    const read = async (query = '') =>
      (
        await call(app, 'GET', `/api/v1/me/work${query}`, { sid: sessions.owner })
      ).json() as UserWorkDto;
    expect((await read()).items.map((i) => i.id).sort()).toEqual([item.id, assigned.id].sort());
    expect((await read('?includeCreated=true')).items.map((i) => i.id).sort()).toEqual(
      [item.id, assigned.id, created.id].sort(),
    );
    expect((await read('?source=PERSONAL')).items.map((i) => i.id)).toEqual([item.id]);
    expect((await read('?source=PROJECTS')).items.map((i) => i.id)).toEqual([assigned.id]);
    expect((await read('?source=PERSONAL&includeDone=true')).items.map((i) => i.id).sort()).toEqual(
      [item.id, done.id].sort(),
    );
    expect((await read(`?projectId=${randomUUID()}`)).items).toEqual([]);
    expect((await read('?type=BUG')).items).toEqual([]);
    const theirs = (
      await call(app, 'GET', `/api/v1/users/${owner}/work?includeCreated=true&includeDone=true`, {
        sid: sessions.other,
      })
    ).json() as UserWorkDto;
    expect(theirs.items.some((i) => i.personal)).toBe(false);
    expect(theirs.items.map((i) => i.id).sort()).toEqual([assigned.id, created.id].sort());
    expect(
      (
        await call(app, 'GET', `/api/v1/users/${owner}/work?source=PERSONAL`, {
          sid: sessions.admin,
        })
      ).json(),
    ).toMatchObject({ items: [] });
  });

  it('personal due reminders go only to the active owner and remain hidden from others', async () => {
    await prisma.workItem.update({
      where: { id: item.id },
      data: { dueDate: new Date('2026-10-16T00:00:00Z') },
    });
    await app.get(NotificationsService).checkDueDates(new Date(2026, 9, 15, 9));
    const notices = (
      await call(app, 'GET', '/api/v1/notifications', { sid: sessions.owner })
    ).json() as Page<NotificationDto>;
    expect(notices.items).toHaveLength(1);
    expect(notices.items[0]?.item.key).toBe('#1');
    for (const sid of [sessions.other, sessions.admin]) {
      expect(
        ((await call(app, 'GET', '/api/v1/notifications', { sid })).json() as Page<NotificationDto>)
          .items,
      ).toEqual([]);
    }
    await prisma.user.update({ where: { id: owner }, data: { isActive: false } });
    const snapshot = await prisma.project.findUnique({ where: { id: personal.id } });
    expect(
      (await call(app, 'GET', `/api/v1/projects/${personal.id}`, { sid: sessions.owner }))
        .statusCode,
    ).toBe(401);
    await app.get(NotificationsService).checkDueDates(new Date(2026, 9, 16, 9));
    expect(await prisma.notification.count()).toBe(1);
    expect(await prisma.project.findUnique({ where: { id: personal.id } })).toEqual(snapshot);
    await prisma.user.update({ where: { id: owner }, data: { isActive: true } });
    const restored = await login(app, 'owner@example.org', PASSWORD);
    expect(
      (await call(app, 'GET', `/api/v1/projects/${personal.id}`, { sid: restored })).statusCode,
    ).toBe(200);
  });

  it('uploads use the personal quota, and files/images never bypass owner authorization', async () => {
    await prisma.appSetting.create({
      data: { key: 'storage', value: { maxFileSizeMb: 1, projectQuotaMb: 2, personalQuotaMb: 1 } },
    });
    const url = `/api/v1/projects/${personal.id}/items/1/attachments`;
    for (const sid of [sessions.other, sessions.admin])
      expect((await upload(app, url, sid, Buffer.from('private'), 'private.txt')).statusCode).toBe(
        404,
      );
    const res = await upload(app, url, sessions.owner, Buffer.alloc(700_000), 'private.txt');
    expect(res.statusCode).toBe(201);
    const file = res.json() as { id: string };
    for (const sid of [sessions.other, sessions.admin]) {
      expect((await call(app, 'GET', `${url}/${file.id}`, { sid })).statusCode).toBe(404);
      expect(
        (
          await call(app, 'GET', `/api/v1/projects/${personal.id}/items/1/images/${randomUUID()}`, {
            sid,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await upload(
            app,
            `/api/v1/projects/${personal.id}/items/1/images`,
            sid,
            Buffer.from('GIF89a'),
            'image.gif',
          )
        ).statusCode,
      ).toBe(404);
    }
    expect(
      (await upload(app, url, sessions.owner, Buffer.alloc(400_000), 'over.txt')).statusCode,
    ).toBe(409);
    expect((await call(app, 'GET', `${url}/${file.id}`, { sid: sessions.owner })).statusCode).toBe(
      200,
    );
  });
});
