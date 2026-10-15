import { createHash } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { inlineImagePath, type WorkItemDetailDto } from '@kloister/shared';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  call,
  login,
  resetDb,
  seedUser,
  seedProject,
  seedBucket,
  seedItem,
  seedTeam,
  seedAttachment,
  seedNote,
  seedSprint,
  startApp,
  GIF,
  PASSWORD,
} from './support.js';

// Full permission and content checks run against the disposable CI database only.
describe('same-space copies and readable snapshots (db)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let projectId: string;
  let bucketId: string;
  let hiddenBucketId: string;
  let sourceId: string;
  let hiddenId: string;
  let pm: string;
  let member: string;
  let sids: Record<string, string>;
  beforeAll(async () => {
    ({ app, prisma } = await startApp());
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(prisma);
    const users = await Promise.all(
      ['pm', 'lead', 'member', 'viewer', 'admin', 'outsider'].map((name) =>
        seedUser(prisma, {
          email: `${name}@example.org`,
          ...(name === 'admin' ? { systemRole: 'ADMIN' } : {}),
        }),
      ),
    );
    pm = users[0]?.id ?? '';
    member = users[2]?.id ?? '';
    const project = await seedProject(
      prisma,
      'KLO',
      users.slice(0, 4).map((user, index) => ({
        userId: user.id,
        role: (['PM', 'LEAD', 'MEMBER', 'VIEWER'] as const)[index] ?? 'VIEWER',
      })),
    );
    projectId = project.id;
    bucketId = (await seedBucket(prisma, projectId, 'Visible')).id;
    hiddenBucketId = (await seedBucket(prisma, projectId, 'Hidden')).id;
    sourceId = (
      await seedItem(prisma, projectId, {
        createdById: pm,
        bucketId,
        title: '=literal source',
        status: 'DONE',
        assigneeIds: [member],
      })
    ).id;
    hiddenId = (
      await seedItem(prisma, projectId, {
        createdById: pm,
        bucketId: hiddenBucketId,
        title: 'Hidden reference',
      })
    ).id;
    sids = Object.fromEntries(
      await Promise.all(
        users.map(
          async (user) => [user.email.split('@')[0] ?? '', await login(app, user.email)] as const,
        ),
      ),
    );
  });

  for (const role of ['pm', 'lead', 'member', 'viewer', 'admin', 'outsider']) {
    it(`${role}: guards duplication and both snapshot routes independently`, async () => {
      const readStatus = role === 'outsider' ? 404 : 200;
      const copyStatus = role === 'outsider' ? 404 : ['viewer', 'admin'].includes(role) ? 403 : 201;
      const copied = await call(
        app,
        'POST',
        `/api/v1/projects/${projectId}/items/${sourceId}/duplicate`,
        { sid: sids[role], body: { copies: [{ title: 'Fresh task', assigneeIds: [] }], bucketId } },
      );
      expect(copied.statusCode).toBe(copyStatus);
      for (const suffix of ['/preview', '']) {
        const response = await call(
          app,
          'GET',
          `/api/v1/projects/${projectId}/snapshots${suffix}`,
          { sid: sids[role] },
        );
        expect(response.statusCode).toBe(readStatus);
      }
      for (const suffix of ['/preview', ''])
        expect(
          (await call(app, 'GET', `/api/v1/me/snapshots${suffix}`, { sid: sids[role] })).statusCode,
        ).toBe(200);
      if (role === 'admin')
        expect(
          await prisma.auditLog.count({ where: { action: 'ADMIN_CROSS_PROJECT_ACCESS' } }),
        ).toBeGreaterThan(0);
    });
  }

  it('requires a signed-in, password-cleared session for every snapshot and copy route', async () => {
    await seedUser(prisma, { email: 'pending@example.org', mustChangePassword: true });
    const pending = await login(app, 'pending@example.org');
    const routes = [
      ['GET', `/api/v1/projects/${projectId}/snapshots`],
      ['GET', `/api/v1/projects/${projectId}/snapshots/preview`],
      ['GET', '/api/v1/me/snapshots'],
      ['GET', '/api/v1/me/snapshots/preview'],
      ['POST', `/api/v1/projects/${projectId}/items/${sourceId}/duplicate`],
    ] as const;
    for (const [method, path] of routes) {
      expect((await call(app, method, path)).statusCode).toBe(401);
      expect((await call(app, method, path, { sid: pending })).statusCode).toBe(403);
    }
  });

  for (const scope of ['ALL', 'OWN', 'BUCKETS', 'TEAMS'] as const) {
    it(`${scope}: copy sources and snapshot details obey visibility`, async () => {
      await prisma.projectMember.update({
        where: { projectId_userId: { projectId, userId: member } },
        data: { visibility: scope, allowedBucketIds: scope === 'BUCKETS' ? [bucketId] : [] },
      });
      if (scope === 'TEAMS') {
        const team = await seedTeam(prisma, projectId, 'Member team', [
          { userId: member, role: 'MEMBER' },
        ]);
        await prisma.workItem.update({ where: { id: sourceId }, data: { teamId: team.id } });
      }
      const copied = await call(
        app,
        'POST',
        `/api/v1/projects/${projectId}/items/${hiddenId}/duplicate`,
        {
          sid: sids['member'],
          body: { copies: [{ title: 'Hidden copy', assigneeIds: [] }], bucketId },
        },
      );
      expect(copied.statusCode).toBe(scope === 'ALL' ? 201 : 404);
      const preview = await call(app, 'GET', `/api/v1/projects/${projectId}/snapshots/preview`, {
        sid: sids['member'],
      });
      expect(preview.statusCode).toBe(200);
      const download = await call(app, 'GET', `/api/v1/projects/${projectId}/snapshots`, {
        sid: sids['member'],
      });
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Uint8Array.from(download.rawPayload).buffer);
      const titles: string[] = [];
      workbook.getWorksheet('Items')?.eachRow((row, index) => {
        if (index > 1) titles.push(row.getCell(2).text);
      });
      expect(titles.includes('Hidden reference')).toBe(scope === 'ALL');
      expect(titles).toContain('=literal source');
    });
  }

  it('resets progress, copies allowed fields/files independently, and never copies children, notes or dependencies', async () => {
    await prisma.checklistItem.create({
      data: { workItemId: sourceId, text: 'Unchecked in copy', done: true, position: 1 },
    });
    await seedNote(prisma, sourceId, pm, '<p>Do not copy this note</p>');
    const label = await prisma.label.create({
      data: { projectId, name: 'Retained', colour: '#336699' },
    });
    await prisma.workItemLabel.create({
      data: { projectId, workItemId: sourceId, labelId: label.id },
    });
    const sprint = await seedSprint(prisma, projectId, 'Open');
    const image = await seedAttachment(prisma, projectId, sourceId, pm, { inline: true });
    const attachment = await seedAttachment(prisma, projectId, sourceId, pm, {
      name: '../evidence.gif',
    });
    await prisma.attachment.updateMany({
      where: { workItemId: sourceId },
      data: { sha256: createHash('sha256').update(GIF).digest('hex') },
    });
    await prisma.workItem.update({
      where: { id: sourceId },
      data: {
        sprintId: sprint.id,
        startDate: new Date('2026-10-15'),
        dueDate: new Date('2026-10-20'),
        description: `<p>Original <img src="${inlineImagePath(projectId, sourceId, image.id)}" alt="Evidence" /></p>`,
        completedAt: new Date(),
      },
    });
    const response = await call(
      app,
      'POST',
      `/api/v1/projects/${projectId}/items/${sourceId}/duplicate`,
      {
        sid: sids['pm'],
        body: {
          copies: [
            { title: 'For member', assigneeIds: [member] },
            { title: 'Unassigned', assigneeIds: [] },
          ],
          bucketId,
          attachments: true,
          keepDates: true,
          keepSprint: true,
        },
      },
    );
    expect(response.statusCode).toBe(201);
    const copies = response.json() as WorkItemDetailDto[];
    expect(copies).toHaveLength(2);
    for (const copy of copies) {
      expect(copy.status).toBe('NOT_STARTED');
      expect(copy.completedAt).toBeNull();
      expect(copy.createdById).toBe(pm);
      expect(copy.checklistItems[0]?.done).toBe(false);
      expect(copy.labelIds).toEqual([label.id]);
      expect(copy.startDate).toBe('2026-10-15');
      expect(copy.sprintId).toBe(sprint.id);
      expect(copy.description).toContain(`/items/${copy.id}/images/`);
      expect(copy.description).not.toContain(image.id);
      expect(await prisma.note.count({ where: { workItemId: copy.id } })).toBe(0);
      const files = await prisma.attachment.findMany({ where: { workItemId: copy.id } });
      expect(files).toHaveLength(2);
      expect(
        files.every(
          (file) =>
            file.storedName !== image.storedName && file.storedName !== attachment.storedName,
        ),
      ).toBe(true);
    }
    expect(new Set(copies.map((copy) => copy.number)).size).toBe(2);
  });

  it('rejects assignment escalation, unreadable/invalid parent references and atomically rolls back earlier copies', async () => {
    const before = await prisma.workItem.count({ where: { projectId } });
    const response = await call(
      app,
      'POST',
      `/api/v1/projects/${projectId}/items/${sourceId}/duplicate`,
      {
        sid: sids['member'],
        body: {
          bucketId,
          copies: [
            { title: 'Allowed first', assigneeIds: [member] },
            { title: 'Forbidden second', assigneeIds: [pm] },
          ],
        },
      },
    );
    expect(response.statusCode).toBe(403);
    expect(await prisma.workItem.count({ where: { projectId } })).toBe(before);
    const parent = await call(
      app,
      'POST',
      `/api/v1/projects/${projectId}/items/${sourceId}/duplicate`,
      {
        sid: sids['pm'],
        body: {
          bucketId,
          parentId: hiddenId,
          copies: [{ title: 'Invalid hierarchy', assigneeIds: [] }],
        },
      },
    );
    expect(parent.statusCode).toBe(400);
  });

  it('allows team Lead assignments only in that team and enforces destination visibility', async () => {
    const team = await seedTeam(prisma, projectId, 'Led', [{ userId: member, role: 'LEAD' }]);
    const body = { bucketId, teamId: team.id, copies: [{ title: 'Led team', assigneeIds: [pm] }] };
    expect(
      (
        await call(app, 'POST', `/api/v1/projects/${projectId}/items/${sourceId}/duplicate`, {
          sid: sids['member'],
          body,
        })
      ).statusCode,
    ).toBe(201);
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId, userId: member } },
      data: { visibility: 'BUCKETS', allowedBucketIds: [bucketId] },
    });
    expect(
      (
        await call(app, 'POST', `/api/v1/projects/${projectId}/items/${sourceId}/duplicate`, {
          sid: sids['member'],
          body: {
            bucketId: hiddenBucketId,
            copies: [{ title: 'Write-only destination', assigneeIds: [] }],
          },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('keeps archived projects readable/exportable and refuses duplicate writes', async () => {
    await prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    expect(
      (
        await call(app, 'POST', `/api/v1/projects/${projectId}/items/${sourceId}/duplicate`, {
          sid: sids['pm'],
          body: { copies: [{ title: 'No', assigneeIds: [] }], bucketId },
        })
      ).statusCode,
    ).toBe(409);
    for (const suffix of ['', '/preview'])
      expect(
        (
          await call(app, 'GET', `/api/v1/projects/${projectId}/snapshots${suffix}`, {
            sid: sids['viewer'],
          })
        ).statusCode,
      ).toBe(200);
    expect(
      (
        await call(app, 'GET', '/api/v1/me/snapshots/preview?includeDone=true', {
          sid: sids['member'],
        })
      ).json(),
    ).toMatchObject({ count: 0 });
  });

  it('exports every page without expanding My work to unassigned visible project items', async () => {
    for (let index = 0; index < 105; index++)
      await seedItem(prisma, projectId, {
        createdById: pm,
        bucketId,
        title: `Page ${index}`,
        assigneeIds: [member],
      });
    const response = await call(
      app,
      'GET',
      '/api/v1/me/snapshots/preview?scope=all&type=BUG&source=PROJECTS',
      { sid: sids['member'] },
    );
    expect(response.json()).toMatchObject({ count: 105 });
    expect(
      (
        await call(
          app,
          'GET',
          '/api/v1/me/snapshots/preview?scope=all&includeDone=true&source=PROJECTS',
          { sid: sids['member'] },
        )
      ).json(),
    ).toMatchObject({ count: 106 });
    expect(
      (
        await call(app, 'GET', '/api/v1/me/snapshots/preview?type=BUG&source=PROJECTS', {
          sid: sids['member'],
        })
      ).json(),
    ).toMatchObject({ count: 0 });
    expect(
      (
        await call(app, 'GET', '/api/v1/me/snapshots/preview?scope=all&source=PERSONAL', {
          sid: sids['member'],
        })
      ).json(),
    ).toMatchObject({ count: 0 });
    expect(
      (
        await call(app, 'GET', '/api/v1/me/snapshots/preview?scope=all', { sid: sids['admin'] })
      ).json(),
    ).toMatchObject({ count: 0 });
  });

  it('keeps hidden ancestors titles-only and excludes hidden dependencies and audit references from every sheet', async () => {
    const ancestor = await seedItem(prisma, projectId, {
      createdById: pm,
      type: 'STORY',
      bucketId: hiddenBucketId,
      title: 'Ancestor title only',
    });
    await prisma.workItem.update({ where: { id: sourceId }, data: { parentId: ancestor.id } });
    await prisma.workItemDependency.create({
      data: { projectId, blockedItemId: sourceId, blockingItemId: hiddenId },
    });
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId, userId: member } },
      data: { visibility: 'OWN' },
    });
    await prisma.auditLog.create({
      data: {
        actorId: pm,
        projectId,
        entityType: 'WorkItem',
        entityId: sourceId,
        action: 'DEPENDENCY_ADDED',
        meta: { blockingItemId: hiddenId },
      },
    });
    const response = await call(
      app,
      'GET',
      `/api/v1/projects/${projectId}/snapshots?offline=true`,
      { sid: sids['member'] },
    );
    expect(response.statusCode).toBe(200);
    const zip = await JSZip.loadAsync(response.rawPayload);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await zip.file('snapshot.xlsx')!.async('arraybuffer'));
    const all = JSON.stringify(workbook.model);
    expect(all).toContain('Ancestor title only');
    expect(all).not.toContain('Hidden reference');
    expect(all).not.toContain(hiddenId);
    expect(workbook.getWorksheet('Dependencies')?.rowCount).toBe(1);
    expect(workbook.getWorksheet('Items')?.rowCount).toBe(2);
  });

  it('serves personal snapshots and copies only to the owner, including against administrators', async () => {
    const space = (
      await call(app, 'POST', '/api/v1/me/personal', { sid: sids['member'] })
    ).json() as { id: string };
    const bucket = await prisma.bucket.findFirstOrThrow({ where: { projectId: space.id } });
    const item = await seedItem(prisma, space.id, {
      createdById: member,
      bucketId: bucket.id,
      title: 'Private evidence',
    });
    for (const role of ['member', 'admin', 'outsider']) {
      const allowed = role === 'member';
      for (const suffix of ['', '/preview'])
        expect(
          (
            await call(app, 'GET', `/api/v1/projects/${space.id}/snapshots${suffix}`, {
              sid: sids[role],
            })
          ).statusCode,
        ).toBe(allowed ? 200 : 404);
      expect(
        (
          await call(app, 'POST', `/api/v1/projects/${space.id}/items/${item.id}/duplicate`, {
            sid: sids[role],
            body: { bucketId: bucket.id, copies: [{ title: 'Private copy', assigneeIds: [] }] },
          })
        ).statusCode,
      ).toBe(allowed ? 201 : 404);
    }
    expect(
      (
        await call(app, 'POST', `/api/v1/projects/${space.id}/items/${item.id}/duplicate`, {
          sid: sids['member'],
          body: {
            bucketId: bucket.id,
            copies: [{ title: 'Bad assignment', assigneeIds: [member] }],
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(await prisma.projectMember.count({ where: { projectId: space.id } })).toBe(0);
    expect(
      (
        await call(app, 'GET', '/api/v1/me/snapshots/preview?source=PERSONAL', {
          sid: sids['admin'],
        })
      ).json(),
    ).toMatchObject({ count: 0 });
  });

  it('preserves offline HTML, independent files and safe original-name mappings', async () => {
    const image = await seedAttachment(prisma, projectId, sourceId, pm, { inline: true });
    const file = await seedAttachment(prisma, projectId, sourceId, pm, {
      name: '../../unsafe.gif',
    });
    const body = `<p><strong>Original formatting</strong><img src="${inlineImagePath(projectId, sourceId, image.id)}" alt="Offline evidence" /></p>`;
    await prisma.workItem.update({ where: { id: sourceId }, data: { description: body } });
    await seedNote(prisma, sourceId, pm, body);
    const response = await call(
      app,
      'GET',
      `/api/v1/projects/${projectId}/snapshots?offline=true`,
      { sid: sids['viewer'] },
    );
    const zip = await JSZip.loadAsync(response.rawPayload);
    const html = await zip.file(`items/${projectId}/${sourceId}/index.html`)!.async('string');
    expect(html).toContain('<strong>Original formatting</strong>');
    expect(html).not.toContain('src="api/');
    expect(Object.keys(zip.files).every((path) => !path.split('/').includes('..'))).toBe(true);
    const filePath = Object.keys(zip.files).find((path) => path.includes(`/files/${file.id}-`));
    expect(filePath).toBeDefined();
    expect(await zip.file(filePath ?? '')?.async('nodebuffer')).toEqual(GIF);
    expect(await zip.file('index.html')?.async('string')).toContain('snapshot.xlsx');
  });
});

describe('durable first introduction (db)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    ({ app, prisma } = await startApp());
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('keeps upgrade accounts exempt, including old temporary-password accounts', async () => {
    const user = await seedUser(prisma, { email: 'old@example.org', mustChangePassword: true });
    const sid = await login(app, user.email);
    expect(user.introductionState).toBe('EXEMPT');
    expect((await call(app, 'GET', '/api/v1/me/introduction', { sid })).statusCode).toBe(403);
    expect((await call(app, 'PUT', '/api/v1/me/introduction', { sid })).statusCode).toBe(403);
    expect(
      (
        await call(app, 'POST', '/api/v1/auth/change-password', {
          sid,
          body: { currentPassword: PASSWORD, newPassword: 'changed-password-1' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await call(app, 'GET', '/api/v1/me/introduction', { sid })).json()).toEqual({
      pending: false,
    });
  });

  it.each(['DISMISSED', 'EXEMPT', 'READY', 'AWAITING_INITIAL_PASSWORD'] as const)(
    'later password resets preserve %s',
    async (state) => {
      const admin = await seedUser(prisma, { email: 'admin@example.org', systemRole: 'ADMIN' });
      const user = await seedUser(prisma, { email: 'user@example.org' });
      await prisma.user.update({ where: { id: user.id }, data: { introductionState: state } });
      const adminSid = await login(app, admin.email);
      const reset = await call(app, 'POST', `/api/v1/admin/users/${user.id}/reset-password`, {
        sid: adminSid,
      });
      expect(reset.statusCode).toBe(200);
      const temporary = (reset.json() as { temporaryPassword: string }).temporaryPassword;
      const sid = await login(app, user.email, temporary);
      expect((await call(app, 'GET', '/api/v1/me/introduction', { sid })).statusCode).toBe(403);
      await call(app, 'POST', '/api/v1/auth/change-password', {
        sid,
        body: { currentPassword: temporary, newPassword: 'changed-password-2' },
      });
      expect((await call(app, 'GET', '/api/v1/me/introduction', { sid })).json()).toEqual({
        pending: state === 'READY' || state === 'AWAITING_INITIAL_PASSWORD',
      });
    },
  );

  it('enrolls new users only, advances after success, dismisses across browsers and never changes another user', async () => {
    const admin = await seedUser(prisma, { email: 'admin@example.org', systemRole: 'ADMIN' });
    const adminSid = await login(app, admin.email);
    const response = await call(app, 'POST', '/api/v1/admin/users', {
      sid: adminSid,
      body: { email: 'new@example.org', displayName: 'New user' },
    });
    const created = response.json() as { user: { id: string }; temporaryPassword: string };
    const sid = await login(app, 'new@example.org', created.temporaryPassword);
    const browser2 = await login(app, 'new@example.org', created.temporaryPassword);
    expect((await call(app, 'PUT', '/api/v1/me/introduction', { sid })).statusCode).toBe(403);
    expect(
      (
        await call(app, 'POST', '/api/v1/auth/change-password', {
          sid,
          body: { currentPassword: 'incorrect-password', newPassword: 'changed-password-3' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: created.user.id } })).introductionState,
    ).toBe('AWAITING_INITIAL_PASSWORD');
    await call(app, 'POST', '/api/v1/auth/change-password', {
      sid,
      body: { currentPassword: created.temporaryPassword, newPassword: 'changed-password-3' },
    });
    expect((await call(app, 'GET', '/api/v1/me/introduction', { sid })).json()).toEqual({
      pending: true,
    });
    expect((await call(app, 'GET', '/api/v1/me/introduction', { sid: browser2 })).statusCode).toBe(
      401,
    );
    const newBrowser = await login(app, 'new@example.org', 'changed-password-3');
    expect((await call(app, 'GET', '/api/v1/me/introduction', { sid: newBrowser })).json()).toEqual(
      { pending: true },
    );
    expect((await call(app, 'PUT', '/api/v1/me/introduction', { sid: newBrowser })).json()).toEqual(
      { pending: false },
    );
    expect((await call(app, 'GET', '/api/v1/me/introduction', { sid })).json()).toEqual({
      pending: false,
    });
    expect((await call(app, 'PUT', '/api/v1/me/introduction', { sid })).statusCode).toBe(200);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).introductionState,
    ).toBe('EXEMPT');
    expect((await call(app, 'GET', '/api/v1/me/introduction')).statusCode).toBe(401);
    expect((await call(app, 'PUT', '/api/v1/me/introduction')).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'PUT', url: '/api/v1/me/introduction', cookies: { sid } }))
        .statusCode,
    ).toBe(403);
  });
});
