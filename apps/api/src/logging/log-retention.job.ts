import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AppConfig } from '../config/app-config.js';
import { SettingsService } from '../settings/settings.service.js';
import { pruneDailyFiles } from './daily-file.js';
import { BACKEND_LOG, BACKUP_LOG } from './log-files.js';

/**
 * Deletes backend and backup log files older than the admin's retention
 * (SPEC §6 logs, §9.5: the app rotates and cleans `logs/backend` itself).
 * Runs every night at 03:45 server time. Install logs are left alone.
 */
@Injectable()
export class LogRetentionJob {
  private readonly logger = new Logger(LogRetentionJob.name);

  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param config The log folder.
   * @param settings The retention setting.
   */
  constructor(
    private readonly config: AppConfig,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Applies the retention setting to both daily log folders.
   *
   * @param now The current time (tests pass one).
   * @returns Names of the deleted files.
   */
  @Cron('0 45 3 * * *')
  async run(now: Date = new Date()): Promise<string[]> {
    if (this.config.logDir === null) return [];
    const { retentionDays } = await this.settings.getLogs();
    const deleted: string[] = [];
    for (const log of [BACKEND_LOG, BACKUP_LOG]) {
      const dir = join(this.config.logDir, log.folder);
      deleted.push(...(await pruneDailyFiles(dir, log.prefix, retentionDays, now)));
    }
    if (deleted.length > 0) {
      this.logger.log(`Deleted ${deleted.length} log files older than ${retentionDays} days`);
    }
    return deleted;
  }
}
