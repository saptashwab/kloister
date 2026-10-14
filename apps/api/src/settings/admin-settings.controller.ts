import { Body, Controller, Get, Put } from '@nestjs/common';
import type {
  DiskUsageDto,
  LogSettingsDto,
  SecuritySettingsDto,
  StorageSettingsDto,
  ThemeDto,
} from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { AdminOnly, CurrentAuth } from '../auth/decorators.js';
import { AdminSettingsService } from './admin-settings.service.js';
import {
  LogSettingsBody,
  SecuritySettingsBody,
  StorageSettingsBody,
  ThemeBody,
} from './settings.dto.js';
import { SettingsService } from './settings.service.js';

/**
 * App settings under `/api/v1/admin/settings` (SPEC §6 Admin, §8):
 * security, storage and disk usage, log retention and the default theme.
 * Branding has its own controller; backups live under `admin/backups`.
 *
 * Permissions: every route is admin-only (others get 403); every change is
 * audited as `SETTINGS_UPDATED`.
 */
@Controller('admin/settings')
@AdminOnly()
export class AdminSettingsController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param settings Stored settings.
   * @param admin Changes and disk usage.
   */
  constructor(
    private readonly settings: SettingsService,
    private readonly admin: AdminSettingsService,
  ) {}

  /**
   * Returns the session and lockout settings in effect.
   *
   * @returns The settings.
   */
  @Get('security')
  getSecurity(): Promise<SecuritySettingsDto> {
    return this.settings.getSecurity();
  }

  /**
   * Replaces the session and lockout settings.
   *
   * @param auth The admin.
   * @param body Every setting; the absolute timeout at least the idle one.
   * @returns The saved settings.
   */
  @Put('security')
  putSecurity(
    @CurrentAuth() auth: AuthContext,
    @Body() body: SecuritySettingsBody,
  ): Promise<SecuritySettingsDto> {
    return this.admin.saveSecurity(auth, body);
  }

  /**
   * Returns the attachment limits in effect.
   *
   * @returns The limits.
   */
  @Get('storage')
  getStorage(): Promise<StorageSettingsDto> {
    return this.settings.getStorage();
  }

  /**
   * Replaces the attachment limits.
   *
   * @param auth The admin.
   * @param body Both limits; the quota at least the file size limit.
   * @returns The saved limits.
   */
  @Put('storage')
  putStorage(
    @CurrentAuth() auth: AuthContext,
    @Body() body: StorageSettingsBody,
  ): Promise<StorageSettingsDto> {
    return this.admin.saveStorage(auth, body);
  }

  /**
   * Measures the disk usage of the app's folder, attachments, backups and
   * logs, plus the free space of the disk.
   *
   * @returns The usage.
   */
  @Get('storage/usage')
  getUsage(): Promise<DiskUsageDto> {
    return this.admin.diskUsage();
  }

  /**
   * Returns the log retention in effect.
   *
   * @returns The retention.
   */
  @Get('logs')
  getLogs(): Promise<LogSettingsDto> {
    return this.settings.getLogs();
  }

  /**
   * Replaces the log retention.
   *
   * @param auth The admin.
   * @param body The retention in days.
   * @returns The saved retention.
   */
  @Put('logs')
  putLogs(
    @CurrentAuth() auth: AuthContext,
    @Body() body: LogSettingsBody,
  ): Promise<LogSettingsDto> {
    return this.admin.saveLogs(auth, body);
  }

  /**
   * Returns the default theme.
   *
   * @returns The theme.
   */
  @Get('theme')
  getTheme(): Promise<ThemeDto> {
    return this.settings.getTheme();
  }

  /**
   * Replaces the default theme.
   *
   * @param auth The admin.
   * @param body Mode and colours.
   * @returns The saved theme.
   */
  @Put('theme')
  putTheme(@CurrentAuth() auth: AuthContext, @Body() body: ThemeBody): Promise<ThemeDto> {
    return this.admin.saveTheme(auth, body);
  }
}
