import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import {
  AuditAction,
  type DiskUsageDto,
  type LogSettingsDto,
  type SecuritySettingsDto,
  type StorageSettingsDto,
  type ThemeDto,
} from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { AuditService } from '../audit/audit.service.js';
import { invalidField } from '../common/api-exception.js';
import { AppConfig } from '../config/app-config.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { diskSpace, folderUsage } from './disk-usage.js';
import {
  LOG_SETTINGS_KEY,
  SECURITY_SETTINGS_KEY,
  SettingsService,
  STORAGE_SETTINGS_KEY,
  THEME_SETTINGS_KEY,
} from './settings.service.js';

/**
 * The admin settings screens' logic (SPEC §6 Admin): security, storage with
 * disk usage, log retention and the default theme. Every change is stored
 * and audited (`SETTINGS_UPDATED`, with the new value) in one transaction.
 *
 * Permissions: callers are admins; the controller is `@AdminOnly()`.
 */
@Injectable()
export class AdminSettingsService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param settings Stored settings.
   * @param audit Audit log.
   * @param config Folder locations.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Saves the session and lockout settings. The idle timeout takes effect
   * at once; a new absolute timeout applies to sessions started afterwards,
   * since each session's end is fixed at sign-in (SPEC §5).
   *
   * @param auth The admin.
   * @param value The new settings.
   * @returns The saved settings.
   */
  async saveSecurity(auth: AuthContext, value: SecuritySettingsDto): Promise<SecuritySettingsDto> {
    if (value.absoluteTimeoutMinutes < value.idleTimeoutMinutes) {
      throw invalidField(
        'absoluteTimeoutMinutes',
        'The absolute timeout must be at least the idle timeout',
      );
    }
    const saved: SecuritySettingsDto = {
      idleTimeoutMinutes: value.idleTimeoutMinutes,
      absoluteTimeoutMinutes: value.absoluteTimeoutMinutes,
      lockoutThreshold: value.lockoutThreshold,
      lockoutMinutes: value.lockoutMinutes,
    };
    await this.store(auth, SECURITY_SETTINGS_KEY, { ...saved });
    return saved;
  }

  /**
   * Saves the attachment limits. They apply to the next upload; files
   * already stored are kept even when a project is now over its quota.
   *
   * @param auth The admin.
   * @param value The new limits.
   * @returns The saved limits.
   */
  async saveStorage(auth: AuthContext, value: StorageSettingsDto): Promise<StorageSettingsDto> {
    if (value.projectQuotaMb < value.maxFileSizeMb) {
      throw invalidField(
        'projectQuotaMb',
        'The project quota must be at least the file size limit',
      );
    }
    const saved: StorageSettingsDto = {
      maxFileSizeMb: value.maxFileSizeMb,
      projectQuotaMb: value.projectQuotaMb,
    };
    await this.store(auth, STORAGE_SETTINGS_KEY, { ...saved });
    return saved;
  }

  /**
   * Saves the log retention; the nightly clean-up applies it.
   *
   * @param auth The admin.
   * @param value The new retention.
   * @returns The saved retention.
   */
  async saveLogs(auth: AuthContext, value: LogSettingsDto): Promise<LogSettingsDto> {
    const saved: LogSettingsDto = { retentionDays: value.retentionDays };
    await this.store(auth, LOG_SETTINGS_KEY, { ...saved });
    return saved;
  }

  /**
   * Saves the default theme, used by everyone without a theme of their own
   * and on the sign-in page.
   *
   * @param auth The admin.
   * @param value The new theme.
   * @returns The saved theme, colours upper case.
   */
  async saveTheme(auth: AuthContext, value: ThemeDto): Promise<ThemeDto> {
    const saved: ThemeDto = {
      mode: value.mode,
      primary: value.primary.toUpperCase(),
      accent: value.accent.toUpperCase(),
    };
    await this.store(auth, THEME_SETTINGS_KEY, { ...saved });
    return saved;
  }

  /**
   * Measures the disk usage of the app's folder and the folders inside it
   * that grow (SPEC §6 storage). Walks the folders on each call; they hold
   * thousands of files at most.
   *
   * @returns Sizes and the file system's free space.
   */
  async diskUsage(): Promise<DiskUsageDto> {
    const logs = this.config.logDir ?? join(this.config.appDir, 'logs');
    const [app, attachments, backups, logUsage, disk] = await Promise.all([
      folderUsage(this.config.appDir),
      folderUsage(this.config.attachmentsDir),
      folderUsage(this.config.backupsDir),
      folderUsage(logs),
      diskSpace(this.config.appDir),
    ]);
    return {
      app,
      attachments,
      backups,
      logs: logUsage,
      disk,
      measuredAt: new Date().toISOString(),
    };
  }

  /**
   * Stores a settings value and audits it, atomically.
   *
   * @param auth The admin.
   * @param key `AppSetting.key`.
   * @param value The value; recorded in full, so it must hold no secrets.
   * @returns Resolves once stored.
   */
  private async store(
    auth: AuthContext,
    key: string,
    value: Prisma.InputJsonObject,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.settings.save(key, value, tx);
      await this.audit.record(
        {
          actorId: auth.user.id,
          action: AuditAction.SETTINGS_UPDATED,
          entityType: 'AppSetting',
          meta: { key, value },
        },
        tx,
      );
    });
  }
}
