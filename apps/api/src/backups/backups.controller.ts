import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import type { BackupsDto } from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { AdminOnly, CurrentAuth } from '../auth/decorators.js';
import { BackupSettingsBody } from '../settings/settings.dto.js';
import { BackupsService } from './backups.service.js';

/**
 * Database backups under `/api/v1/admin/backups` (SPEC §6 Admin, §8):
 * the schedule, last results, the backup files and "run now".
 *
 * Permissions: admin-only (others get 403); changes and runs are audited.
 */
@Controller('admin/backups')
@AdminOnly()
export class BackupsController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param backups Backup logic.
   */
  constructor(private readonly backups: BackupsService) {}

  /**
   * Returns the schedule, whether a backup is running, the last results and
   * the backup files.
   *
   * @returns The backups screen's data.
   */
  @Get()
  get(): Promise<BackupsDto> {
    return this.backups.status();
  }

  /**
   * Replaces the schedule.
   *
   * @param auth The admin.
   * @param body Enabled, time and retention.
   * @returns The backups screen's data.
   */
  @Put('settings')
  putSettings(
    @CurrentAuth() auth: AuthContext,
    @Body() body: BackupSettingsBody,
  ): Promise<BackupsDto> {
    return this.backups.saveSettings(auth, body);
  }

  /**
   * Starts a backup now; the result appears in the last results.
   *
   * @param auth The admin.
   * @returns 202 with the screen's data; 409 `BACKUP_RUNNING` if one is running.
   */
  @Post('run')
  @HttpCode(HttpStatus.ACCEPTED)
  run(@CurrentAuth() auth: AuthContext): Promise<BackupsDto> {
    return this.backups.requestRun(auth);
  }
}
