import { fakePrisma } from '../../test/support/fakes.js';
import {
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
