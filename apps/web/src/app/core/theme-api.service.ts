import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { type MyThemeDto, type PublicBrandingDto, type ThemeDto } from '@kloister/shared';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from './api';

/**
 * Client for the look of the app (SPEC §6): the public branding and the
 * caller's own theme. Kept apart from `SettingsApiService`, whose admin
 * calls load with the settings pages, because the theme service needs these
 * before the first page shows.
 */
@Injectable({ providedIn: 'root' })
export class ThemeApiService {
  private readonly http = inject(HttpClient);

  /**
   * The app name, logo, font and default theme; needs no session.
   *
   * @returns The public branding.
   */
  publicBranding(): Promise<PublicBrandingDto> {
    return firstValueFrom(this.http.get<PublicBrandingDto>(apiUrl('branding')));
  }

  /**
   * The caller's own theme.
   *
   * @returns The theme, or null for "use default".
   */
  myTheme(): Promise<MyThemeDto> {
    return firstValueFrom(this.http.get<MyThemeDto>(apiUrl('me/theme')));
  }

  /**
   * Sets or clears the caller's own theme.
   *
   * @param theme The theme, or null for "use default".
   * @returns The stored theme.
   */
  setMyTheme(theme: ThemeDto | null): Promise<MyThemeDto> {
    return firstValueFrom(
      theme === null
        ? this.http.delete<MyThemeDto>(apiUrl('me/theme'))
        : this.http.put<MyThemeDto>(apiUrl('me/theme'), theme),
    );
  }
}
