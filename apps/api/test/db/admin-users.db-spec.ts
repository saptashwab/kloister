import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  AuditAction,
  ErrorCode,
  type Page,
  type TemporaryPasswordResponse,
  type UserDto,
} from '@kloister/shared';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { call, codeOf, login, resetDb, seedUser, startApp } from './support.js';

describe('admin user management (db)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let adminSid: string;
  let adminId: string;

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = (await seedUser(prisma, { email: 'admin@example.org', systemRole: 'ADMIN' })).id;
    adminSid = await login(app, 'admin@example.org');
  });

  // Permission matrix: every admin route is forbidden to plain users.
  it('forbids every admin user route to non-admins', async () => {
    const target = await seedUser(prisma, { email: 'target@example.org' });
    await seedUser(prisma, { email: 'user@example.org' });
    const sid = await login(app, 'user@example.org');
    const routes = [
      ['GET', '/api/v1/admin/users', undefined],
      ['GET', `/api/v1/admin/users/${target.id}`, undefined],
      ['POST', '/api/v1/admin/users', { email: 'x@example.org', displayName: 'X' }],
      ['PATCH', `/api/v1/admin/users/${target.id}`, { displayName: 'Y' }],
      ['POST', `/api/v1/admin/users/${target.id}/reset-password`, undefined],
    ] as const;
    for (const [method, url, body] of routes) {
      const res = await call(app, method, url, { sid, ...(body ? { body } : {}) });
      expect({ url, method, status: res.statusCode }).toEqual({ url, method, status: 403 });
      expect(codeOf(res)).toBe(ErrorCode.FORBIDDEN);
    }
    expect(await prisma.user.count({ where: { email: 'x@example.org' } })).toBe(0);
  });

  it('creates a user whose temporary password works once and must be changed', async () => {
    const res = await call(app, 'POST', '/api/v1/admin/users', {
      sid: adminSid,
      body: { email: 'New.Person@Example.org', displayName: 'New Person' },
    });
    expect(res.statusCode).toBe(201);
    const { user, temporaryPassword } = res.json() as TemporaryPasswordResponse;
    expect(user).toMatchObject({
      email: 'new.person@example.org',
      systemRole: 'USER',
      mustChangePassword: true,
    });
    expect(temporaryPassword.length).toBeGreaterThanOrEqual(12);

    const sid = await login(app, 'new.person@example.org', temporaryPassword);
    expect(codeOf(await call(app, 'GET', '/api/v1/admin/users', { sid }))).toBe(
      ErrorCode.PASSWORD_CHANGE_REQUIRED,
    );

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: AuditAction.USER_CREATED },
    });
    expect(audit.actorId).toBe(adminId);
    expect(JSON.stringify(audit.meta)).not.toContain(temporaryPassword);
  });

  it('rejects duplicate emails case-insensitively, invalid emails and unknown fields', async () => {
    await seedUser(prisma, { email: 'taken@example.org' });
    const dup = await call(app, 'POST', '/api/v1/admin/users', {
      sid: adminSid,
      body: { email: 'TAKEN@example.org', displayName: 'Dup' },
    });
    expect(dup.statusCode).toBe(409);
    expect(codeOf(dup)).toBe(ErrorCode.CONFLICT);

    const invalid = await call(app, 'POST', '/api/v1/admin/users', {
      sid: adminSid,
      body: { email: 'not-an-email', displayName: 'Bad' },
    });
    expect(invalid.statusCode).toBe(400);

    const smuggled = await call(app, 'POST', '/api/v1/admin/users', {
      sid: adminSid,
      body: { email: 'ok@example.org', displayName: 'Ok', passwordHash: 'x' },
    });
    expect(smuggled.statusCode).toBe(400);
  });

  it('rejects explicit nulls with 400 instead of failing in the database', async () => {
    const target = await seedUser(prisma, { email: 'target@example.org' });
    for (const body of [{ systemRole: null }, { isActive: null }, { displayName: null }]) {
      const res = await call(app, 'PATCH', `/api/v1/admin/users/${target.id}`, {
        sid: adminSid,
        body,
      });
      expect(res.statusCode).toBe(400);
      expect(codeOf(res)).toBe(ErrorCode.VALIDATION_FAILED);
    }
  });

  it('accepts internal email domains without a TLD', async () => {
    const res = await call(app, 'POST', '/api/v1/admin/users', {
      sid: adminSid,
      body: { email: 'someone@intranet', displayName: 'Someone' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('lists users with search and cursor pagination', async () => {
    for (const name of ['ann', 'bob', 'cat']) {
      await seedUser(prisma, { email: `${name}@example.org` });
    }
    const first = await call(app, 'GET', '/api/v1/admin/users?limit=2', { sid: adminSid });
    const page1 = first.json() as Page<UserDto>;
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const second = await call(
      app,
      'GET',
      `/api/v1/admin/users?limit=2&cursor=${page1.nextCursor ?? ''}`,
      { sid: adminSid },
    );
    const page2 = second.json() as Page<UserDto>;
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    const ids = [...page1.items, ...page2.items].map((u) => u.id);
    expect(new Set(ids).size).toBe(4);

    const search = await call(app, 'GET', '/api/v1/admin/users?q=BOB', { sid: adminSid });
    expect((search.json() as Page<UserDto>).items.map((u) => u.email)).toEqual(['bob@example.org']);
    expect(JSON.stringify(first.json())).not.toContain('passwordHash');
  });

  it('returns 404 for an unknown id and 400 for a malformed one', async () => {
    const unknown = await call(
      app,
      'GET',
      '/api/v1/admin/users/00000000-0000-4000-8000-000000000000',
      { sid: adminSid },
    );
    expect(unknown.statusCode).toBe(404);
    const malformed = await call(app, 'GET', '/api/v1/admin/users/abc', { sid: adminSid });
    expect(malformed.statusCode).toBe(400);
  });

  it('deactivation ends sessions and blocks login; reactivation restores access', async () => {
    const target = await seedUser(prisma, { email: 'target@example.org' });
    const targetSid = await login(app, 'target@example.org');

    const off = await call(app, 'PATCH', `/api/v1/admin/users/${target.id}`, {
      sid: adminSid,
      body: { isActive: false },
    });
    expect(off.statusCode).toBe(200);
    expect((await call(app, 'GET', '/api/v1/me', { sid: targetSid })).statusCode).toBe(401);
    await expect(login(app, 'target@example.org')).rejects.toThrow(/401/);

    await call(app, 'PATCH', `/api/v1/admin/users/${target.id}`, {
      sid: adminSid,
      body: { isActive: true },
    });
    await expect(login(app, 'target@example.org')).resolves.toEqual(expect.any(String));
  });

  it('never leaves the system without an active admin', async () => {
    const demoteSelf = await call(app, 'PATCH', `/api/v1/admin/users/${adminId}`, {
      sid: adminSid,
      body: { systemRole: 'USER' },
    });
    expect(demoteSelf.statusCode).toBe(409);
    expect(codeOf(demoteSelf)).toBe(ErrorCode.LAST_ADMIN);

    const deactivateSelf = await call(app, 'PATCH', `/api/v1/admin/users/${adminId}`, {
      sid: adminSid,
      body: { isActive: false },
    });
    expect(codeOf(deactivateSelf)).toBe(ErrorCode.LAST_ADMIN);

    // With a second admin, the first may step down.
    const other = await seedUser(prisma, { email: 'other@example.org' });
    const promote = await call(app, 'PATCH', `/api/v1/admin/users/${other.id}`, {
      sid: adminSid,
      body: { systemRole: 'ADMIN' },
    });
    expect((promote.json() as UserDto).systemRole).toBe('ADMIN');
    const stepDown = await call(app, 'PATCH', `/api/v1/admin/users/${adminId}`, {
      sid: adminSid,
      body: { systemRole: 'USER' },
    });
    expect(stepDown.statusCode).toBe(200);
    // The demoted admin's next admin request is refused.
    expect((await call(app, 'GET', '/api/v1/admin/users', { sid: adminSid })).statusCode).toBe(403);
  });

  it('reset password ends sessions, clears lockout and issues a working temporary password', async () => {
    const target = await seedUser(prisma, { email: 'target@example.org' });
    const targetSid = await login(app, 'target@example.org');
    await prisma.user.update({
      where: { id: target.id },
      data: { lockedUntil: new Date(Date.now() + 600_000), failedLoginCount: 3 },
    });

    const res = await call(app, 'POST', `/api/v1/admin/users/${target.id}/reset-password`, {
      sid: adminSid,
    });
    expect(res.statusCode).toBe(200);
    const { temporaryPassword, user } = res.json() as TemporaryPasswordResponse;
    expect(user.mustChangePassword).toBe(true);
    expect((await call(app, 'GET', '/api/v1/me', { sid: targetSid })).statusCode).toBe(401);
    await expect(login(app, 'target@example.org', temporaryPassword)).resolves.toEqual(
      expect.any(String),
    );
  });

  it('refuses an admin resetting their own password', async () => {
    const res = await call(app, 'POST', `/api/v1/admin/users/${adminId}/reset-password`, {
      sid: adminSid,
    });
    expect(res.statusCode).toBe(400);
  });
});
