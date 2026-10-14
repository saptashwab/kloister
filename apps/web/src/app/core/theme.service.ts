import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import {
  DEFAULT_APP_NAME,
  DEFAULT_THEME,
  type MyThemeDto,
  type PublicBrandingDto,
  type ThemeDto,
  ThemeMode,
  UiFont,
} from '@kloister/shared';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from './api';
import { themeCss } from './theme';

/** Branding used until the server answers, or when it cannot be reached. */
export const DEFAULT_BRANDING: PublicBrandingDto = {
  appName: DEFAULT_APP_NAME,
  logoUrl: null,
  font: UiFont.FIGTREE,
  fontFiles: null,
  theme: DEFAULT_THEME,
};

/** Id of the style element holding the theme's custom properties. */
const STYLE_ID = 'k-theme';

/** How long the first branding request may delay the app's start. */
const BRANDING_WAIT_MS = 3000;

/**
 * Applies the app's look (SPEC §6, DESIGN §2): the admin's branding (app
 * name in the page title, logo, UI font) and the theme in effect, which is
 * the signed-in user's own theme or else the admin default. The mode sets
 * `data-theme` on `<html>` (none follows the operating system), and the
 * colours and font replace the design tokens through one style element
 * built by {@link themeCss}, which keeps text at WCAG AA contrast.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  // HttpClient directly, not the settings client: this service is part of
  // the initial bundle and needs only two endpoints.
  private readonly http = inject(HttpClient);
  private readonly document = inject(DOCUMENT);
  private readonly title = inject(Title);

  private readonly current = signal<PublicBrandingDto>(DEFAULT_BRANDING);
  private readonly own = signal<ThemeDto | null>(null);
  private readonly preview = signal<ThemeDto | null>(null);

  /** The public branding. */
  readonly branding = this.current.asReadonly();
  /** The signed-in user's own theme, or null for the default. */
  readonly userTheme = this.own.asReadonly();
  /** The app name for the shell and the page title. */
  readonly appName = computed(() => this.current().appName);
  /** The logo's URL, or null. */
  readonly logoUrl = computed(() => this.current().logoUrl);
  /** The theme in effect: a preview, the user's own, or the admin default. */
  readonly theme = computed(() => this.preview() ?? this.own() ?? this.current().theme);

  /**
   * Keeps the document in step with the branding and theme.
   */
  constructor() {
    effect(() => this.apply(this.theme(), this.current()));
  }

  /**
   * Loads the public branding; used before the app first renders, so the
   * sign-in page already shows the right name, font and colours. Waits at
   * most a few seconds and keeps the defaults when the server cannot answer.
   *
   * @returns Resolves once loaded or given up.
   */
  async loadBranding(): Promise<void> {
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), BRANDING_WAIT_MS),
    );
    try {
      const request = firstValueFrom(this.http.get<PublicBrandingDto>(apiUrl('branding')));
      const branding = await Promise.race([request, timeout]);
      if (branding !== null) this.current.set(branding);
    } catch {
      // Keep the defaults; the app works without branding.
    }
  }

  /**
   * Replaces the branding after an admin changed it.
   *
   * @param branding The new public branding.
   */
  setBranding(branding: PublicBrandingDto): void {
    this.current.set(branding);
  }

  /**
   * Loads the signed-in user's own theme.
   *
   * @returns Resolves once loaded; failures keep the default.
   */
  async loadUserTheme(): Promise<void> {
    try {
      const mine = await firstValueFrom(this.http.get<MyThemeDto>(apiUrl('me/theme')));
      this.own.set(mine.theme);
    } catch {
      this.own.set(null);
    }
  }

  /**
   * Records the user's own theme after it was saved, or clears it on sign-out.
   *
   * @param theme The theme, or null for the default.
   */
  setUserTheme(theme: ThemeDto | null): void {
    this.own.set(theme);
  }

  /**
   * Shows a theme while it is being picked, without saving it.
   *
   * @param theme The theme to show, or null to stop previewing.
   */
  previewTheme(theme: ThemeDto | null): void {
    this.preview.set(theme);
  }

  /**
   * Writes the mode, colours, font and title to the document.
   *
   * @param theme The theme in effect.
   * @param branding The branding.
   */
  private apply(theme: ThemeDto, branding: PublicBrandingDto): void {
    const root = this.document.documentElement;
    if (theme.mode === ThemeMode.SYSTEM) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme.mode === ThemeMode.DARK ? 'dark' : 'light');
    let style = this.document.getElementById(STYLE_ID);
    if (style === null) {
      style = this.document.createElement('style');
      style.id = STYLE_ID;
      this.document.head.appendChild(style);
    }
    style.textContent = themeCss(theme, branding);
    this.title.setTitle(branding.appName);
  }
}
