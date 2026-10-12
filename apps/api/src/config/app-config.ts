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
  }) {
    this.databaseUrl = values.databaseUrl;
    this.host = values.host;
    this.port = values.port;
    this.cookiePath = values.cookiePath;
    this.trustProxy = values.trustProxy;
    this.loginRateLimit = values.loginRateLimit;
    this.loginRateWindowMs = values.loginRateWindowMs;
  }
}

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
  });
}
