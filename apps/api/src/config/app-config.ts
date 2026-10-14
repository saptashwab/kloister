import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Runtime configuration for the backend, read once at startup from the
 * environment (`config/kloister.env` on the server, written by install.sh).
 *
 * Nothing here is hard-coded per deployment: paths, ports and the app name
 * all come from the environment (SPEC §11).
 */
export class AppConfig {
  /** Postgres connection string. */
  readonly databaseUrl: string;
  /** Interface to listen on; loopback by default because httpd is the only client. */
  readonly host: string;
  /** TCP port to listen on. */
  readonly port: number;
  /** Cookie `Path` attribute: `/<app_name>/`, or `/` when no app name is set. */
  readonly cookiePath: string;
  /**
   * Fastify `trustProxy` value. Only addresses listed here may set
   * `X-Forwarded-For`, so `request.ip` is the real client behind httpd and
   * cannot be spoofed by anyone else.
   */
  readonly trustProxy: string | false;
  /** Allowed login attempts per client IP per {@link loginRateWindowMs}. */
  readonly loginRateLimit: number;
  /** Window for {@link loginRateLimit}, in milliseconds. */
  readonly loginRateWindowMs: number;
  /**
   * Absolute directory holding attachments and inline images, one folder per
   * project (SPEC §5: `/app/<app_name>/data/attachments`, never under the web
   * root).
   */
  readonly attachmentsDir: string;
  /** The app name (`APP_NAME`), or empty in local development. Backup files are named after it. */
  readonly appName: string;
  /** The app's folder (`/app/<app_name>`), whose disk usage admins see (SPEC §6 storage). */
  readonly appDir: string;
  /** Absolute directory for the uploaded logo and font files, outside the web root. */
  readonly brandingDir: string;
  /** Absolute directory for database backups (SPEC §9.1 `backups/postgres`). */
  readonly backupsDir: string;
  /** The `pg_dump` binary; an absolute path on servers (`/usr/pgsql-<ver>/bin/pg_dump`). */
  readonly pgDumpPath: string;
  /**
   * Absolute directory holding `backend/` and `backups/` log folders (SPEC
   * §9.1 `logs/`), or null to log to standard output (local development).
   */
  readonly logDir: string | null;
  /** Lowest pino level written (`LOG_LEVEL`, default `info`). */
  readonly logLevel: LogLevel;

  /**
   * Wraps already-validated values; build instances with {@link loadConfig}.
   *
   * @param values Already-validated configuration values.
   */
  constructor(values: {
    databaseUrl: string;
    host: string;
    port: number;
    cookiePath: string;
    trustProxy: string | false;
    loginRateLimit: number;
    loginRateWindowMs: number;
    attachmentsDir: string;
    appName: string;
    appDir: string;
    brandingDir: string;
    backupsDir: string;
    pgDumpPath: string;
    logDir: string | null;
    logLevel: LogLevel;
  }) {
    this.databaseUrl = values.databaseUrl;
    this.host = values.host;
    this.port = values.port;
    this.cookiePath = values.cookiePath;
    this.trustProxy = values.trustProxy;
    this.loginRateLimit = values.loginRateLimit;
    this.loginRateWindowMs = values.loginRateWindowMs;
    this.attachmentsDir = values.attachmentsDir;
    this.appName = values.appName;
    this.appDir = values.appDir;
    this.brandingDir = values.brandingDir;
    this.backupsDir = values.backupsDir;
    this.pgDumpPath = values.pgDumpPath;
    this.logDir = values.logDir;
    this.logLevel = values.logLevel;
  }
}

/** Log levels accepted in `LOG_LEVEL`, most to least severe, plus `silent`. */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** One of the {@link LOG_LEVELS}. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Same rule install.sh applies to APP_NAME: it becomes a URL path segment and a Unix user name. */
const APP_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Parses a positive integer environment value.
 *
 * @param name Variable name, used in the error message.
 * @param raw Raw value, or undefined when unset.
 * @param fallback Value used when unset or empty.
 * @returns The parsed integer.
 */
function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/**
 * Parses `LOG_LEVEL`.
 *
 * @param raw Raw value, or undefined when unset.
 * @returns The level; `info` when unset.
 */
function logLevel(raw: string | undefined): LogLevel {
  if (raw === undefined || raw === '') return 'info';
  const level = LOG_LEVELS.find((l) => l === raw);
  if (level === undefined) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${raw}"`);
  }
  return level;
}

/**
 * Reads an absolute folder (or file) path. Servers must set it (install.sh
 * writes it to `kloister.env`); only local development falls back.
 *
 * @param env Environment to read.
 * @param name Variable name.
 * @param fallback Value used in development when unset, or null for none.
 * @returns The path, or the fallback.
 */
function serverPath(env: NodeJS.ProcessEnv, name: string, fallback: string | null): string | null {
  const value = env[name] ?? '';
  if (value === '' && env['NODE_ENV'] === 'production') {
    throw new Error(`${name} must be set when NODE_ENV=production`);
  }
  if (value !== '' && !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path, got "${value}"`);
  }
  return value === '' ? fallback : value;
}

/**
 * Builds and validates the configuration from environment variables.
 * Throws on invalid values so a misconfigured server fails at startup rather
 * than at the first request.
 *
 * @param env Environment to read; defaults to `process.env`.
 * @returns The validated configuration.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env['DATABASE_URL'] ?? '';
  if (databaseUrl === '') {
    throw new Error('DATABASE_URL is not set');
  }

  const appName = env['APP_NAME'] ?? '';
  if (appName !== '' && !APP_NAME_PATTERN.test(appName)) {
    throw new Error(`APP_NAME must match ${String(APP_NAME_PATTERN)}, got "${appName}"`);
  }
  // Without APP_NAME the session cookie would be scoped to "/" instead of
  // "/<app_name>/" (SPEC §5). That is fine for local development but must
  // never happen silently on a server.
  if (appName === '' && env['NODE_ENV'] === 'production') {
    throw new Error('APP_NAME must be set when NODE_ENV=production');
  }

  // Uploaded files must land in the server's data folder, set by install.sh;
  // only local development may fall back to a temporary folder.
  const attachmentsDir = env['ATTACHMENTS_DIR'] ?? '';
  if (attachmentsDir === '' && env['NODE_ENV'] === 'production') {
    throw new Error('ATTACHMENTS_DIR must be set when NODE_ENV=production');
  }
  if (attachmentsDir !== '' && !isAbsolute(attachmentsDir)) {
    throw new Error(`ATTACHMENTS_DIR must be an absolute path, got "${attachmentsDir}"`);
  }

  // Default to trusting only loopback: httpd runs on the same host and
  // proxies from 127.0.0.1 (SPEC §9.4). "false" disables proxy trust.
  const rawTrust = env['TRUST_PROXY'] ?? 'loopback';
  const trustProxy = rawTrust === 'false' || rawTrust === '' ? false : rawTrust;

  return new AppConfig({
    databaseUrl,
    host: env['BACKEND_HOST'] || '127.0.0.1',
    port: positiveInt('BACKEND_PORT', env['BACKEND_PORT'], 3000),
    cookiePath: appName === '' ? '/' : `/${appName}/`,
    trustProxy,
    loginRateLimit: positiveInt('LOGIN_RATE_LIMIT', env['LOGIN_RATE_LIMIT'], 10),
    loginRateWindowMs:
      positiveInt('LOGIN_RATE_WINDOW_SECONDS', env['LOGIN_RATE_WINDOW_SECONDS'], 60) * 1000,
    attachmentsDir:
      attachmentsDir === '' ? join(tmpdir(), 'kloister-dev-attachments') : attachmentsDir,
    appName,
    // Development falls back to the working folder and temporary folders,
    // so nothing lands in a real server path by accident.
    appDir: serverPath(env, 'APP_DIR', process.cwd()) ?? process.cwd(),
    brandingDir:
      serverPath(env, 'BRANDING_DIR', join(tmpdir(), 'kloister-dev-branding')) ?? tmpdir(),
    backupsDir: serverPath(env, 'BACKUP_DIR', join(tmpdir(), 'kloister-dev-backups')) ?? tmpdir(),
    // A bare `pg_dump` is looked up on PATH; servers name the PGDG binary
    // of the cluster's major version, since pg_dump refuses newer servers.
    pgDumpPath: serverPath(env, 'PG_DUMP_PATH', null) ?? 'pg_dump',
    logDir: serverPath(env, 'LOG_DIR', null),
    logLevel: logLevel(env['LOG_LEVEL']),
  });
}
