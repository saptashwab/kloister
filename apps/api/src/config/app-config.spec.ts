import { loadConfig } from './app-config.js';

describe('loadConfig', () => {
  const base = { DATABASE_URL: 'postgresql://db' };
  /** A complete server environment. */
  const production = {
    ...base,
    NODE_ENV: 'production',
    APP_NAME: 'tracker',
    ATTACHMENTS_DIR: '/srv/tracker/data/attachments',
    APP_DIR: '/srv/tracker',
    BRANDING_DIR: '/srv/tracker/data/branding',
    BACKUP_DIR: '/srv/tracker/backups/postgres',
    PG_DUMP_PATH: '/usr/pgsql-18/bin/pg_dump',
    LOG_DIR: '/srv/tracker/logs',
  };

  it('applies defaults', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      databaseUrl: 'postgresql://db',
      host: '127.0.0.1',
      port: 3000,
      cookiePath: '/',
      trustProxy: 'loopback',
      loginRateLimit: 10,
      loginRateWindowMs: 60_000,
    });
  });

  it('derives the cookie path from APP_NAME', () => {
    expect(loadConfig({ ...base, APP_NAME: 'tracker' }).cookiePath).toBe('/tracker/');
  });

  it('requires APP_NAME in production so the cookie path is never silently "/"', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/APP_NAME/);
    expect(loadConfig(production).cookiePath).toBe('/tracker/');
  });

  it('requires every server folder and pg_dump in production, with development fallbacks', () => {
    expect(loadConfig(production)).toMatchObject({
      appName: 'tracker',
      appDir: '/srv/tracker',
      brandingDir: '/srv/tracker/data/branding',
      backupsDir: '/srv/tracker/backups/postgres',
      pgDumpPath: '/usr/pgsql-18/bin/pg_dump',
      logDir: '/srv/tracker/logs',
    });
    for (const name of ['APP_DIR', 'BRANDING_DIR', 'BACKUP_DIR', 'PG_DUMP_PATH', 'LOG_DIR']) {
      expect(() => loadConfig({ ...production, [name]: '' })).toThrow(new RegExp(name));
      expect(() => loadConfig({ ...base, [name]: 'relative/path' })).toThrow(new RegExp(name));
    }
    const dev = loadConfig(base);
    expect(dev.brandingDir).toMatch(/kloister-dev-branding$/);
    expect(dev.backupsDir).toMatch(/kloister-dev-backups$/);
    expect(dev.pgDumpPath).toBe('pg_dump');
    expect(dev.logDir).toBeNull();
    expect(dev.appDir).toBe(process.cwd());
  });

  it('requires an absolute ATTACHMENTS_DIR in production, with a temporary folder in development', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', APP_NAME: 'tracker' })).toThrow(
      /ATTACHMENTS_DIR/,
    );
    expect(() => loadConfig({ ...base, ATTACHMENTS_DIR: 'data/attachments' })).toThrow(
      /ATTACHMENTS_DIR/,
    );
    expect(loadConfig({ ...base, ATTACHMENTS_DIR: '/srv/a' }).attachmentsDir).toBe('/srv/a');
    expect(loadConfig(base).attachmentsDir).toMatch(/kloister-dev-attachments$/);
  });

  it('rejects an APP_NAME that is not a safe path segment', () => {
    expect(() => loadConfig({ ...base, APP_NAME: '../etc' })).toThrow(/APP_NAME/);
    expect(() => loadConfig({ ...base, APP_NAME: 'Has Space' })).toThrow(/APP_NAME/);
  });

  it('reads LOG_LEVEL, defaulting to info', () => {
    expect(loadConfig(base).logLevel).toBe('info');
    expect(loadConfig({ ...base, LOG_LEVEL: 'warn' }).logLevel).toBe('warn');
    expect(() => loadConfig({ ...base, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('rejects non-positive or non-integer numbers', () => {
    expect(() => loadConfig({ ...base, BACKEND_PORT: 'abc' })).toThrow(/BACKEND_PORT/);
    expect(() => loadConfig({ ...base, LOGIN_RATE_LIMIT: '0' })).toThrow(/LOGIN_RATE_LIMIT/);
  });

  it('can disable proxy trust or name specific proxies', () => {
    expect(loadConfig({ ...base, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: '10.0.0.1' }).trustProxy).toBe('10.0.0.1');
  });
});
