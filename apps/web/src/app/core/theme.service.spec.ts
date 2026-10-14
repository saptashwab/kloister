import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { DEFAULT_THEME, type PublicBrandingDto, ThemeMode, UiFont } from '@kloister/shared';
import { DEFAULT_BRANDING, ThemeService } from './theme.service';

const BRANDING: PublicBrandingDto = {
  appName: 'Team Board',
  logoUrl: 'api/v1/branding/logo?v=abc',
  font: UiFont.ATKINSON_HYPERLEGIBLE,
  fontFiles: null,
  theme: { mode: ThemeMode.DARK, primary: '#0F766E', accent: '#0F766E' },
};

describe('ThemeService (SPEC §6 theming and branding)', () => {
  let service: ThemeService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ThemeService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.getElementById('k-theme')?.remove();
  });

  /**
   * The theme style element's text.
   *
   * @returns The CSS.
   */
  const css = (): string => document.getElementById('k-theme')?.textContent ?? '';

  it('applies the admin branding: title, font, colours and mode', async () => {
    const loading = service.loadBranding();
    http.expectOne('api/v1/branding').flush(BRANDING);
    await loading;
    TestBed.tick();
    expect(document.title).toBe('Team Board');
    expect(service.logoUrl()).toBe('api/v1/branding/logo?v=abc');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(css()).toContain('--k-primary:#0F766E');
    expect(css()).toContain("--k-font:'Atkinson Hyperlegible'");
  });

  it('keeps the defaults when the branding cannot be loaded', async () => {
    const loading = service.loadBranding();
    http.expectOne('api/v1/branding').flush(null, { status: 500, statusText: 'Error' });
    await loading;
    TestBed.tick();
    expect(service.branding()).toEqual(DEFAULT_BRANDING);
    expect(document.title).toBe('Kloister');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(css()).toBe('');
  });

  it('lets a user theme, then a preview, override the default, and returns on sign-out', async () => {
    service.setBranding(BRANDING);
    const loading = service.loadUserTheme();
    http
      .expectOne('api/v1/me/theme')
      .flush({ theme: { mode: ThemeMode.LIGHT, primary: '#BE185D', accent: '#BE185D' } });
    await loading;
    TestBed.tick();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(css()).toContain('--k-primary:#BE185D');

    service.previewTheme({ ...DEFAULT_THEME, mode: ThemeMode.SYSTEM });
    TestBed.tick();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(css()).not.toContain('--k-primary');

    service.previewTheme(null);
    service.setUserTheme(null);
    TestBed.tick();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(css()).toContain('--k-primary:#0F766E');
  });
});
