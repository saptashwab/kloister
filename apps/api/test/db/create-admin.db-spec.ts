import { jest } from '@jest/globals';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AuditAction } from '@kloister/shared';
import { runCreateAdmin } from '../../src/cli/create-admin.command.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { call, login, resetDb, startApp } from './support.js';

describe('create-admin command (db)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let output: string[];

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    output = [];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.join(' '));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates the first admin once and is a no-op on re-run', async () => {
    await expect(
      runCreateAdmin(['--email', 'Root@Example.org', '--name', 'Root Admin']),
    ).resolves.toBe(0);
    const line = output.find((l) => l.startsWith('Temporary password'));
    const temporaryPassword = line?.split(': ').at(-1) ?? '';
    expect(temporaryPassword.length).toBeGreaterThanOrEqual(12);

    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'root@example.org' } });
    expect(admin).toMatchObject({ systemRole: 'ADMIN', mustChangePassword: true });
    expect(admin.passwordHash).not.toContain(temporaryPassword);
    expect(await prisma.auditLog.count({ where: { action: AuditAction.ADMIN_BOOTSTRAPPED } })).toBe(
      1,
    );

    // Re-running (e.g. install.sh again) changes nothing.
    output = [];
    await expect(
      runCreateAdmin(['--email', 'second@example.org', '--name', 'Second']),
    ).resolves.toBe(0);
    expect(output.join('\n')).toContain('already exists');
    expect(await prisma.user.count()).toBe(1);

    // The printed password signs in, landing in the forced change state.
    const sid = await login(app, 'root@example.org', temporaryPassword);
    const me = await call(app, 'GET', '/api/v1/me', { sid });
    expect(me.json()).toMatchObject({ mustChangePassword: true, systemRole: 'ADMIN' });
  });
});
