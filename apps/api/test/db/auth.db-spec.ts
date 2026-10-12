import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AuditAction, ErrorCode, type UserDto } from '@kloister/shared';
import { SECURITY_SETTINGS_KEY } from '../../src/settings/settings.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  PASSWORD,
  TEST_APP_NAME,
  call,
  codeOf,
  login,
  resetDb,
  seedUser,
  startApp,
} from './support.js';

describe('auth flows (db)', () => {
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

  it('signs in, sets a hardened cookie and serves /me', async () => {
    await seedUser(prisma, { email: 'alice@example.org' });
    const res = await call(app, 'POST', '/api/v1/auth/login', {
      body: { email: 'ALICE@example.org', password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as UserDto).email).toBe('alice@example.org');
    expect(JSON.stringify(res.json())).not.toContain('passwordHash');

    const cookie = res.cookies.find((c) => c.name === 'sid');
    expect(cookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: `/${TEST_APP_NAME}/`,
    });

    const me = await call(app, 'GET', '/api/v1/me', { sid: cookie?.value });
    expect(me.statusCode).toBe(200);
    expect((me.json() as UserDto).email).toBe('alice@example.org');

    const stored = await prisma.session.findFirst();
    expect(stored?.tokenHash).not.toBe(cookie?.value);
  });

  it('records successful and failed logins in the audit log', async () => {
    await seedUser(prisma, { email: 'alice@example.org' });
    await call(app, 'POST', '/api/v1/auth/login', {
      body: { email: 'alice@example.org', password: 'wrong-password' },
    });
    await login(app, 'alice@example.org');
    const actions = (await prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).map(
      (e) => e.action,
    );
    expect(actions).toEqual([AuditAction.LOGIN_FAILED, AuditAction.LOGIN_SUCCEEDED]);
  });

  it('gives the same error for unknown, wrong-password and deactivated accounts', async () => {
    await seedUser(prisma, { email: 'alice@example.org' });
    await seedUser(prisma, { email: 'gone@example.org', isActive: false });
    const attempts = [
      { email: 'nobody@example.org', password: PASSWORD },
      { email: 'alice@example.org', password: 'wrong-password' },
      { email: 'gone@example.org', password: PASSWORD },
    ];
    for (const body of attempts) {
      const res = await call(app, 'POST', '/api/v1/auth/login', { body });
      expect(res.statusCode).toBe(401);
      expect(codeOf(res)).toBe(ErrorCode.INVALID_CREDENTIALS);
    }
  });

  it('locks the account after 5 failures, even for the right password', async () => {
    await seedUser(prisma, { email: 'alice@example.org' });
    for (let i = 0; i < 5; i++) {
      await call(app, 'POST', '/api/v1/auth/login', {
        body: { email: 'alice@example.org', password: 'wrong-password' },
      });
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'alice@example.org' } });
    expect(user.lockedUntil?.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);

    const res = await call(app, 'POST', '/api/v1/auth/login', {
      body: { email: 'alice@example.org', password: PASSWORD },
    });
    expect(res.statusCode).toBe(401);
    expect(await prisma.auditLog.count({ where: { action: AuditAction.ACCOUNT_LOCKED } })).toBe(1);

    // Once the lock has expired the right password works again.
    await prisma.user.update({
      where: { id: user.id },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });
    await expect(login(app, 'alice@example.org')).resolves.toEqual(expect.any(String));
  });

  it('honours an admin-configured lockout threshold', async () => {
    await prisma.appSetting.create({
      data: { key: SECURITY_SETTINGS_KEY, value: { lockoutThreshold: 2 } },
    });
    await seedUser(prisma, { email: 'alice@example.org' });
    for (let i = 0; i < 2; i++) {
      await call(app, 'POST', '/api/v1/auth/login', {
        body: { email: 'alice@example.org', password: 'wrong-password' },
      });
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'alice@example.org' } });
    expect(user.lockedUntil).not.toBeNull();
  });

  it('logs out and rejects the old cookie', async () => {
    await seedUser(prisma, { email: 'alice@example.org' });
    const sid = await login(app, 'alice@example.org');
    const out = await call(app, 'POST', '/api/v1/auth/logout', { sid });
    expect(out.statusCode).toBe(204);
    expect(out.cookies.find((c) => c.name === 'sid')?.value).toBe('');
    expect((await call(app, 'GET', '/api/v1/me', { sid })).statusCode).toBe(401);
  });

  it('ends idle sessions', async () => {
    await prisma.appSetting.create({
      data: { key: SECURITY_SETTINGS_KEY, value: { idleTimeoutMinutes: 1 } },
    });
    await seedUser(prisma, { email: 'alice@example.org' });
    const sid = await login(app, 'alice@example.org');
    await prisma.session.updateMany({ data: { lastSeenAt: new Date(Date.now() - 2 * 60_000) } });
    expect((await call(app, 'GET', '/api/v1/me', { sid })).statusCode).toBe(401);
    expect(await prisma.session.count()).toBe(0);
  });

  it('ends sessions past their absolute expiry', async () => {
    await seedUser(prisma, { email: 'alice@example.org' });
    const sid = await login(app, 'alice@example.org');
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call(app, 'GET', '/api/v1/me', { sid })).statusCode).toBe(401);
  });

  describe('pending password change', () => {
    it('allows only /me, logout and change-password until the password is changed', async () => {
      await seedUser(prisma, {
        email: 'admin@example.org',
        systemRole: 'ADMIN',
        mustChangePassword: true,
      });
      const sid = await login(app, 'admin@example.org');

      expect((await call(app, 'GET', '/api/v1/me', { sid })).statusCode).toBe(200);
      for (const [method, url] of [
        ['GET', '/api/v1/admin/users'],
        ['GET', '/api/v1/admin/audit'],
        ['PATCH', '/api/v1/me'],
      ] as const) {
        const res = await call(app, method, url, { sid, body: {} });
        expect(res.statusCode).toBe(403);
        expect(codeOf(res)).toBe(ErrorCode.PASSWORD_CHANGE_REQUIRED);
      }

      const changed = await call(app, 'POST', '/api/v1/auth/change-password', {
        sid,
        body: { currentPassword: PASSWORD, newPassword: 'brand-new-password' },
      });
      expect(changed.statusCode).toBe(200);
      expect((changed.json() as UserDto).mustChangePassword).toBe(false);
      expect((await call(app, 'GET', '/api/v1/admin/users', { sid })).statusCode).toBe(200);
    });
  });

  describe('change password', () => {
    it('ends other sessions, keeps the current one, and accepts only the new password', async () => {
      await seedUser(prisma, { email: 'alice@example.org' });
      const current = await login(app, 'alice@example.org');
      const other = await login(app, 'alice@example.org');

      const res = await call(app, 'POST', '/api/v1/auth/change-password', {
        sid: current,
        body: { currentPassword: PASSWORD, newPassword: 'brand-new-password' },
      });
      expect(res.statusCode).toBe(200);
      expect((await call(app, 'GET', '/api/v1/me', { sid: current })).statusCode).toBe(200);
      expect((await call(app, 'GET', '/api/v1/me', { sid: other })).statusCode).toBe(401);
      await expect(login(app, 'alice@example.org')).rejects.toThrow(/401/);
      await expect(login(app, 'alice@example.org', 'brand-new-password')).resolves.toEqual(
        expect.any(String),
      );
    });

    it('rejects a wrong current password and a too-short new one', async () => {
      await seedUser(prisma, { email: 'alice@example.org' });
      const sid = await login(app, 'alice@example.org');
      const wrong = await call(app, 'POST', '/api/v1/auth/change-password', {
        sid,
        body: { currentPassword: 'not-it-at-all', newPassword: 'brand-new-password' },
      });
      expect(wrong.statusCode).toBe(400);
      expect(codeOf(wrong)).toBe(ErrorCode.INVALID_CREDENTIALS);
      const short = await call(app, 'POST', '/api/v1/auth/change-password', {
        sid,
        body: { currentPassword: PASSWORD, newPassword: 'short' },
      });
      expect(short.statusCode).toBe(400);
      expect(codeOf(short)).toBe(ErrorCode.VALIDATION_FAILED);
    });
  });

  it('lets any user update their own display name', async () => {
    await seedUser(prisma, { email: 'alice@example.org' });
    const sid = await login(app, 'alice@example.org');
    const res = await call(app, 'PATCH', '/api/v1/me', {
      sid,
      body: { displayName: '  Alice A ' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as UserDto).displayName).toBe('Alice A');
    const denied = await call(app, 'PATCH', '/api/v1/me', { sid, body: { systemRole: 'ADMIN' } });
    expect(denied.statusCode).toBe(400);
  });

  it('serves /health without a session', async () => {
    expect((await call(app, 'GET', '/api/v1/health')).statusCode).toBe(200);
  });
});
