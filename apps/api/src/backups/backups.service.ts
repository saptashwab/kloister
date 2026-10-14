import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  AuditAction,
  type BackupFileDto,
  type BackupRunDto,
  type BackupSettingsDto,
  type BackupsDto,
  BackupTrigger,
  ErrorCode,
} from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { AuditService } from '../audit/audit.service.js';
import { conflict } from '../common/api-exception.js';
import { AppConfig } from '../config/app-config.js';
import { localDate } from '../logging/daily-file.js';
import { LogFiles } from '../logging/log-files.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BACKUP_SETTINGS_KEY, SettingsService } from '../settings/settings.service.js';
import {
  backupFileName,
  backupFileTime,
  type CommandRunner,
  pgDumpArgs,
  pgDumpEnvironment,
} from './pg-dump.js';

/** Injection token of the {@link CommandRunner} that starts pg_dump. */
export const COMMAND_RUNNER = Symbol('COMMAND_RUNNER');

/** Runs listed on the backups screen. */
const RUNS_SHOWN = 10;

/** pg_dump is killed after this long. */
const DUMP_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Longest failure reason kept in the audit log. */
const ERROR_MAX = 500;

/** Suffix of a dump still being written. */
const PARTIAL = '.partial';

/**
 * The next time a daily `HH:MM` comes round, in server-local time.
 *
 * @param time `HH:MM`.
 * @param now The current time.
 * @returns Today at that time if still ahead, otherwise tomorrow.
 */
export function nextDailyRun(time: string, now: Date): Date {
  const [hours, minutes] = time.split(':').map(Number);
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/**
 * Postgres backups (SPEC §6 Admin backups, §9.1): a daily `pg_dump -Fc` at
 * the admin's time into `BACKUP_DIR`, as `<app_name>-<yyyymmdd-hhmmss>.dump`,
 * plus "run now". After each successful backup, backups older than the
 * retention are deleted. Each result is audited (`BACKUP_SUCCEEDED` or
 * `BACKUP_FAILED`), which is where the screen's last results come from, and
 * written to the backup log (`logs/backups/backup-<yyyy-mm-dd>.log`).
 *
 * The pg_dump binary comes from `PG_DUMP_PATH`; credentials from the
 * environment or `.pgpass` (see {@link pgDumpEnvironment}). One backup runs
 * at a time. Attachments are files, not database rows, and are not included.
 *
 * Permissions: the endpoints using this are admin-only.
 */
@Injectable()
export class BackupsService {
  private running = false;
  /** `YYYY-MM-DD HH:MM` of the last scheduled start, so a minute never starts two. */
  private lastScheduled = '';

  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access (the audit log).
   * @param settings The schedule.
   * @param audit Audit log.
   * @param config Folders, pg_dump and the database URL.
   * @param logs The backup log.
   * @param runCommand Starts pg_dump.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    private readonly logs: LogFiles,
    @Inject(COMMAND_RUNNER) private readonly runCommand: CommandRunner,
  ) {}

  /**
   * True while a backup is running.
   *
   * @returns The state.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Everything the backups screen shows.
   *
   * @param now The current time.
   * @returns Schedule, state, last results and files.
   */
  async status(now: Date = new Date()): Promise<BackupsDto> {
    const settings = await this.settings.getBackups();
    const [runs, files] = await Promise.all([this.runs(), this.files()]);
    return {
      settings,
      running: this.running,
      nextRunAt: settings.enabled ? nextDailyRun(settings.time, now).toISOString() : null,
      runs,
      files,
      folder: this.config.backupsDir,
    };
  }

  /**
   * Saves the schedule, audited as `SETTINGS_UPDATED`.
   *
   * @param auth The admin.
   * @param value The schedule.
   * @returns The screen's data.
   */
  async saveSettings(auth: AuthContext, value: BackupSettingsDto): Promise<BackupsDto> {
    const saved = { enabled: value.enabled, time: value.time, retentionDays: value.retentionDays };
    await this.prisma.$transaction(async (tx) => {
      await this.settings.save(BACKUP_SETTINGS_KEY, saved, tx);
      await this.audit.record(
        {
          actorId: auth.user.id,
          action: AuditAction.SETTINGS_UPDATED,
          entityType: 'AppSetting',
          meta: { key: BACKUP_SETTINGS_KEY, value: saved },
        },
        tx,
      );
    });
    return this.status();
  }

  /**
   * Starts a backup now ("run now"), audited as `BACKUP_REQUESTED`. The
   * request returns at once; the screen polls for the result.
   *
   * @param auth The admin.
   * @returns The screen's data, `running` true; 409 `BACKUP_RUNNING` when
   *   one is already running.
   */
  async requestRun(auth: AuthContext): Promise<BackupsDto> {
    // Claimed before anything is awaited, so two requests cannot both start.
    if (this.running) throw conflict('A backup is already running', ErrorCode.BACKUP_RUNNING);
    this.running = true;
    try {
      await this.audit.record({
        actorId: auth.user.id,
        action: AuditAction.BACKUP_REQUESTED,
        entityType: 'Backup',
      });
    } catch (error) {
      this.running = false;
      throw error;
    }
    // Not awaited: pg_dump may run for minutes; execute() records its own result.
    void this.execute(BackupTrigger.MANUAL, auth.user.id);
    return this.status();
  }

  /**
   * Checks the schedule every minute and starts the daily backup when its
   * time comes. Reading the setting each minute means a new time applies at
   * once, with no job to reschedule.
   *
   * @param now The current time (tests pass one).
   * @returns True when a backup was started.
   */
  @Cron('0 * * * * *')
  async tick(now: Date = new Date()): Promise<boolean> {
    const settings = await this.settings.getBackups();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const key = `${localDate(now)} ${time}`;
    if (!settings.enabled || settings.time !== time || this.lastScheduled === key) return false;
    if (this.running) {
      this.logs.backups.warn('Scheduled backup skipped: another backup is still running');
      return false;
    }
    this.lastScheduled = key;
    await this.run(BackupTrigger.SCHEDULED, null);
    return true;
  }

  /**
   * Runs one backup: pg_dump into a `.partial` file, renamed into place on
   * success, then the retention clean-up. Never throws; the outcome is
   * audited and logged.
   *
   * @param trigger Schedule or "run now".
   * @param actorId The admin who asked, or null for the schedule.
   * @returns The audited result.
   */
  async run(trigger: BackupTrigger, actorId: string | null): Promise<BackupRunDto | null> {
    if (this.running) return null;
    this.running = true;
    return this.execute(trigger, actorId);
  }

  /**
   * The body of {@link run}, for a caller that already holds the running
   * flag; clears it when done.
   *
   * @param trigger Schedule or "run now".
   * @param actorId The admin who asked, or null for the schedule.
   * @returns The audited result.
   */
  private async execute(
    trigger: BackupTrigger,
    actorId: string | null,
  ): Promise<BackupRunDto | null> {
    const startedAt = new Date();
    const name = backupFileName(this.config.appName, startedAt);
    const target = join(this.config.backupsDir, name);
    const log = this.logs.backups.child({ trigger, file: name });
    log.info('Backup started');
    try {
      let sizeBytes: number;
      try {
        await mkdir(this.config.backupsDir, { recursive: true, mode: 0o750 });
        const result = await this.runCommand(
          this.config.pgDumpPath,
          pgDumpArgs(target + PARTIAL),
          pgDumpEnvironment(this.config.databaseUrl),
          DUMP_TIMEOUT_MS,
        );
        if (result.code !== 0) {
          const reason = result.stderr === '' ? 'no error output' : result.stderr;
          throw new Error(
            result.code === null
              ? `pg_dump was stopped (${reason})`
              : `pg_dump exited with code ${result.code}: ${reason}`,
          );
        }
        await rename(target + PARTIAL, target);
        sizeBytes = (await stat(target)).size;
      } catch (error) {
        await rm(target + PARTIAL, { force: true }).catch(() => undefined);
        const message = (error instanceof Error ? error.message : String(error)).slice(
          0,
          ERROR_MAX,
        );
        log.error({ err: error }, 'Backup failed');
        return await this.record(trigger, actorId, startedAt, {
          succeeded: false,
          error: message,
        });
      }
      const { retentionDays } = await this.settings.getBackups();
      const pruned = await this.prune(retentionDays, startedAt, name);
      log.info({ sizeBytes, pruned }, 'Backup finished');
      return await this.record(trigger, actorId, startedAt, {
        succeeded: true,
        file: name,
        sizeBytes,
        pruned,
      });
    } catch (error) {
      // Only the audit write or the clean-up can get here.
      log.error({ err: error }, 'Backup bookkeeping failed');
      return null;
    } finally {
      this.running = false;
    }
  }

  /**
   * Deletes this app's backups older than the retention, by the time in
   * their names. The backup just made is always kept, and files of other
   * names are never touched.
   *
   * @param retentionDays Days to keep.
   * @param now The current time.
   * @param keep The newest backup's name.
   * @returns Names of the deleted files.
   */
  async prune(retentionDays: number, now: Date, keep: string): Promise<string[]> {
    const prefix = this.prefix();
    const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
    const deleted: string[] = [];
    let names: string[];
    try {
      names = await readdir(this.config.backupsDir);
    } catch {
      return deleted;
    }
    for (const name of names) {
      const time = backupFileTime(name, prefix);
      if (name === keep || time === null || time.getTime() >= cutoff) continue;
      try {
        await rm(join(this.config.backupsDir, name), { force: true });
        deleted.push(name);
        this.logs.backups.info({ file: name }, 'Old backup deleted');
      } catch (error) {
        this.logs.backups.warn({ err: error, file: name }, 'Could not delete an old backup');
      }
    }
    return deleted.sort();
  }

  /**
   * Audits a finished backup.
   *
   * @param trigger Schedule or "run now".
   * @param actorId The admin who asked, or null.
   * @param startedAt When it started.
   * @param outcome What happened.
   * @param outcome.succeeded Whether pg_dump succeeded.
   * @param outcome.file The backup file.
   * @param outcome.sizeBytes Its size.
   * @param outcome.pruned Old backups deleted.
   * @param outcome.error Why it failed.
   * @returns The run as the screen lists it.
   */
  private async record(
    trigger: BackupTrigger,
    actorId: string | null,
    startedAt: Date,
    outcome: {
      succeeded: boolean;
      file?: string;
      sizeBytes?: number;
      pruned?: string[];
      error?: string;
    },
  ): Promise<BackupRunDto> {
    const finishedAt = new Date();
    const meta = {
      trigger,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      ...(outcome.file === undefined ? {} : { file: outcome.file }),
      ...(outcome.sizeBytes === undefined ? {} : { sizeBytes: outcome.sizeBytes }),
      ...(outcome.pruned === undefined ? {} : { pruned: outcome.pruned }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    };
    const entry = await this.prisma.auditLog.create({
      data: {
        actorId,
        action: outcome.succeeded ? AuditAction.BACKUP_SUCCEEDED : AuditAction.BACKUP_FAILED,
        entityType: 'Backup',
        meta,
      },
    });
    return toRun(entry.id, entry.action, meta);
  }

  /**
   * The latest results, from the audit log.
   *
   * @returns Up to ten runs, newest first.
   */
  private async runs(): Promise<BackupRunDto[]> {
    const entries = await this.prisma.auditLog.findMany({
      where: { action: { in: [AuditAction.BACKUP_SUCCEEDED, AuditAction.BACKUP_FAILED] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: RUNS_SHOWN,
    });
    return entries.map((e) => toRun(e.id, e.action, e.meta));
  }

  /**
   * This app's backup files, newest first.
   *
   * @returns The files.
   */
  private async files(): Promise<BackupFileDto[]> {
    const prefix = this.prefix();
    let names: string[];
    try {
      names = await readdir(this.config.backupsDir);
    } catch {
      return [];
    }
    const files: BackupFileDto[] = [];
    for (const name of names) {
      if (backupFileTime(name, prefix) === null) continue;
      try {
        const info = await stat(join(this.config.backupsDir, name));
        files.push({ name, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() });
      } catch {
        // Deleted meanwhile.
      }
    }
    // The names hold the start time, so they sort by age.
    return files.sort((a, b) => b.name.localeCompare(a.name));
  }

  /**
   * The file name prefix of this app's backups.
   *
   * @returns The app name, or `backup`.
   */
  private prefix(): string {
    return this.config.appName === '' ? 'backup' : this.config.appName;
  }
}

/**
 * Reads a backup result from an audit entry's meta.
 *
 * @param id The entry id.
 * @param action `BACKUP_SUCCEEDED` or `BACKUP_FAILED`.
 * @param meta The entry's meta.
 * @returns The run.
 */
function toRun(id: string, action: string, meta: unknown): BackupRunDto {
  const m = (typeof meta === 'object' && meta !== null ? meta : {}) as Record<string, unknown>;
  const text = (key: string): string | null => (typeof m[key] === 'string' ? m[key] : null);
  return {
    id,
    trigger: m['trigger'] === BackupTrigger.MANUAL ? BackupTrigger.MANUAL : BackupTrigger.SCHEDULED,
    succeeded: action === AuditAction.BACKUP_SUCCEEDED,
    startedAt: text('startedAt') ?? '',
    finishedAt: text('finishedAt') ?? '',
    file: text('file'),
    sizeBytes: typeof m['sizeBytes'] === 'number' ? m['sizeBytes'] : null,
    error: text('error'),
    pruned: Array.isArray(m['pruned']) ? m['pruned'].length : 0,
  };
}
