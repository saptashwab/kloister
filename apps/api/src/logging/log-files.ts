import { join } from 'node:path';
import { Injectable, type LoggerService, type OnApplicationShutdown } from '@nestjs/common';
import { type DestinationStream, type Logger, pino } from 'pino';
import { AppConfig } from '../config/app-config.js';
import { DailyFileStream } from './daily-file.js';

/** Daily files of the backend log: `logs/backend/backend-<yyyy-mm-dd>.log`. */
export const BACKEND_LOG = { folder: 'backend', prefix: 'backend' } as const;

/** Daily files of the backup log: `logs/backups/backup-<yyyy-mm-dd>.log`. */
export const BACKUP_LOG = { folder: 'backups', prefix: 'backup' } as const;

/**
 * The app's pino loggers (SPEC §2): the backend log and the backup log, each
 * written to daily files under `LOG_DIR` (SPEC §9.1), or to standard output
 * when `LOG_DIR` is unset (local development). Entries are JSON lines;
 * nothing sensitive (passwords, tokens, cookies) is ever logged, and
 * requests are not logged one by one (httpd keeps the access log).
 */
@Injectable()
export class LogFiles implements OnApplicationShutdown {
  /** The backend log. */
  readonly backend: Logger;
  /** The backup log. */
  readonly backups: Logger;
  private readonly files: DailyFileStream[] = [];

  /**
   * Opens the loggers from the configuration.
   *
   * @param config Log folder and level.
   */
  constructor(config: AppConfig) {
    this.backend = pino({ level: config.logLevel }, this.destination(config, BACKEND_LOG));
    this.backups = pino({ level: config.logLevel }, this.destination(config, BACKUP_LOG));
  }

  /**
   * Flushes and closes the log files when the app stops.
   *
   * @returns Resolves once closed.
   */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.files.map((file) => file.end()));
  }

  /**
   * Picks where one log goes.
   *
   * @param config Log folder.
   * @param log Folder and file prefix.
   * @param log.folder Folder below the log directory.
   * @param log.prefix File name prefix.
   * @returns Daily files, or standard output.
   */
  private destination(
    config: AppConfig,
    log: { folder: string; prefix: string },
  ): DestinationStream {
    if (config.logDir === null) return pino.destination(1);
    const file = new DailyFileStream(join(config.logDir, log.folder), log.prefix);
    this.files.push(file);
    return file;
  }
}

/**
 * Nest's logger on top of pino, so framework messages (startup, errors
 * caught by the exception filter, scheduled jobs) land in the backend log.
 */
export class PinoNestLogger implements LoggerService {
  /**
   * Wraps a pino logger.
   *
   * @param logger The backend log.
   */
  constructor(private readonly logger: Logger) {}

  /**
   * Writes an info entry.
   *
   * @param message The message.
   * @param params Optional context name (last).
   */
  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  /**
   * Writes an error entry. Nest passes a stack trace before the context.
   *
   * @param message The message.
   * @param params Optional stack and context name.
   */
  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  /**
   * Writes a warning.
   *
   * @param message The message.
   * @param params Optional context name (last).
   */
  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  /**
   * Writes a debug entry.
   *
   * @param message The message.
   * @param params Optional context name (last).
   */
  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  /**
   * Writes a trace entry.
   *
   * @param message The message.
   * @param params Optional context name (last).
   */
  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }

  /**
   * Writes a fatal entry.
   *
   * @param message The message.
   * @param params Optional context name (last).
   */
  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  /**
   * Maps Nest's (message, ...params, context) call to one pino entry.
   *
   * @param level pino level.
   * @param message The message or an error.
   * @param params Extra parameters; a trailing string is the context.
   */
  private write(
    level: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace',
    message: unknown,
    params: unknown[],
  ): void {
    const rest = [...params];
    const context = typeof rest[rest.length - 1] === 'string' ? rest.pop() : undefined;
    const fields: Record<string, unknown> = {};
    if (context !== undefined) fields['context'] = context;
    const stack = rest.find((p): p is string => typeof p === 'string');
    if (stack !== undefined) fields['stack'] = stack;
    if (message instanceof Error) {
      fields['err'] = message;
      this.logger[level](fields, message.message);
    } else if (typeof message === 'object' && message !== null) {
      this.logger[level]({ ...fields, ...message });
    } else {
      this.logger[level](fields, String(message));
    }
  }
}
