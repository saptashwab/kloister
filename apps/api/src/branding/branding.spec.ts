import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { AuditAction, ErrorCode, ThemeMode, UiFont } from '@kloister/shared';
import { fakeAudit, fakePrisma, makeConfig, makeUser } from '../../test/support/fakes.js';
import type { AuthContext } from '../auth/auth-context.js';
import { ApiException } from '../common/api-exception.js';
import { SettingsService } from '../settings/settings.service.js';
import { BrandingService } from './branding.service.js';

const admin: AuthContext = { user: makeUser({ systemRole: 'ADMIN' }), sessionId: 's1' };

/** A tiny PNG head followed by padding. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);
const WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(64)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');

/**
 * An upload as the controller passes it on.
 *
 * @param bytes The file.
 * @param name The `x-file-name` header.
 * @returns The upload.
 */
function upload(bytes: Buffer, name = 'file.bin') {
  return {
    body: Readable.from([bytes]),
    fileName: encodeURIComponent(name),
    contentLength: String(bytes.length),
  };
}

/**
 * Reads the error code of a rejected call.
 *
 * @param promise The call.
 * @returns The status and code.
 */
async function failure(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiException);
  const e = error as ApiException;
  return { status: e.getStatus(), code: (e.getResponse() as { code: string }).code };
}

describe('BrandingService (SPEC §6 branding, docs/DESIGN.md §6)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kloister-branding-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Builds the service over an in-memory settings table.
   *
   * @returns The service, the stored rows and the audit records.
   */
  function build() {
    const { fake, prisma } = fakePrisma();
    const rows = new Map<string, unknown>();
    fake.appSetting.findUnique.mockImplementation((args: unknown) => {
      const key = (args as { where: { key: string } }).where.key;
      return Promise.resolve(rows.has(key) ? { key, value: rows.get(key) } : null);
    });
    fake.appSetting.upsert.mockImplementation((args: unknown) => {
      const { where, update } = args as { where: { key: string }; update: { value: unknown } };
      // Stored as JSON, like the database does.
      rows.set(where.key, JSON.parse(JSON.stringify(update.value)));
      return Promise.resolve({});
    });
    const audit = fakeAudit();
    const service = new BrandingService(
      prisma,
      new SettingsService(prisma),
      audit.service,
      makeConfig({ brandingDir: dir }),
    );
    return { service, rows, records: audit.records };
  }

  it('starts with the default name, Figtree, no logo and the default theme', async () => {
    const { service } = build();
    await expect(service.publicBranding()).resolves.toEqual({
      appName: 'Kloister',
      logoUrl: null,
      font: UiFont.FIGTREE,
      fontFiles: null,
      theme: { mode: ThemeMode.SYSTEM, primary: '#4F46E5', accent: '#4F46E5' },
    });
  });

  it('stores a logo checked by content and serves it under a versioned URL', async () => {
    const { service, records } = build();
    const settings = await service.upload(admin, 'logo', upload(PNG, 'mark.png'));
    expect(settings.logo).toMatchObject({ name: 'mark.png', type: 'image/png', sizeBytes: 72 });
    const visible = await service.publicBranding();
    expect(visible.logoUrl).toMatch(/^api\/v1\/branding\/logo\?v=[0-9a-f]{16}$/);
    const opened = await service.open('logo');
    expect(opened.file.type).toBe('image/png');
    opened.stream.destroy();
    expect(service.etag(opened.file)).toMatch(/^"[0-9a-f]{64}"$/);
    expect(records).toEqual([
      expect.objectContaining({
        action: AuditAction.BRANDING_FILE_UPLOADED,
        meta: expect.objectContaining({ file: 'logo', type: 'image/png' }) as unknown,
      }),
    ]);
    // Only the stored file is left: no incoming leftovers.
    expect((await readdir(dir)).filter((n) => n !== '.incoming')).toHaveLength(1);
  });

  it('replaces the previous logo file and removes it from disk', async () => {
    const { service } = build();
    await service.upload(admin, 'logo', upload(PNG));
    const first = (await readdir(dir)).filter((n) => n !== '.incoming');
    await service.upload(admin, 'logo', upload(Buffer.concat([PNG, Buffer.from('2')])));
    const second = (await readdir(dir)).filter((n) => n !== '.incoming');
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first[0]);
  });

  it('refuses SVG and other non-images as the logo, and oversized logos', async () => {
    const { service } = build();
    await expect(failure(service.upload(admin, 'logo', upload(SVG, 'logo.png')))).resolves.toEqual({
      status: 415,
      code: ErrorCode.UNSUPPORTED_FILE_TYPE,
    });
    await expect(
      failure(service.upload(admin, 'logo', upload(Buffer.alloc(2 * 1024 * 1024)))),
    ).resolves.toEqual({ status: 413, code: ErrorCode.FILE_TOO_LARGE });
    expect((await readdir(dir)).filter((n) => n !== '.incoming')).toEqual([]);
    expect(await readdir(join(dir, '.incoming'))).toEqual([]);
  });

  it('accepts fonts by content only and uses an uploaded font once chosen', async () => {
    const { service, rows } = build();
    await expect(
      failure(service.upload(admin, 'fontRegular', upload(PNG, 'font.woff2'))),
    ).resolves.toEqual({ status: 415, code: ErrorCode.UNSUPPORTED_FILE_TYPE });
    await expect(
      failure(service.save(admin, { appName: 'Board', font: UiFont.UPLOADED })),
    ).resolves.toEqual({ status: 400, code: ErrorCode.VALIDATION_FAILED });

    await service.upload(admin, 'fontRegular', upload(WOFF2, 'Brand-Regular.woff2'));
    await service.save(admin, { appName: 'Team Board', font: UiFont.UPLOADED });
    expect(rows.get('branding')).toEqual({ appName: 'Team Board', font: UiFont.UPLOADED });
    const visible = await service.publicBranding();
    expect(visible.font).toBe(UiFont.UPLOADED);
    expect(visible.fontFiles?.regular).toMatch(/^api\/v1\/branding\/fonts\/regular\?v=/);
    expect(visible.fontFiles?.bold).toBeNull();

    await service.upload(admin, 'fontBold', upload(WOFF2, 'Brand-Bold.woff2'));
    expect((await service.publicBranding()).fontFiles?.bold).toMatch(/fonts\/bold\?v=/);
  });

  it('removing the regular font removes the bold one and falls back to Figtree', async () => {
    const { service, records } = build();
    await service.upload(admin, 'fontRegular', upload(WOFF2));
    await service.upload(admin, 'fontBold', upload(WOFF2));
    await service.save(admin, { appName: 'Board', font: UiFont.UPLOADED });
    const settings = await service.remove(admin, 'fontRegular');
    expect(settings.font).toBe(UiFont.FIGTREE);
    expect(settings.fontFiles).toEqual({ regular: null, bold: null });
    expect((await readdir(dir)).filter((n) => n !== '.incoming')).toEqual([]);
    expect(records.at(-1)).toMatchObject({
      action: AuditAction.BRANDING_FILE_REMOVED,
      meta: { file: 'fontRegular', removed: ['fontRegular', 'fontBold'], fontReset: true },
    });
    await expect(failure(service.open('fontRegular'))).resolves.toEqual({
      status: 404,
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('keeps a bold file alone when there is no regular file to remove', async () => {
    const { service, records } = build();
    await service.upload(admin, 'fontBold', upload(WOFF2));
    const settings = await service.remove(admin, 'fontRegular');
    expect(settings.fontFiles.bold).not.toBeNull();
    expect((await readdir(dir)).filter((n) => n !== '.incoming')).toHaveLength(1);
    expect(records.map((r) => r.action)).toEqual([AuditAction.BRANDING_FILE_UPLOADED]);
  });

  it('refuses an upload that is not a raw body', async () => {
    const { service } = build();
    await expect(
      failure(service.upload(admin, 'logo', { body: {}, fileName: 'a', contentLength: '2' })),
    ).resolves.toEqual({ status: 400, code: ErrorCode.VALIDATION_FAILED });
  });
});
