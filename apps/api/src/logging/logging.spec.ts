import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { fakePrisma, makeConfig } from '../../test/support/fakes.js';
import { SettingsService } from '../settings/settings.service.js';
import { DailyFileStream, localDate, pruneDailyFiles } from './daily-file.js';
import { LogFiles, PinoNestLogger } from './log-files.js';
import { LogRetentionJob } from './log-retention.job.js';

describe('logging (SPEC §2, §9.1)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kloister-logs-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes one file per server-local day and switches at midnight', async () => {
    let now = new Date(2026, 9, 14, 23, 59, 30);
    const stream = new DailyFileStream(join(dir, 'backend'), 'backend', () => now);
    stream.write('{"msg":"late"}\n');
    now = new Date(2026, 9, 15, 0, 0, 5);
    stream.write('{"msg":"early"}\n');
    stream.write('{"msg":"again"}\n');
    await stream.end();
    expect((await readdir(join(dir, 'backend'))).sort()).toEqual([
      'backend-2026-10-14.log',
      'backend-2026-10-15.log',
    ]);
    expect(await readFile(join(dir, 'backend', 'backend-2026-10-15.log'), 'utf8')).toBe(
      '{"msg":"early"}\n{"msg":"again"}\n',
    );
  });

  it('appends to the day file after a restart', async () => {
    const now = () => new Date(2026, 9, 14, 12);
    const first = new DailyFileStream(dir, 'backup', now);
    first.write('one\n');
    await first.end();
    const second = new DailyFileStream(dir, 'backup', now);
    second.write('two\n');
    await second.end();
    expect(await readFile(join(dir, 'backup-2026-10-14.log'), 'utf8')).toBe('one\ntwo\n');
  });

  it('formats local dates with leading zeros', () => {
    expect(localDate(new Date(2026, 0, 5, 1))).toBe('2026-01-05');
  });

  it('deletes only daily files older than the retention, by the date in their names', async () => {
    for (const name of [
      'backend-2026-10-01.log',
      'backend-2026-10-07.log',
      'backend-2026-10-08.log',
      'backend-2026-10-14.log',
      'backend-latest.log',
      'other-2026-01-01.log',
      'backend-2026-01-01.log.gz',
    ]) {
      await writeFile(join(dir, name), 'x');
    }
    // Seven days kept: the 8th to the 14th.
    const deleted = await pruneDailyFiles(dir, 'backend', 7, new Date(2026, 9, 14, 3, 45));
    expect(deleted).toEqual(['backend-2026-10-01.log', 'backend-2026-10-07.log']);
    expect((await readdir(dir)).sort()).toEqual([
      'backend-2026-01-01.log.gz',
      'backend-2026-10-08.log',
      'backend-2026-10-14.log',
      'backend-latest.log',
      'other-2026-01-01.log',
    ]);
    await expect(pruneDailyFiles(join(dir, 'missing'), 'backend', 7)).resolves.toEqual([]);
  });

  it('the nightly job applies the admin retention to the backend and backup logs', async () => {
    await mkdir(join(dir, 'backend'));
    await mkdir(join(dir, 'backups'));
    await mkdir(join(dir, 'install'));
    await writeFile(join(dir, 'backend', 'backend-2026-09-01.log'), 'x');
    await writeFile(join(dir, 'backend', 'backend-2026-10-14.log'), 'x');
    await writeFile(join(dir, 'backups', 'backup-2026-09-01.log'), 'x');
    await writeFile(join(dir, 'install', 'install-20260901-120000.log'), 'x');
    const { fake, prisma } = fakePrisma();
    fake.appSetting.findUnique.mockResolvedValue({ value: { retentionDays: 30 } });
    const job = new LogRetentionJob(makeConfig({ logDir: dir }), new SettingsService(prisma));
    await expect(job.run(new Date(2026, 9, 14, 3, 45))).resolves.toEqual([
      'backend-2026-09-01.log',
      'backup-2026-09-01.log',
    ]);
    expect(await readdir(join(dir, 'install'))).toEqual(['install-20260901-120000.log']);
    // Without a log folder (development) there is nothing to clean.
    const devJob = new LogRetentionJob(makeConfig({ logDir: null }), new SettingsService(prisma));
    await expect(devJob.run()).resolves.toEqual([]);
  });

  it('opens the backend and backup logs as daily files under LOG_DIR', async () => {
    const files = new LogFiles(makeConfig({ logDir: dir, logLevel: 'info' }));
    files.backend.info('started');
    files.backups.info({ file: 'x.dump' }, 'Backup finished');
    await files.onApplicationShutdown();
    const today = localDate(new Date());
    const backend = await readFile(join(dir, 'backend', `backend-${today}.log`), 'utf8');
    expect(JSON.parse(backend)).toMatchObject({ level: 30, msg: 'started' });
    const backup = await readFile(join(dir, 'backups', `backup-${today}.log`), 'utf8');
    expect(JSON.parse(backup)).toMatchObject({ file: 'x.dump', msg: 'Backup finished' });
  });

  it('maps Nest logger calls to pino entries with their context and stack', () => {
    const lines: Record<string, unknown>[] = [];
    const logger = pino(
      { level: 'trace' },
      { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
    );
    const nest = new PinoNestLogger(logger);
    nest.log('Listening', 'NestApplication');
    nest.error('Boom', 'Error: Boom\n    at x', 'ExceptionsHandler');
    nest.warn({ event: 'odd' }, 'Jobs');
    nest.verbose('detail');
    nest.error(new Error('bad'));
    expect(lines[0]).toMatchObject({ level: 30, msg: 'Listening', context: 'NestApplication' });
    expect(lines[1]).toMatchObject({
      level: 50,
      msg: 'Boom',
      context: 'ExceptionsHandler',
      stack: 'Error: Boom\n    at x',
    });
    expect(lines[2]).toMatchObject({ level: 40, event: 'odd', context: 'Jobs' });
    expect(lines[3]).toMatchObject({ level: 10, msg: 'detail' });
    expect(lines[4]).toMatchObject({ level: 50, msg: 'bad', err: { message: 'bad' } });
  });
});
