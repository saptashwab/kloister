import { DEFAULT_APP_NAME, DEFAULT_THEME, ThemeMode, UiFont } from '@kloister/shared';
import { fakePrisma } from '../../test/support/fakes.js';
import {
  DEFAULT_LOG_SETTINGS,
  DEFAULT_SECURITY_SETTINGS,
  DEFAULT_STORAGE_SETTINGS,
  SettingsService,
} from './settings.service.js';

describe('SettingsService.getSecurity', () => {
  it('returns defaults when nothing is stored', async () => {
    const { fake, prisma } = fakePrisma();
    fake.appSetting.findUnique.mockResolvedValue(null);
    await expect(new SettingsService(prisma).getSecurity()).resolves.toEqual(
      DEFAULT_SECURITY_SETTINGS,
    );
  });

  it('uses stored values and replaces invalid ones with defaults', async () => {
    const { fake, prisma } = fakePrisma();
    fake.appSetting.findUnique.mockResolvedValue({
      value: { idleTimeoutMinutes: 30, lockoutThreshold: 0, lockoutMinutes: 'x' },
    });
    await expect(new SettingsService(prisma).getSecurity()).resolves.toEqual({
      ...DEFAULT_SECURITY_SETTINGS,
      idleTimeoutMinutes: 30,
    });
  });

  it('ignores a stored value that is not an object', async () => {
    const { fake, prisma } = fakePrisma();
    fake.appSetting.findUnique.mockResolvedValue({ value: [1, 2] });
    await expect(new SettingsService(prisma).getSecurity()).resolves.toEqual(
      DEFAULT_SECURITY_SETTINGS,
    );
  });
});

describe('SettingsService.getStorage', () => {
  it('returns the SPEC defaults (25 MB files, 2 GB per project) when nothing is stored', async () => {
    const { fake, prisma } = fakePrisma();
    fake.appSetting.findUnique.mockResolvedValue(null);
    await expect(new SettingsService(prisma).getStorage()).resolves.toEqual({
      maxFileSizeMb: 25,
      projectQuotaMb: 2048,
    });
  });

  it('uses stored values and never lets a bad value lift a limit', async () => {
    const { fake, prisma } = fakePrisma();
    fake.appSetting.findUnique.mockResolvedValue({
      value: { maxFileSizeMb: 5, projectQuotaMb: -1 },
    });
    await expect(new SettingsService(prisma).getStorage()).resolves.toEqual({
      ...DEFAULT_STORAGE_SETTINGS,
      maxFileSizeMb: 5,
    });
  });
});

describe('SettingsService, the M6 settings', () => {
  /**
   * A service whose stored rows come from a map.
   *
   * @param rows Stored values by key.
   * @returns The service and the fake Prisma.
   */
  function withRows(rows: Record<string, unknown>) {
    const { fake, prisma } = fakePrisma();
    fake.appSetting.findUnique.mockImplementation((args: unknown) => {
      const key = (args as { where: { key: string } }).where.key;
      return Promise.resolve(key in rows ? { key, value: rows[key] } : null);
    });
    return { fake, service: new SettingsService(prisma) };
  }

  it('returns the defaults when nothing is stored', async () => {
    const { service } = withRows({});
    await expect(service.getLogs()).resolves.toEqual(DEFAULT_LOG_SETTINGS);
    await expect(service.getBackups()).resolves.toEqual({
      enabled: true,
      time: '02:00',
      retentionDays: 14,
    });
    await expect(service.getTheme()).resolves.toEqual(DEFAULT_THEME);
    await expect(service.getBranding()).resolves.toEqual({
      appName: DEFAULT_APP_NAME,
      font: UiFont.FIGTREE,
    });
    await expect(service.getBrandingFiles()).resolves.toEqual({
      logo: null,
      fontRegular: null,
      fontBold: null,
    });
  });

  it('keeps valid stored values and replaces invalid ones field by field', async () => {
    const { service } = withRows({
      logs: { retentionDays: 7 },
      backups: { enabled: false, time: '25:00', retentionDays: 0 },
      theme: { mode: 'DARK', primary: '#0f766e', accent: 'red' },
      branding: { appName: '  Team Board  ', font: 'COMIC' },
    });
    await expect(service.getLogs()).resolves.toEqual({ retentionDays: 7 });
    await expect(service.getBackups()).resolves.toEqual({
      enabled: false,
      time: '02:00',
      retentionDays: 14,
    });
    await expect(service.getTheme()).resolves.toEqual({
      mode: ThemeMode.DARK,
      primary: '#0F766E',
      accent: DEFAULT_THEME.accent,
    });
    await expect(service.getBranding()).resolves.toEqual({
      appName: 'Team Board',
      font: UiFont.FIGTREE,
    });
  });

  it('ignores branding file records that could point outside the branding folder', async () => {
    const good = {
      storedName: '0b7c4c5e-8a43-4a6f-9b52-2b5d6f0e7a11',
      name: 'logo.png',
      type: 'image/png',
      sizeBytes: 120,
      sha256: 'a'.repeat(64),
      uploadedAt: '2026-10-14T08:00:00.000Z',
    };
    const { service } = withRows({
      brandingFiles: {
        logo: good,
        fontRegular: { ...good, storedName: '../../etc/passwd' },
        fontBold: { ...good, sha256: 'not-a-hash' },
      },
    });
    await expect(service.getBrandingFiles()).resolves.toEqual({
      logo: good,
      fontRegular: null,
      fontBold: null,
    });
  });

  it('stores a value with an upsert', async () => {
    const { fake, service } = withRows({});
    fake.appSetting.upsert.mockResolvedValue({});
    await service.save('logs', { retentionDays: 9 });
    expect(fake.appSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'logs' },
      create: { key: 'logs', value: { retentionDays: 9 } },
      update: { value: { retentionDays: 9 } },
    });
  });
});
