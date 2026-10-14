import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditAction, ErrorCode, ThemeMode } from '@kloister/shared';
import { fakeAudit, fakePrisma, makeConfig, makeUser } from '../../test/support/fakes.js';
import type { AuthContext } from '../auth/auth-context.js';
import { ApiException } from '../common/api-exception.js';
import { AdminSettingsService } from './admin-settings.service.js';
import { folderUsage } from './disk-usage.js';
import { SettingsService } from './settings.service.js';

const admin: AuthContext = { user: makeUser({ systemRole: 'ADMIN' }), sessionId: 's1' };

/**
 * Builds the service over fakes.
 *
 * @param config Folder overrides.
 * @returns The service, the fake Prisma and the captured audit records.
 */
function build(config: Parameters<typeof makeConfig>[0] = {}) {
  const { fake, prisma } = fakePrisma();
  fake.appSetting.upsert.mockResolvedValue({});
  const audit = fakeAudit();
  const service = new AdminSettingsService(
    prisma,
    new SettingsService(prisma),
    audit.service,
    makeConfig(config),
  );
  return { fake, service, records: audit.records };
}

/**
 * Expects a 400 naming a field.
 *
 * @param promise The call.
 * @param field The field.
 * @returns Resolves once checked.
 */
async function expectInvalid(promise: Promise<unknown>, field: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiException);
  const body = (error as ApiException).getResponse() as { code: string; details?: unknown };
  expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
  expect(JSON.stringify(body.details)).toContain(field);
}

describe('AdminSettingsService', () => {
  it('saves security settings and audits the new value', async () => {
    const { fake, service, records } = build();
    const value = {
      idleTimeoutMinutes: 60,
      absoluteTimeoutMinutes: 1440,
      lockoutThreshold: 3,
      lockoutMinutes: 30,
    };
    await expect(service.saveSecurity(admin, value)).resolves.toEqual(value);
    expect(fake.appSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'security' }, update: { value } }),
    );
    expect(records).toEqual([
      expect.objectContaining({
        action: AuditAction.SETTINGS_UPDATED,
        actorId: admin.user.id,
        meta: { key: 'security', value },
      }),
    ]);
  });

  it('refuses an absolute timeout shorter than the idle timeout', async () => {
    const { fake, service, records } = build();
    await expectInvalid(
      service.saveSecurity(admin, {
        idleTimeoutMinutes: 600,
        absoluteTimeoutMinutes: 60,
        lockoutThreshold: 5,
        lockoutMinutes: 15,
      }),
      'absoluteTimeoutMinutes',
    );
    expect(fake.appSetting.upsert).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);
  });

  it('refuses a project quota smaller than the file size limit', async () => {
    const { service } = build();
    await expectInvalid(
      service.saveStorage(admin, { maxFileSizeMb: 100, projectQuotaMb: 50 }),
      'projectQuotaMb',
    );
    await expect(
      service.saveStorage(admin, { maxFileSizeMb: 10, projectQuotaMb: 10 }),
    ).resolves.toEqual({ maxFileSizeMb: 10, projectQuotaMb: 10 });
  });

  it('saves the log retention and the default theme with upper-case colours', async () => {
    const { service, records } = build();
    await expect(service.saveLogs(admin, { retentionDays: 90 })).resolves.toEqual({
      retentionDays: 90,
    });
    await expect(
      service.saveTheme(admin, { mode: ThemeMode.DARK, primary: '#0f766e', accent: '#c2410c' }),
    ).resolves.toEqual({ mode: ThemeMode.DARK, primary: '#0F766E', accent: '#C2410C' });
    expect(records.map((r) => (r.meta as { key: string }).key)).toEqual(['logs', 'theme']);
  });

  describe('disk usage', () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'kloister-usage-'));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('adds up the app folder and its attachments, backups and logs folders', async () => {
      await mkdir(join(root, 'data', 'attachments', 'p1'), { recursive: true });
      await mkdir(join(root, 'backups', 'postgres'), { recursive: true });
      await mkdir(join(root, 'logs', 'backend'), { recursive: true });
      await writeFile(join(root, 'data', 'attachments', 'p1', 'a'), Buffer.alloc(100));
      await writeFile(join(root, 'data', 'attachments', 'p1', 'b'), Buffer.alloc(50));
      await writeFile(join(root, 'backups', 'postgres', 'x.dump'), Buffer.alloc(1000));
      await writeFile(join(root, 'logs', 'backend', 'backend-2026-10-14.log'), 'line\n');
      await writeFile(join(root, 'readme'), 'hi');
      const { service } = build({
        appDir: root,
        attachmentsDir: join(root, 'data', 'attachments'),
        backupsDir: join(root, 'backups', 'postgres'),
        logDir: join(root, 'logs'),
      });
      const usage = await service.diskUsage();
      expect(usage.attachments).toEqual({
        path: join(root, 'data', 'attachments'),
        bytes: 150,
        files: 2,
      });
      expect(usage.backups.bytes).toBe(1000);
      expect(usage.logs).toMatchObject({ bytes: 5, files: 1 });
      expect(usage.app).toMatchObject({ bytes: 1157, files: 5 });
      expect(usage.disk?.totalBytes).toBeGreaterThan(0);
    });

    it('counts a missing folder as empty and never follows symbolic links', async () => {
      await expect(folderUsage(join(root, 'missing'))).resolves.toEqual({
        path: join(root, 'missing'),
        bytes: 0,
        files: 0,
      });
      const outside = await mkdtemp(join(tmpdir(), 'kloister-outside-'));
      await writeFile(join(outside, 'big'), Buffer.alloc(5000));
      try {
        await symlink(outside, join(root, 'link'), 'junction');
      } catch {
        // Creating links may need extra rights on some systems; nothing to test then.
        await rm(outside, { recursive: true, force: true });
        return;
      }
      const usage = await folderUsage(root);
      expect(usage.bytes).toBeLessThan(5000);
      await rm(outside, { recursive: true, force: true });
    });
  });
});
