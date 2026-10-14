import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import {
  type BackupSettingsDto,
  type BackupsDto,
  type BrandingSettingsDto,
  type DiskUsageDto,
  FILE_NAME_HEADER,
  type FontWeight,
  type LogSettingsDto,
  type MyThemeDto,
  type PublicBrandingDto,
  type SecuritySettingsDto,
  type StorageSettingsDto,
  type ThemeDto,
  type UpdateBrandingRequest,
  type UpdateMeRequest,
  UPLOAD_CONTENT_TYPE,
  type UserDto,
} from '@kloister/shared';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from './api';

/**
 * Client for settings (SPEC §6): the public branding, the caller's own
 * profile and theme, and the admin settings, branding and backups. Admin
 * routes answer 403 to everyone else; the UI hides them as well. Logo and
 * font uploads send the raw file with its name in the `x-file-name` header;
 * the API checks their type by content.
 */
@Injectable({ providedIn: 'root' })
export class SettingsApiService {
  private readonly http = inject(HttpClient);

  /**
   * The app name, logo, font and default theme; needs no session.
   *
   * @returns The public branding.
   */
  publicBranding(): Promise<PublicBrandingDto> {
    return this.get('branding');
  }

  /**
   * Changes the caller's display name.
   *
   * @param request The new name.
   * @returns The updated user.
   */
  updateMe(request: UpdateMeRequest): Promise<UserDto> {
    return firstValueFrom(this.http.patch<UserDto>(apiUrl('me'), request));
  }

  /**
   * The caller's own theme.
   *
   * @returns The theme, or null for "use default".
   */
  myTheme(): Promise<MyThemeDto> {
    return this.get('me/theme');
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

  /**
   * Session and lockout settings.
   *
   * @returns The settings.
   */
  security(): Promise<SecuritySettingsDto> {
    return this.get('admin/settings/security');
  }

  /**
   * Replaces the session and lockout settings.
   *
   * @param value Every setting.
   * @returns The saved settings.
   */
  saveSecurity(value: SecuritySettingsDto): Promise<SecuritySettingsDto> {
    return this.put('admin/settings/security', value);
  }

  /**
   * Attachment limits.
   *
   * @returns The limits.
   */
  storage(): Promise<StorageSettingsDto> {
    return this.get('admin/settings/storage');
  }

  /**
   * Replaces the attachment limits.
   *
   * @param value Both limits.
   * @returns The saved limits.
   */
  saveStorage(value: StorageSettingsDto): Promise<StorageSettingsDto> {
    return this.put('admin/settings/storage', value);
  }

  /**
   * Measures the disk usage of the app's folders.
   *
   * @returns The usage.
   */
  diskUsage(): Promise<DiskUsageDto> {
    return this.get('admin/settings/storage/usage');
  }

  /**
   * The log retention.
   *
   * @returns The retention.
   */
  logs(): Promise<LogSettingsDto> {
    return this.get('admin/settings/logs');
  }

  /**
   * Replaces the log retention.
   *
   * @param value The retention.
   * @returns The saved retention.
   */
  saveLogs(value: LogSettingsDto): Promise<LogSettingsDto> {
    return this.put('admin/settings/logs', value);
  }

  /**
   * The admin's default theme.
   *
   * @returns The theme.
   */
  defaultTheme(): Promise<ThemeDto> {
    return this.get('admin/settings/theme');
  }

  /**
   * Replaces the default theme.
   *
   * @param value The theme.
   * @returns The saved theme.
   */
  saveDefaultTheme(value: ThemeDto): Promise<ThemeDto> {
    return this.put('admin/settings/theme', value);
  }

  /**
   * The branding settings.
   *
   * @returns Name, font and uploaded files.
   */
  branding(): Promise<BrandingSettingsDto> {
    return this.get('admin/settings/branding');
  }

  /**
   * Saves the app name and the font.
   *
   * @param value Name and font.
   * @returns The branding settings.
   */
  saveBranding(value: UpdateBrandingRequest): Promise<BrandingSettingsDto> {
    return this.put('admin/settings/branding', value);
  }

  /**
   * Uploads the logo.
   *
   * @param file The image.
   * @returns The branding settings.
   */
  uploadLogo(file: File): Promise<BrandingSettingsDto> {
    return this.upload('admin/settings/branding/logo', file);
  }

  /**
   * Removes the logo.
   *
   * @returns The branding settings.
   */
  removeLogo(): Promise<BrandingSettingsDto> {
    return firstValueFrom(
      this.http.delete<BrandingSettingsDto>(apiUrl('admin/settings/branding/logo')),
    );
  }

  /**
   * Uploads a font file.
   *
   * @param weight Regular or bold.
   * @param file The font.
   * @returns The branding settings.
   */
  uploadFont(weight: FontWeight, file: File): Promise<BrandingSettingsDto> {
    return this.upload(`admin/settings/branding/fonts/${weight}`, file);
  }

  /**
   * Removes a font file (the regular one takes the bold one with it).
   *
   * @param weight Regular or bold.
   * @returns The branding settings.
   */
  removeFont(weight: FontWeight): Promise<BrandingSettingsDto> {
    return firstValueFrom(
      this.http.delete<BrandingSettingsDto>(apiUrl(`admin/settings/branding/fonts/${weight}`)),
    );
  }

  /**
   * The backup schedule, state, last results and files.
   *
   * @returns The backups screen's data.
   */
  backups(): Promise<BackupsDto> {
    return this.get('admin/backups');
  }

  /**
   * Replaces the backup schedule.
   *
   * @param value The schedule.
   * @returns The backups screen's data.
   */
  saveBackupSettings(value: BackupSettingsDto): Promise<BackupsDto> {
    return this.put('admin/backups/settings', value);
  }

  /**
   * Starts a backup now.
   *
   * @returns The backups screen's data, running.
   */
  runBackup(): Promise<BackupsDto> {
    return firstValueFrom(this.http.post<BackupsDto>(apiUrl('admin/backups/run'), {}));
  }

  /**
   * Sends a GET.
   *
   * @param path Path below `/api/v1`.
   * @returns The body.
   */
  private get<T>(path: string): Promise<T> {
    return firstValueFrom(this.http.get<T>(apiUrl(path)));
  }

  /**
   * Sends a PUT with a JSON body.
   *
   * @param path Path below `/api/v1`.
   * @param body The body.
   * @returns The response body.
   */
  private put<T>(path: string, body: object): Promise<T> {
    return firstValueFrom(this.http.put<T>(apiUrl(path), body));
  }

  /**
   * Uploads a raw file with PUT.
   *
   * @param path Path below `/api/v1`.
   * @param file The file.
   * @returns The response body.
   */
  private upload<T>(path: string, file: File): Promise<T> {
    return firstValueFrom(
      this.http.put<T>(apiUrl(path), file, {
        headers: {
          'Content-Type': UPLOAD_CONTENT_TYPE,
          [FILE_NAME_HEADER]: encodeURIComponent(file.name || 'file'),
        },
      }),
    );
  }
}
