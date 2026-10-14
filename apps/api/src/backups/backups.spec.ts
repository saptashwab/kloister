import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { AuditAction, BackupTrigger, ErrorCode } from '@kloister/shared';
import { fakeAudit, fakePrisma, makeConfig, makeUser } from '../../test/support/fakes.js';
import type { AuthContext } from '../auth/auth-context.js';
import { ApiException } from '../common/api-exception.js';
import { LogFiles } from '../logging/log-files.js';
import { SettingsService } from '../settings/settings.service.js';
import { BackupsService, nextDailyRun } from './backups.service.js';
import {
  backupFileName,
  backupFileTime,
  type CommandRunner,
  type DumpResult,
  pgDumpArgs,
  pgDumpEnvironment,
} from './pg-dump.js';

const URL_WITH_PASSWORD = 'postgresql://kloister:s3cr%40t@db.internal:5433/kloister?schema=public';

describe('pg_dump command (SPEC §9.1)', () => {
  it('uses the custom format, never prompts, and puts no credentials on the command line', () => {
    const args = pgDumpArgs('/app/x/backups/postgres/x-20261014-020000.dump.partial');
    expect(args).toEqual([
      '--format=custom',
      '--no-password',
      '--file=/app/x/backups/postgres/x-20261014-020000.dump.partial',
    ]);
    expect(args.join(' ')).not.toContain('s3cr');
  });

  it('passes the connection through libpq variables, the password only without a .pgpass file', () => {
    const env = pgDumpEnvironment(URL_WITH_PASSWORD, {
      PATH: '/usr/bin',
      DATABASE_URL: URL_WITH_PASSWORD,
      SECRET_THING: 'x',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      PGHOST: 'db.internal',
      PGPORT: '5433',
      PGUSER: 'kloister',
      PGDATABASE: 'kloister',
      PGPASSWORD: 's3cr@t',
    });
    const withPassFile = pgDumpEnvironment(URL_WITH_PASSWORD, {
      PGPASSFILE: '/app/x/config/.pgpass',
    });
    expect(withPassFile['PGPASSFILE']).toBe('/app/x/config/.pgpass');
    expect(withPassFile['PGPASSWORD']).toBeUndefined();
  });

  it('passes IPv6 hosts without brackets and the SSL certificate settings', () => {
    const env = pgDumpEnvironment(
      'postgresql://app@[::1]:5432/appdb?sslmode=verify-full&sslrootcert=/etc/ca.pem&sslcert=/c.pem&sslkey=/k.pem',
      {},
    );
    expect(env).toMatchObject({
      PGHOST: '::1',
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: '/etc/ca.pem',
      PGSSLCERT: '/c.pem',
      PGSSLKEY: '/k.pem',
    });
  });

  it('reads socket hosts and the SSL mode from the URL', () => {
    const env = pgDumpEnvironment(
      'postgresql://app@localhost/appdb?host=/var/run/postgresql&sslmode=disable',
      {},
    );
    expect(env).toEqual({
      PGHOST: '/var/run/postgresql',
      PGUSER: 'app',
      PGDATABASE: 'appdb',
      PGSSLMODE: 'disable',
    });
  });

  it('names files <app_name>-<yyyymmdd-hhmmss>.dump and reads the time back', () => {
    const at = new Date(2026, 9, 4, 2, 3, 9);
    expect(backupFileName('tracker', at)).toBe('tracker-20261004-020309.dump');
    expect(backupFileName('', at)).toBe('backup-20261004-020309.dump');
    expect(backupFileTime('tracker-20261004-020309.dump', 'tracker')).toEqual(at);
    expect(backupFileTime('other-20261004-020309.dump', 'tracker')).toBeNull();
    expect(backupFileTime('tracker-20261004-020309.dump.partial', 'tracker')).toBeNull();
    expect(backupFileTime('tracker-2026.dump', 'tracker')).toBeNull();
  });

  it('finds the next daily run', () => {
    const now = new Date(2026, 9, 14, 1, 30);
    expect(nextDailyRun('02:00', now)).toEqual(new Date(2026, 9, 14, 2, 0));
    expect(nextDailyRun('01:30', now)).toEqual(new Date(2026, 9, 15, 1, 30));
  });
});

describe('BackupsService', () => {
  const admin: AuthContext = { user: makeUser({ systemRole: 'ADMIN' }), sessionId: 's1' };
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kloister-backups-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Builds the service with a fake pg_dump.
   *
   * @param dump What the fake pg_dump does; by default it writes the file.
   * @param stored Stored backup settings.
   * @returns The service, the fake runner and the audit entries written.
   */
  function build(
    dump?: (args: readonly string[]) => Promise<DumpResult>,
    stored: object = { enabled: true, time: '02:00', retentionDays: 7 },
  ) {
    const { fake, prisma } = fakePrisma();
    fake.appSetting.findUnique.mockResolvedValue({ value: stored });
    const entries: { action: string; actorId: string | null; meta: Record<string, unknown> }[] = [];
    const auditLog = fake.auditLog;
    auditLog.create.mockImplementation((args: unknown) => {
      const data = (args as { data: (typeof entries)[number] }).data;
      entries.push(data);
      return Promise.resolve({ id: `a${entries.length}`, ...data });
    });
    const run = jest.fn<CommandRunner>(
      (_command, args) =>
        dump?.(args) ??
        writeFile((args[2] ?? '').replace('--file=', ''), Buffer.alloc(2048)).then(() => ({
          code: 0,
          stderr: '',
        })),
    );
    const config = makeConfig({
      backupsDir: dir,
      appName: 'tracker',
      pgDumpPath: '/usr/pgsql-18/bin/pg_dump',
      databaseUrl: URL_WITH_PASSWORD,
    });
    const audit = fakeAudit();
    const service = new BackupsService(
      prisma,
      new SettingsService(prisma),
      audit.service,
      config,
      new LogFiles(config),
      run,
    );
    return { service, run, entries, audit: audit.records, auditLog };
  }

  it('dumps into a partial file, renames it and audits the result', async () => {
    const { service, run, entries } = build();
    const result = await service.run(BackupTrigger.SCHEDULED, null);
    expect(run).toHaveBeenCalledTimes(1);
    const [command, args, env] = run.mock.calls[0] ?? [];
    expect(command).toBe('/usr/pgsql-18/bin/pg_dump');
    expect(args?.[2]).toMatch(/--file=.*tracker-\d{8}-\d{6}\.dump\.partial$/);
    expect(env).toMatchObject({ PGDATABASE: 'kloister', PGPASSWORD: 's3cr@t' });
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^tracker-\d{8}-\d{6}\.dump$/);
    expect(result).toMatchObject({
      succeeded: true,
      trigger: BackupTrigger.SCHEDULED,
      file: files[0],
      sizeBytes: 2048,
      error: null,
      pruned: 0,
    });
    expect(entries).toEqual([
      expect.objectContaining({ action: AuditAction.BACKUP_SUCCEEDED, actorId: null }),
    ]);
    expect(service.isRunning()).toBe(false);
  });

  it('records a failure with pg_dump error output and leaves no partial file behind', async () => {
    const { service, entries } = build(async (args) => {
      await writeFile((args[2] ?? '').replace('--file=', ''), 'half');
      return { code: 1, stderr: 'pg_dump: error: connection to server failed' };
    });
    const result = await service.run(BackupTrigger.MANUAL, admin.user.id);
    expect(result).toMatchObject({
      succeeded: false,
      trigger: BackupTrigger.MANUAL,
      file: null,
      error: 'pg_dump exited with code 1: pg_dump: error: connection to server failed',
    });
    expect(await readdir(dir)).toEqual([]);
    expect(entries[0]).toMatchObject({ action: AuditAction.BACKUP_FAILED, actorId: admin.user.id });
  });

  it('records a pg_dump that cannot start, such as a wrong PG_DUMP_PATH', async () => {
    const { service } = build(() => Promise.reject(new Error('spawn pg_dump ENOENT')));
    await expect(service.run(BackupTrigger.SCHEDULED, null)).resolves.toMatchObject({
      succeeded: false,
      error: 'spawn pg_dump ENOENT',
    });
  });

  it('deletes only this app’s backups older than the retention after a success', async () => {
    const old = backupFileName('tracker', new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
    const recent = backupFileName('tracker', new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
    const foreign = backupFileName('other', new Date(2020, 0, 1));
    for (const name of [old, recent, foreign, 'notes.txt']) await writeFile(join(dir, name), 'x');
    const { service } = build();
    const result = await service.run(BackupTrigger.SCHEDULED, null);
    expect(result?.pruned).toBe(1);
    const left = await readdir(dir);
    expect(left).not.toContain(old);
    expect(left).toEqual(expect.arrayContaining([recent, foreign, 'notes.txt', result?.file]));
  });

  it('starts the scheduled backup once, at the set minute, only when enabled', async () => {
    const { service, run } = build();
    await expect(service.tick(new Date(2026, 9, 14, 1, 59))).resolves.toBe(false);
    await expect(service.tick(new Date(2026, 9, 14, 2, 0, 0))).resolves.toBe(true);
    await expect(service.tick(new Date(2026, 9, 14, 2, 0, 30))).resolves.toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    const disabled = build(undefined, { enabled: false, time: '02:00', retentionDays: 7 });
    await expect(disabled.service.tick(new Date(2026, 9, 14, 2, 0))).resolves.toBe(false);
  });

  it('refuses "run now" while a backup runs, and audits the request', async () => {
    let finish: (r: DumpResult) => void = () => undefined;
    const { service, audit, auditLog, run } = build(
      () =>
        new Promise<DumpResult>((resolve) => {
          finish = resolve;
        }),
    );
    auditLog.findMany.mockResolvedValue([]);
    const status = await service.requestRun(admin);
    expect(status.running).toBe(true);
    expect(audit).toEqual([
      expect.objectContaining({ action: AuditAction.BACKUP_REQUESTED, actorId: admin.user.id }),
    ]);
    const second = await service.requestRun(admin).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(ApiException);
    expect(((second as ApiException).getResponse() as { code: string }).code).toBe(
      ErrorCode.BACKUP_RUNNING,
    );
    // pg_dump starts once its folder exists.
    for (let i = 0; i < 100 && run.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    finish({ code: 1, stderr: 'stopped' });
    for (let i = 0; i < 100 && service.isRunning(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(service.isRunning()).toBe(false);
  });

  it('lists the last results from the audit log and the files, newest first', async () => {
    await writeFile(join(dir, 'tracker-20261012-020000.dump'), 'aa');
    await writeFile(join(dir, 'tracker-20261013-020000.dump'), 'aaa');
    await writeFile(join(dir, 'tracker-20261013-020000.dump.partial'), 'a');
    const { service, auditLog } = build();
    auditLog.findMany.mockResolvedValue([
      {
        id: 'e2',
        action: AuditAction.BACKUP_FAILED,
        meta: { trigger: 'MANUAL', startedAt: 's', finishedAt: 'f', error: 'boom' },
      },
      {
        id: 'e1',
        action: AuditAction.BACKUP_SUCCEEDED,
        meta: {
          trigger: 'SCHEDULED',
          startedAt: 's',
          finishedAt: 'f',
          file: 'tracker-20261013-020000.dump',
          sizeBytes: 3,
          pruned: ['a', 'b'],
        },
      },
    ]);
    const status = await service.status(new Date(2026, 9, 14, 12));
    expect(status.nextRunAt).toBe(new Date(2026, 9, 15, 2).toISOString());
    expect(status.folder).toBe(dir);
    expect(status.files.map((f) => [f.name, f.sizeBytes])).toEqual([
      ['tracker-20261013-020000.dump', 3],
      ['tracker-20261012-020000.dump', 2],
    ]);
    expect(status.runs).toEqual([
      expect.objectContaining({ id: 'e2', succeeded: false, error: 'boom', trigger: 'MANUAL' }),
      expect.objectContaining({ id: 'e1', succeeded: true, sizeBytes: 3, pruned: 2 }),
    ]);
  });
});
