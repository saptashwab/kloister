import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  AuditAction,
  type BackupsDto,
  type BrandingSettingsDto,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  type DiskUsageDto,
  ErrorCode,
  type MyThemeDto,
  type PublicBrandingDto,
  type SecuritySettingsDto,
  ThemeMode,
  UiFont,
} from '@kloister/shared';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  ATTACHMENTS_DIR,
  BACKUP_DIR,
  call,
  codeOf,
  FAKE_PG_DUMP_DIR,
  login,
  PASSWORD,
  resetDb,
  seedUser,
  startApp,
  upload,
} from './support.js';

// M6 admin settings against a real database: the admin and non-admin
// matrix of every admin route, security, storage and disk usage, logs, the
// default and personal themes, branding with logo and font files (public
// routes included), and backups through a fake pg_dump.

/** A minimal PNG head; the API checks types by content. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
const WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(32, 2)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');

const SECURITY: SecuritySettingsDto = {
  idleTimeoutMinutes: 60,
  absoluteTimeoutMinutes: 720,
  lockoutThreshold: 3,
  lockoutMinutes: 10,
};

describe('admin settings, branding, themes and backups (db)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let adminSid: string;
  let adminId: string;
  let userSid: string;

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = (await seedUser(prisma, { email: 'admin@example.org', systemRole: 'ADMIN' })).id;
    await seedUser(prisma, { email: 'user@example.org' });
    adminSid = await login(app, 'admin@example.org');
    userSid = await login(app, 'user@example.org');
  });

  /**
   * Waits until no backup is running.
   *
   * @returns The backups screen's data then.
   */
  async function backupsIdle(): Promise<BackupsDto> {
    for (let i = 0; i < 100; i++) {
      const status = (
        await call(app, 'GET', '/api/v1/admin/backups', { sid: adminSid })
      ).json() as BackupsDto;
      if (!status.running) return status;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('backup still running');
  }

  // Permission matrix: every admin route answers 403 to a signed-in
  // non-admin and changes nothing; admins may read every one.
  it('forbids every admin settings, branding and backup route to non-admins', async () => {
    const json = [
      ['GET', '/api/v1/admin/settings/security', undefined],
      ['PUT', '/api/v1/admin/settings/security', SECURITY],
      ['GET', '/api/v1/admin/settings/storage', undefined],
      ['PUT', '/api/v1/admin/settings/storage', { maxFileSizeMb: 1, projectQuotaMb: 1 }],
      ['GET', '/api/v1/admin/settings/storage/usage', undefined],
      ['GET', '/api/v1/admin/settings/logs', undefined],
      ['PUT', '/api/v1/admin/settings/logs', { retentionDays: 1 }],
      ['GET', '/api/v1/admin/settings/theme', undefined],
      [
        'PUT',
        '/api/v1/admin/settings/theme',
        { mode: 'DARK', primary: '#000000', accent: '#000000' },
      ],
      ['GET', '/api/v1/admin/settings/branding', undefined],
      ['PUT', '/api/v1/admin/settings/branding', { appName: 'Mine', font: 'ARIAL' }],
      ['DELETE', '/api/v1/admin/settings/branding/logo', undefined],
      ['DELETE', '/api/v1/admin/settings/branding/fonts/regular', undefined],
      ['DELETE', '/api/v1/admin/settings/branding/fonts/bold', undefined],
      ['GET', '/api/v1/admin/backups', undefined],
      [
        'PUT',
        '/api/v1/admin/backups/settings',
        { enabled: false, time: '01:00', retentionDays: 1 },
      ],
      ['POST', '/api/v1/admin/backups/run', undefined],
    ] as const;
    for (const [method, url, body] of json) {
      const res = await call(app, method, url, { sid: userSid, ...(body ? { body } : {}) });
      expect({ method, url, status: res.statusCode }).toEqual({ method, url, status: 403 });
      expect(codeOf(res)).toBe(ErrorCode.FORBIDDEN);
    }
    for (const url of [
      '/api/v1/admin/settings/branding/logo',
      '/api/v1/admin/settings/branding/fonts/regular',
      '/api/v1/admin/settings/branding/fonts/bold',
    ]) {
      const res = await upload(app, url, userSid, url.endsWith('logo') ? PNG : WOFF2, 'x', 'PUT');
      expect({ url, status: res.statusCode }).toEqual({ url, status: 403 });
    }
    expect(await prisma.appSetting.count()).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: {
          action: {
            in: [
              AuditAction.SETTINGS_UPDATED,
              AuditAction.BRANDING_FILE_UPLOADED,
              AuditAction.BRANDING_FILE_REMOVED,
              AuditAction.BACKUP_REQUESTED,
            ],
          },
        },
      }),
    ).toBe(0);

    for (const [method, url] of json) {
      if (method !== 'GET') continue;
      const res = await call(app, method, url, { sid: adminSid });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
    }
  });

  it('saves security settings, audits them and applies the lockout threshold', async () => {
    const res = await call(app, 'PUT', '/api/v1/admin/settings/security', {
      sid: adminSid,
      body: SECURITY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(SECURITY);
    expect(
      (await call(app, 'GET', '/api/v1/admin/settings/security', { sid: adminSid })).json(),
    ).toEqual(SECURITY);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: AuditAction.SETTINGS_UPDATED },
    });
    expect(audit).toMatchObject({ actorId: adminId, meta: { key: 'security', value: SECURITY } });

    // Three failures now lock the account.
    for (let i = 0; i < 3; i++) {
      await call(app, 'POST', '/api/v1/auth/login', {
        body: { email: 'user@example.org', password: 'wrong-password-123' },
      });
    }
    const locked = await call(app, 'POST', '/api/v1/auth/login', {
      body: { email: 'user@example.org', password: PASSWORD },
    });
    expect(locked.statusCode).toBe(401);
  });

  it('refuses security values out of range, inconsistent or unknown', async () => {
    const cases = [
      { ...SECURITY, idleTimeoutMinutes: 1 },
      { ...SECURITY, lockoutThreshold: 0 },
      { ...SECURITY, absoluteTimeoutMinutes: 30 },
      { ...SECURITY, extra: true },
      { idleTimeoutMinutes: 60 },
    ];
    for (const body of cases) {
      const res = await call(app, 'PUT', '/api/v1/admin/settings/security', {
        sid: adminSid,
        body,
      });
      expect({ body, status: res.statusCode }).toEqual({ body, status: 400 });
    }
    expect(await prisma.appSetting.count()).toBe(0);
  });

  it('saves storage limits, which uploads then follow, and reports disk usage', async () => {
    const bad = await call(app, 'PUT', '/api/v1/admin/settings/storage', {
      sid: adminSid,
      body: { maxFileSizeMb: 10, projectQuotaMb: 5 },
    });
    expect(bad.statusCode).toBe(400);
    const res = await call(app, 'PUT', '/api/v1/admin/settings/storage', {
      sid: adminSid,
      body: { maxFileSizeMb: 1, projectQuotaMb: 3 },
    });
    expect(res.json()).toEqual({ maxFileSizeMb: 1, projectQuotaMb: 3 });

    await writeFile(join(BACKUP_DIR, 'kloister-test-20260101-020000.dump'), Buffer.alloc(300));
    const usage = (
      await call(app, 'GET', '/api/v1/admin/settings/storage/usage', { sid: adminSid })
    ).json() as DiskUsageDto;
    expect(usage.attachments.path).toBe(ATTACHMENTS_DIR);
    expect(usage.backups.path).toBe(BACKUP_DIR);
    expect(usage.backups.bytes).toBeGreaterThanOrEqual(300);
    expect(usage.app.bytes).toBeGreaterThan(0);
    expect(usage.disk === null || usage.disk.totalBytes > 0).toBe(true);
    await rm(join(BACKUP_DIR, 'kloister-test-20260101-020000.dump'), { force: true });
  });

  it('saves the log retention within its range', async () => {
    expect(
      (await call(app, 'GET', '/api/v1/admin/settings/logs', { sid: adminSid })).json(),
    ).toEqual({ retentionDays: 30 });
    const tooLong = await call(app, 'PUT', '/api/v1/admin/settings/logs', {
      sid: adminSid,
      body: { retentionDays: 99_999 },
    });
    expect(tooLong.statusCode).toBe(400);
    const res = await call(app, 'PUT', '/api/v1/admin/settings/logs', {
      sid: adminSid,
      body: { retentionDays: 14 },
    });
    expect(res.json()).toEqual({ retentionDays: 14 });
  });

  it('serves the admin default theme publicly and lets each user override it', async () => {
    const theme = { mode: ThemeMode.DARK, primary: '#0f766e', accent: '#c2410c' };
    const saved = await call(app, 'PUT', '/api/v1/admin/settings/theme', {
      sid: adminSid,
      body: theme,
    });
    expect(saved.json()).toEqual({ ...theme, primary: '#0F766E', accent: '#C2410C' });
    const visible = (await call(app, 'GET', '/api/v1/branding')).json() as PublicBrandingDto;
    expect(visible.theme).toEqual({ mode: 'DARK', primary: '#0F766E', accent: '#C2410C' });

    expect((await call(app, 'GET', '/api/v1/me/theme', { sid: userSid })).json()).toEqual({
      theme: null,
    });
    const mine = { mode: ThemeMode.LIGHT, primary: '#BE185D', accent: '#BE185D' };
    expect(
      (await call(app, 'PUT', '/api/v1/me/theme', { sid: userSid, body: mine })).json(),
    ).toEqual({ theme: mine });
    expect(
      ((await call(app, 'GET', '/api/v1/me/theme', { sid: userSid })).json() as MyThemeDto).theme,
    ).toEqual(mine);
    // Each user sees only their own theme.
    expect((await call(app, 'GET', '/api/v1/me/theme', { sid: adminSid })).json()).toEqual({
      theme: null,
    });
    const invalid = await call(app, 'PUT', '/api/v1/me/theme', {
      sid: userSid,
      body: { ...mine, primary: 'url(javascript:x)' },
    });
    expect(invalid.statusCode).toBe(400);
    expect((await call(app, 'DELETE', '/api/v1/me/theme', { sid: userSid })).json()).toEqual({
      theme: null,
    });
  });

  it('brands the app with a name, a logo and an uploaded font, served publicly', async () => {
    const svg = await upload(
      app,
      '/api/v1/admin/settings/branding/logo',
      adminSid,
      SVG,
      'l.png',
      'PUT',
    );
    expect(svg.statusCode).toBe(415);
    expect(codeOf(svg)).toBe(ErrorCode.UNSUPPORTED_FILE_TYPE);
    const logo = await upload(
      app,
      '/api/v1/admin/settings/branding/logo',
      adminSid,
      PNG,
      'mark.png',
      'PUT',
    );
    expect(logo.statusCode).toBe(200);
    expect((logo.json() as BrandingSettingsDto).logo).toMatchObject({
      name: 'mark.png',
      type: 'image/png',
      sizeBytes: PNG.length,
    });

    const chooseEarly = await call(app, 'PUT', '/api/v1/admin/settings/branding', {
      sid: adminSid,
      body: { appName: 'Team Board', font: UiFont.UPLOADED },
    });
    expect(chooseEarly.statusCode).toBe(400);
    const font = await upload(
      app,
      '/api/v1/admin/settings/branding/fonts/regular',
      adminSid,
      WOFF2,
      'Brand.woff2',
      'PUT',
    );
    expect(font.statusCode).toBe(200);
    const named = await call(app, 'PUT', '/api/v1/admin/settings/branding', {
      sid: adminSid,
      body: { appName: '  Team Board  ', font: UiFont.UPLOADED },
    });
    expect(named.json()).toMatchObject({ appName: 'Team Board', font: UiFont.UPLOADED });
    const control = await call(app, 'PUT', '/api/v1/admin/settings/branding', {
      sid: adminSid,
      body: { appName: 'Bad‮name', font: UiFont.ARIAL },
    });
    expect(control.statusCode).toBe(400);

    // Public, no session: only what pages draw.
    const res = await call(app, 'GET', '/api/v1/branding');
    expect(res.statusCode).toBe(200);
    const visible = res.json() as PublicBrandingDto;
    expect(Object.keys(visible).sort()).toEqual([
      'appName',
      'font',
      'fontFiles',
      'logoUrl',
      'theme',
    ]);
    expect(visible).toMatchObject({ appName: 'Team Board', font: UiFont.UPLOADED });
    expect(visible.logoUrl).toMatch(/^api\/v1\/branding\/logo\?v=[0-9a-f]+$/);
    expect(visible.fontFiles?.regular).toMatch(/^api\/v1\/branding\/fonts\/regular\?v=/);
    expect(visible.fontFiles?.bold).toBeNull();

    const image = await app.inject({ method: 'GET', url: `/${visible.logoUrl ?? ''}` });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(image.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(image.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(image.rawPayload.equals(PNG)).toBe(true);
    const again = await app.inject({
      method: 'GET',
      url: '/api/v1/branding/logo',
      headers: { 'if-none-match': String(image.headers['etag']) },
    });
    expect(again.statusCode).toBe(304);
    const fontFile = await app.inject({ method: 'GET', url: '/api/v1/branding/fonts/regular' });
    expect(fontFile.headers['content-type']).toBe('font/woff2');
    expect(fontFile.headers['x-content-type-options']).toBe('nosniff');
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/branding/fonts/bold' })).statusCode,
    ).toBe(404);

    const actions = await prisma.auditLog.findMany({
      where: { actorId: adminId, entityType: 'AppSetting' },
      orderBy: { createdAt: 'asc' },
      select: { action: true },
    });
    expect(actions.map((a) => a.action)).toEqual([
      AuditAction.BRANDING_FILE_UPLOADED,
      AuditAction.BRANDING_FILE_UPLOADED,
      AuditAction.SETTINGS_UPDATED,
    ]);

    // Removing the regular font falls back to Figtree; removing the logo hides it.
    await call(app, 'DELETE', '/api/v1/admin/settings/branding/fonts/regular', { sid: adminSid });
    await call(app, 'DELETE', '/api/v1/admin/settings/branding/logo', { sid: adminSid });
    const after = (await call(app, 'GET', '/api/v1/branding')).json() as PublicBrandingDto;
    expect(after).toMatchObject({ font: UiFont.FIGTREE, fontFiles: null, logoUrl: null });
    expect((await app.inject({ method: 'GET', url: '/api/v1/branding/logo' })).statusCode).toBe(
      404,
    );
  });

  it('runs a backup now with pg_dump, lists it and audits request and result', async () => {
    await rm(join(FAKE_PG_DUMP_DIR, 'fail'), { force: true });
    const started = await call(app, 'POST', '/api/v1/admin/backups/run', { sid: adminSid });
    expect(started.statusCode).toBe(202);
    const status = await backupsIdle();
    expect(status.folder).toBe(BACKUP_DIR);
    const run = status.runs[0];
    expect(run).toMatchObject({ succeeded: true, trigger: 'MANUAL', error: null });
    expect(run?.file).toMatch(/^kloister-test-\d{8}-\d{6}\.dump$/);
    expect(status.files.map((f) => f.name)).toContain(run?.file);
    expect(await readFile(join(BACKUP_DIR, run?.file ?? ''), 'utf8')).toContain('PGDMP fake dump');

    // Credentials reach pg_dump through its environment, never its arguments.
    const args = await readFile(join(FAKE_PG_DUMP_DIR, 'args'), 'utf8');
    expect(args.split('\n')).toEqual(expect.arrayContaining(['--format=custom', '--no-password']));
    expect(args).not.toContain('kloister@');
    const env = await readFile(join(FAKE_PG_DUMP_DIR, 'env'), 'utf8');
    expect(env).toMatch(/^PGDATABASE=/m);
    expect(env).not.toMatch(/^DATABASE_URL=/m);

    const audit = await prisma.auditLog.findMany({
      where: { action: { in: [AuditAction.BACKUP_REQUESTED, AuditAction.BACKUP_SUCCEEDED] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => [a.action, a.actorId])).toEqual([
      [AuditAction.BACKUP_REQUESTED, adminId],
      [AuditAction.BACKUP_SUCCEEDED, adminId],
    ]);
    await rm(join(BACKUP_DIR, run?.file ?? 'none'), { force: true });
  });

  it('records a failed backup and refuses a second run while one is running', async () => {
    await writeFile(join(FAKE_PG_DUMP_DIR, 'slow'), '');
    await writeFile(join(FAKE_PG_DUMP_DIR, 'fail'), '');
    try {
      const first = await call(app, 'POST', '/api/v1/admin/backups/run', { sid: adminSid });
      expect(first.statusCode).toBe(202);
      const second = await call(app, 'POST', '/api/v1/admin/backups/run', { sid: adminSid });
      expect(second.statusCode).toBe(409);
      expect(codeOf(second)).toBe(ErrorCode.BACKUP_RUNNING);
      const status = await backupsIdle();
      expect(status.runs[0]).toMatchObject({
        succeeded: false,
        file: null,
        error: 'pg_dump exited with code 2: pg_dump: error: simulated failure',
      });
      // Nothing is left on disk, not even the partial file pg_dump began.
      expect((await readdir(BACKUP_DIR)).filter((n) => n.endsWith('.partial'))).toEqual([]);
    } finally {
      await rm(join(FAKE_PG_DUMP_DIR, 'slow'), { force: true });
      await rm(join(FAKE_PG_DUMP_DIR, 'fail'), { force: true });
    }
  });

  it('saves the backup schedule and validates the time', async () => {
    const bad = await call(app, 'PUT', '/api/v1/admin/backups/settings', {
      sid: adminSid,
      body: { enabled: true, time: '24:00', retentionDays: 7 },
    });
    expect(bad.statusCode).toBe(400);
    const res = await call(app, 'PUT', '/api/v1/admin/backups/settings', {
      sid: adminSid,
      body: { enabled: false, time: '23:15', retentionDays: 30 },
    });
    expect(res.statusCode).toBe(200);
    const status = res.json() as BackupsDto;
    expect(status.settings).toEqual({ enabled: false, time: '23:15', retentionDays: 30 });
    expect(status.nextRunAt).toBeNull();
    expect(
      await prisma.auditLog.count({
        where: { action: AuditAction.SETTINGS_UPDATED, actorId: adminId },
      }),
    ).toBe(1);
  });

  it('keeps the public branding route open while uploads still need the CSRF header', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/branding/logo',
      headers: { 'content-type': 'application/octet-stream' },
      cookies: { sid: adminSid },
      payload: PNG,
    });
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe(ErrorCode.CSRF_HEADER_MISSING);
    const open = await app.inject({
      method: 'GET',
      url: '/api/v1/branding',
      headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE },
    });
    expect(open.statusCode).toBe(200);
  });
});
