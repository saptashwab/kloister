import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AuditAction, type AuditEntryDto, ErrorCode, type Page } from '@kloister/shared';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  call,
  codeOf,
  login,
  resetDb,
  seedBucket,
  seedItem,
  seedProject,
  seedUser,
  startApp,
} from './support.js';

describe('audit log viewer (db)', () => {
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

  it('is forbidden to non-admins', async () => {
    await seedUser(prisma, { email: 'user@example.org' });
    const sid = await login(app, 'user@example.org');
    const res = await call(app, 'GET', '/api/v1/admin/audit', { sid });
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe(ErrorCode.FORBIDDEN);
  });

  it('lists entries newest first with actor emails, filters and pagination', async () => {
    const admin = await seedUser(prisma, { email: 'admin@example.org', systemRole: 'ADMIN' });
    await seedUser(prisma, { email: 'user@example.org' });
    await login(app, 'user@example.org');
    await call(app, 'POST', '/api/v1/auth/login', {
      body: { email: 'user@example.org', password: 'wrong-password' },
    });
    const sid = await login(app, 'admin@example.org');

    const all = (
      await call(app, 'GET', '/api/v1/admin/audit', { sid })
    ).json() as Page<AuditEntryDto>;
    expect(all.items.map((e) => e.action)).toEqual([
      AuditAction.LOGIN_SUCCEEDED,
      AuditAction.LOGIN_FAILED,
      AuditAction.LOGIN_SUCCEEDED,
    ]);
    expect(all.items[0]).toMatchObject({ actorId: admin.id, actorEmail: 'admin@example.org' });

    const failed = (
      await call(app, 'GET', `/api/v1/admin/audit?action=${AuditAction.LOGIN_FAILED}`, { sid })
    ).json() as Page<AuditEntryDto>;
    expect(failed.items).toHaveLength(1);
    expect(failed.items[0]?.meta).toMatchObject({ reason: 'bad_password' });

    const byActor = (
      await call(app, 'GET', `/api/v1/admin/audit?actorId=${admin.id}`, { sid })
    ).json() as Page<AuditEntryDto>;
    expect(byActor.items).toHaveLength(1);

    const page1 = (
      await call(app, 'GET', '/api/v1/admin/audit?limit=2', { sid })
    ).json() as Page<AuditEntryDto>;
    expect(page1.items).toHaveLength(2);
    const page2 = (
      await call(app, 'GET', `/api/v1/admin/audit?limit=2&cursor=${page1.nextCursor ?? ''}`, {
        sid,
      })
    ).json() as Page<AuditEntryDto>;
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const future = new Date(Date.now() + 3_600_000).toISOString();
    const none = (
      await call(app, 'GET', `/api/v1/admin/audit?from=${encodeURIComponent(future)}`, { sid })
    ).json() as Page<AuditEntryDto>;
    expect(none.items).toEqual([]);
  });

  it('rejects malformed filters', async () => {
    await seedUser(prisma, { email: 'admin@example.org', systemRole: 'ADMIN' });
    const sid = await login(app, 'admin@example.org');
    expect((await call(app, 'GET', '/api/v1/admin/audit?actorId=nope', { sid })).statusCode).toBe(
      400,
    );
    expect((await call(app, 'GET', '/api/v1/admin/audit?from=yesterday', { sid })).statusCode).toBe(
      400,
    );
    expect((await call(app, 'GET', '/api/v1/admin/audit?limit=1000', { sid })).statusCode).toBe(
      400,
    );
  });

  it('names actors, projects and entities at read time without item titles (M8.5)', async () => {
    await seedUser(prisma, { email: 'admin@example.org', systemRole: 'ADMIN' });
    const pm = await seedUser(prisma, { email: 'pm@example.org' });
    const project = await seedProject(prisma, 'KLO', [{ userId: pm.id, role: 'PM' }]);
    const bucket = await seedBucket(prisma, project.id, 'Doing');
    const item = await seedItem(prisma, project.id, {
      createdById: pm.id,
      bucketId: bucket.id,
      title: 'Secret plan',
    });
    const entries = [
      { entityType: 'WorkItem', entityId: item.id },
      { entityType: 'Bucket', entityId: bucket.id },
      { entityType: 'User', entityId: pm.id },
      { entityType: 'Label', entityId: '00000000-0000-4000-8000-000000000000' },
      { entityType: 'AppSetting', entityId: 'theme' },
    ];
    for (const [i, e] of entries.entries())
      await prisma.auditLog.create({
        data: {
          actorId: pm.id,
          action: AuditAction.ITEM_UPDATED,
          projectId: project.id,
          meta: {},
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
          ...e,
        },
      });
    const sid = await login(app, 'admin@example.org');
    const page = (
      await call(app, 'GET', `/api/v1/admin/audit?projectId=${project.id}`, { sid })
    ).json() as Page<AuditEntryDto>;
    const byType = new Map(page.items.map((e) => [e.entityType, e]));
    expect(byType.get('WorkItem')).toMatchObject({
      actorName: 'pm',
      projectKey: 'KLO',
      projectName: 'Project KLO',
      entityLabel: 'KLO-1',
    });
    expect(byType.get('Bucket')?.entityLabel).toBe('Doing');
    expect(byType.get('User')?.entityLabel).toBe('pm');
    // A deleted entity and a non-uuid id are not resolved.
    expect(byType.get('Label')?.entityLabel).toBeNull();
    expect(byType.get('AppSetting')?.entityLabel).toBeNull();
    expect(JSON.stringify(page.items)).not.toContain('Secret plan');
  });
});
