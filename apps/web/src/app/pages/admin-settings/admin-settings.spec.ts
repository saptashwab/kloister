import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  type BackupsDto,
  type BrandingSettingsDto,
  DEFAULT_THEME,
  type DiskUsageDto,
  FontWeight,
  UiFont,
} from '@kloister/shared';
import { settle } from '../../../testing/fixtures';
import { SettingsApiService } from '../../core/settings-api.service';
import { DEFAULT_BRANDING, ThemeService } from '../../core/theme.service';
import { Dialogs } from '../../ui/dialogs';
import { ToastService } from '../../ui/toast.service';
import { AdminBackupsPage } from './admin-backups';
import { AdminBrandingPage } from './admin-branding';
import { AdminLogsPage } from './admin-logs';
import { AdminSecurityPage } from './admin-security';
import { AdminStoragePage } from './admin-storage';

const BRANDING: BrandingSettingsDto = {
  appName: 'Kloister',
  font: UiFont.FIGTREE,
  logo: null,
  fontFiles: { regular: null, bold: null },
};

const BACKUPS: BackupsDto = {
  settings: { enabled: true, time: '02:00', retentionDays: 14 },
  running: false,
  nextRunAt: '2026-10-15T02:00:00.000Z',
  runs: [],
  files: [],
  folder: '/app/x/backups/postgres',
};

const USAGE: DiskUsageDto = {
  app: { path: '/app/x', bytes: 4000, files: 10 },
  attachments: { path: '/app/x/data/attachments', bytes: 1000, files: 3 },
  backups: { path: '/app/x/backups/postgres', bytes: 2000, files: 2 },
  logs: { path: '/app/x/logs', bytes: 500, files: 4 },
  disk: { totalBytes: 10_000, freeBytes: 2_500 },
  measuredAt: '2026-10-14T08:00:00.000Z',
};

/**
 * Renders one admin settings tab over a mocked API.
 *
 * @param component The tab.
 * @param api Mocked API methods.
 * @returns The fixture, root element, API mock and toast spies.
 */
async function render(component: Type<unknown>, api: Record<string, unknown>) {
  await TestBed.configureTestingModule({
    imports: [component],
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: SettingsApiService, useValue: api },
      { provide: Dialogs, useValue: { confirm: vi.fn().mockResolvedValue(true) } },
    ],
  }).compileComponents();
  const toast = TestBed.inject(ToastService);
  const show = vi.spyOn(toast, 'show').mockImplementation(() => undefined);
  const error = vi.spyOn(toast, 'error').mockImplementation(() => undefined);
  const fixture = TestBed.createComponent(component);
  await settle(fixture);
  return { fixture, root: fixture.nativeElement as HTMLElement, show, error };
}

/**
 * Types into an input and lets the form see it.
 *
 * @param input The input.
 * @param value The new value.
 */
function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

/**
 * Finds a button by its text.
 *
 * @param root Where to look.
 * @param text Part of its text.
 * @returns The button.
 */
function button(root: HTMLElement, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
}

describe('AdminSecurityPage', () => {
  it('loads, explains durations and saves the settings', async () => {
    const value = {
      idleTimeoutMinutes: 480,
      absoluteTimeoutMinutes: 10_080,
      lockoutThreshold: 5,
      lockoutMinutes: 15,
    };
    const api = {
      security: vi.fn().mockResolvedValue(value),
      saveSecurity: vi.fn().mockImplementation((v: object) => Promise.resolve(v)),
    };
    const { fixture, root, show } = await render(AdminSecurityPage, api);
    expect(root.textContent).toContain('8 hours');
    expect(root.textContent).toContain('7 days');
    const inputs = root.querySelectorAll<HTMLInputElement>('input');
    type(inputs[2], '3');
    await settle(fixture);
    button(root, 'Save security settings').click();
    await settle(fixture);
    expect(api.saveSecurity).toHaveBeenCalledWith({ ...value, lockoutThreshold: 3 });
    expect(show).toHaveBeenCalledWith('Security settings saved');
  });

  it('refuses an absolute timeout shorter than the idle timeout', async () => {
    const api = {
      security: vi.fn().mockResolvedValue({
        idleTimeoutMinutes: 480,
        absoluteTimeoutMinutes: 10_080,
        lockoutThreshold: 5,
        lockoutMinutes: 15,
      }),
      saveSecurity: vi.fn(),
    };
    const { fixture, root } = await render(AdminSecurityPage, api);
    type(root.querySelectorAll<HTMLInputElement>('input')[1], '60');
    await settle(fixture);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('at least the idle');
    button(root, 'Save security settings').click();
    await settle(fixture);
    expect(api.saveSecurity).not.toHaveBeenCalled();
  });
});

describe('AdminStoragePage', () => {
  it('shows the disk usage of each folder and saves the limits', async () => {
    const api = {
      storage: vi
        .fn()
        .mockResolvedValue({ maxFileSizeMb: 25, projectQuotaMb: 2048, personalQuotaMb: 1024 }),
      saveStorage: vi.fn().mockImplementation((v: object) => Promise.resolve(v)),
      diskUsage: vi.fn().mockResolvedValue(USAGE),
    };
    const { fixture, root, show } = await render(AdminStoragePage, api);
    const usage = root.querySelector('ul[aria-label="Folders"]')?.textContent ?? '';
    expect(usage).toContain('Attachments');
    expect(usage).toContain('1000 bytes in 3 files');
    expect(usage).toContain('/app/x/backups/postgres');
    expect(root.textContent).toMatch(/7\.3 KB used · 2\.4 KB free\s+of 9\.8 KB/);
    expect(root.textContent).toContain('2.0 GB per project');
    type(root.querySelector<HTMLInputElement>('input') as HTMLInputElement, '50');
    await settle(fixture);
    button(root, 'Save limits').click();
    await settle(fixture);
    expect(api.saveStorage).toHaveBeenCalledWith({
      maxFileSizeMb: 50,
      projectQuotaMb: 2048,
      personalQuotaMb: 1024,
    });
    expect(show).toHaveBeenCalledWith('Attachment limits saved');
    button(root, 'Measure again').click();
    await settle(fixture);
    expect(api.diskUsage).toHaveBeenCalledTimes(2);
  });
});

describe('AdminLogsPage', () => {
  it('saves the retention within its range only', async () => {
    const api = {
      logs: vi.fn().mockResolvedValue({ retentionDays: 30 }),
      saveLogs: vi.fn().mockImplementation((v: object) => Promise.resolve(v)),
    };
    const { fixture, root } = await render(AdminLogsPage, api);
    const input = root.querySelector<HTMLInputElement>('input') as HTMLInputElement;
    type(input, '0');
    await settle(fixture);
    expect(button(root, 'Save log retention').disabled).toBe(true);
    type(input, '90');
    await settle(fixture);
    button(root, 'Save log retention').click();
    await settle(fixture);
    expect(api.saveLogs).toHaveBeenCalledWith({ retentionDays: 90 });
  });
});

describe('AdminBackupsPage', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('shows the schedule and empty states, saves the schedule', async () => {
    const api = {
      backups: vi.fn().mockResolvedValue(BACKUPS),
      saveBackupSettings: vi.fn().mockResolvedValue({
        ...BACKUPS,
        settings: { enabled: false, time: '02:00', retentionDays: 14 },
        nextRunAt: null,
      }),
      runBackup: vi.fn(),
    };
    const { fixture, root, show } = await render(AdminBackupsPage, api);
    expect(root.textContent).toContain('No backups yet');
    expect(root.textContent).toContain('/app/x/backups/postgres');
    (root.querySelector('mat-slide-toggle button') as HTMLButtonElement).click();
    await settle(fixture);
    button(root, 'Save schedule').click();
    await settle(fixture);
    expect(api.saveBackupSettings).toHaveBeenCalledWith({
      enabled: false,
      time: '02:00',
      retentionDays: 14,
    });
    expect(show).toHaveBeenCalledWith('Backup schedule saved');
    expect(root.textContent).toContain('Off');
  });

  it('runs a backup now, follows it and reports the result', async () => {
    const done = {
      ...BACKUPS,
      runs: [
        {
          id: 'r1',
          trigger: 'MANUAL' as const,
          succeeded: true,
          startedAt: '2026-10-14T08:00:00.000Z',
          finishedAt: '2026-10-14T08:00:03.000Z',
          file: 'x-20261014-080000.dump',
          sizeBytes: 2048,
          error: null,
          pruned: 1,
        },
      ],
      files: [
        { name: 'x-20261014-080000.dump', sizeBytes: 2048, modifiedAt: '2026-10-14T08:00:03.000Z' },
      ],
    };
    const api = {
      backups: vi
        .fn()
        .mockResolvedValueOnce(BACKUPS)
        .mockResolvedValueOnce({ ...BACKUPS, running: true })
        .mockResolvedValue(done),
      runBackup: vi.fn().mockResolvedValue({ ...BACKUPS, running: true }),
    };
    const { fixture, root, show } = await render(AdminBackupsPage, api);
    button(root, 'Run now').click();
    await settle(fixture);
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Backing up');
    expect(button(root, 'Run now').disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    await settle(fixture);
    await vi.advanceTimersByTimeAsync(2000);
    await settle(fixture);
    expect(show).toHaveBeenCalledWith('Backup finished: x-20261014-080000.dump');
    expect(root.textContent).toContain('Succeeded');
    expect(root.textContent).toContain('1 old deleted');
    expect(root.textContent).toContain('2.0 KB');
  });
});

describe('AdminBrandingPage', () => {
  /**
   * The mocked API of the branding tab.
   *
   * @returns The mock.
   */
  function brandingApi() {
    return {
      branding: vi.fn().mockResolvedValue(BRANDING),
      defaultTheme: vi.fn().mockResolvedValue(DEFAULT_THEME),
      publicBranding: vi.fn().mockResolvedValue({ ...DEFAULT_BRANDING, appName: 'Team Board' }),
      saveBranding: vi
        .fn()
        .mockImplementation((v: { appName: string; font: UiFont }) =>
          Promise.resolve({ ...BRANDING, ...v }),
        ),
      uploadLogo: vi.fn().mockResolvedValue({
        ...BRANDING,
        logo: {
          name: 'mark.png',
          type: 'image/png',
          sizeBytes: 1200,
          uploadedAt: '2026-10-14T08:00:00.000Z',
        },
      }),
      removeLogo: vi.fn().mockResolvedValue(BRANDING),
      uploadFont: vi.fn().mockResolvedValue({
        ...BRANDING,
        fontFiles: {
          regular: {
            name: 'Brand.woff2',
            type: 'font/woff2',
            sizeBytes: 30_000,
            uploadedAt: '2026-10-14T08:00:00.000Z',
          },
          bold: null,
        },
      }),
      removeFont: vi.fn().mockResolvedValue(BRANDING),
      saveDefaultTheme: vi.fn().mockImplementation((v: object) => Promise.resolve(v)),
    };
  }

  it('saves the app name and refreshes the branding across the app', async () => {
    const api = brandingApi();
    const { fixture, root, show } = await render(AdminBrandingPage, api);
    type(
      root.querySelector<HTMLInputElement>('input[formcontrolname="appName"]') as HTMLInputElement,
      ' Team Board ',
    );
    await settle(fixture);
    button(root, 'Save name').click();
    await settle(fixture);
    expect(api.saveBranding).toHaveBeenCalledWith({ appName: 'Team Board', font: UiFont.FIGTREE });
    expect(TestBed.inject(ThemeService).appName()).toBe('Team Board');
    expect(show).toHaveBeenCalledWith('App name saved');
  });

  it('uploads a logo and a font, then offers the uploaded font', async () => {
    const api = brandingApi();
    const { fixture, root } = await render(AdminBrandingPage, api);
    const uploaded = root.querySelector<HTMLInputElement>('input[type="radio"][value="UPLOADED"]');
    expect(uploaded?.disabled).toBe(true);

    const logoInput = root.querySelector<HTMLInputElement>(
      'input[type="file"]',
    ) as HTMLInputElement;
    const logo = new File([new Uint8Array([137, 80])], 'mark.png', { type: 'image/png' });
    Object.defineProperty(logoInput, 'files', { value: [logo], configurable: true });
    logoInput.dispatchEvent(new Event('change'));
    await settle(fixture);
    expect(api.uploadLogo).toHaveBeenCalledWith(logo);
    expect(root.textContent).toContain('mark.png');

    const fontInput = root.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    const font = new File([new Uint8Array([119, 79, 70, 50])], 'Brand.woff2');
    Object.defineProperty(fontInput, 'files', { value: [font], configurable: true });
    fontInput.dispatchEvent(new Event('change'));
    await settle(fixture);
    expect(api.uploadFont).toHaveBeenCalledWith(FontWeight.REGULAR, font);
    expect(uploaded?.disabled).toBe(false);
    uploaded?.click();
    await settle(fixture);
    button(root, 'Save font').click();
    await settle(fixture);
    expect(api.saveBranding).toHaveBeenCalledWith({ appName: 'Kloister', font: UiFont.UPLOADED });
  });

  it('previews and saves the default theme', async () => {
    const api = brandingApi();
    const { fixture, root } = await render(AdminBrandingPage, api);
    const theme = TestBed.inject(ThemeService);
    root
      .querySelector<HTMLButtonElement>(
        '[aria-label="Default theme Primary colour"] [aria-label="Teal"]',
      )
      ?.click();
    await settle(fixture);
    expect(theme.theme().primary).toBe('#0F766E');
    button(root, 'Save default theme').click();
    await settle(fixture);
    expect(api.saveDefaultTheme).toHaveBeenCalledWith({ ...DEFAULT_THEME, primary: '#0F766E' });
  });

  it('previews for an admin with a personal theme and restores it on cancel and exit', async () => {
    const { fixture, root } = await render(AdminBrandingPage, brandingApi());
    const theme = TestBed.inject(ThemeService);
    const own = { ...DEFAULT_THEME, primary: '#C2410C' };
    theme.setUserTheme(own);
    root
      .querySelector<HTMLButtonElement>(
        '[aria-label="Default theme Primary colour"] [aria-label="Teal"]',
      )
      ?.click();
    await settle(fixture);
    expect(theme.theme().primary).toBe('#0F766E');
    button(root, 'Cancel').click();
    await settle(fixture);
    expect(theme.theme()).toEqual(own);
    root
      .querySelector<HTMLButtonElement>(
        '[aria-label="Default theme Primary colour"] [aria-label="Teal"]',
      )
      ?.click();
    await settle(fixture);
    fixture.destroy();
    expect(theme.theme()).toEqual(own);
  });
});
