import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { DEFAULT_THEME, ThemeMode } from '@kloister/shared';
import { settle } from '../../../testing/fixtures';
import { SessionStore } from '../../core/session.store';
import { SettingsApiService } from '../../core/settings-api.service';
import { ThemeService } from '../../core/theme.service';
import { ToastService } from '../../ui/toast.service';
import { AccountSettingsPage } from './account-settings';

const USER = {
  id: 'u1',
  email: 'ann@example.org',
  displayName: 'Ann',
  systemRole: 'USER' as const,
  mustChangePassword: false,
  isActive: true,
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('AccountSettingsPage (SPEC §6 user settings)', () => {
  /**
   * Renders the page over a mocked API.
   *
   * @returns The fixture, root, API mock and theme service.
   */
  async function render() {
    const api = {
      setMyTheme: vi.fn().mockImplementation((theme: unknown) => Promise.resolve({ theme })),
      updateMe: vi
        .fn()
        .mockImplementation((r: { displayName: string }) => Promise.resolve({ ...USER, ...r })),
    };
    await TestBed.configureTestingModule({
      imports: [AccountSettingsPage],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: SettingsApiService, useValue: api },
      ],
    }).compileComponents();
    TestBed.inject(SessionStore).set(USER);
    vi.spyOn(TestBed.inject(ToastService), 'show').mockImplementation(() => undefined);
    const fixture = TestBed.createComponent(AccountSettingsPage);
    await settle(fixture);
    return {
      fixture,
      root: fixture.nativeElement as HTMLElement,
      api,
      theme: TestBed.inject(ThemeService),
    };
  }

  it('previews an own theme while picking and saves it', async () => {
    const { fixture, root, api, theme } = await render();
    expect(root.querySelector('app-theme-picker')).toBeNull();
    root.querySelector<HTMLInputElement>('mat-radio-button[value="own"] input')?.click();
    await settle(fixture);
    root
      .querySelector<HTMLButtonElement>(
        '[aria-label="Your theme Primary colour"] [aria-label="Pink"]',
      )
      ?.click();
    root
      .querySelectorAll<HTMLButtonElement>('app-theme-picker mat-button-toggle button')[2]
      ?.click();
    await settle(fixture);
    const draft = { mode: ThemeMode.DARK, primary: '#BE185D', accent: DEFAULT_THEME.accent };
    expect(theme.theme()).toEqual(draft);
    expect(root.textContent).toContain('in dark mode, so text reaches at least 4.5:1 contrast');

    [...root.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Save theme'))
      ?.click();
    await settle(fixture);
    expect(api.setMyTheme).toHaveBeenCalledWith(draft);
    expect(theme.userTheme()).toEqual(draft);
  });

  it('goes back to the default theme and stops previewing when left', async () => {
    const { fixture, root, api, theme } = await render();
    theme.setUserTheme({ mode: ThemeMode.LIGHT, primary: '#0F766E', accent: '#0F766E' });
    fixture.destroy();
    const again = TestBed.createComponent(AccountSettingsPage);
    await settle(again);
    const page = again.nativeElement as HTMLElement;
    expect(page.querySelector('app-theme-picker')).not.toBeNull();
    page.querySelector<HTMLInputElement>('mat-radio-button[value="default"] input')?.click();
    await settle(again);
    expect(theme.theme()).toEqual(DEFAULT_THEME);
    [...page.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Save theme'))
      ?.click();
    await settle(again);
    expect(api.setMyTheme).toHaveBeenCalledWith(null);
    expect(theme.userTheme()).toBeNull();
    expect(root).toBeTruthy();
  });

  it('saves the display name', async () => {
    const { fixture, root, api } = await render();
    const input = root.querySelector<HTMLInputElement>('input[formcontrolname="displayName"]');
    if (input === null) throw new Error('no name field');
    input.value = 'Ann Lee';
    input.dispatchEvent(new Event('input'));
    await settle(fixture);
    [...root.querySelectorAll('button')].find((b) => b.textContent?.includes('Save name'))?.click();
    await settle(fixture);
    expect(api.updateMe).toHaveBeenCalledWith({ displayName: 'Ann Lee' });
    expect(TestBed.inject(SessionStore).user()?.displayName).toBe('Ann Lee');
  });
});
