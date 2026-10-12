import { loadConfig } from './app-config.js';

describe('loadConfig', () => {
  const base = { DATABASE_URL: 'postgresql://db' };

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
    expect(loadConfig({ ...base, NODE_ENV: 'production', APP_NAME: 'tracker' }).cookiePath).toBe(
      '/tracker/',
    );
  });

  it('rejects an APP_NAME that is not a safe path segment', () => {
    expect(() => loadConfig({ ...base, APP_NAME: '../etc' })).toThrow(/APP_NAME/);
    expect(() => loadConfig({ ...base, APP_NAME: 'Has Space' })).toThrow(/APP_NAME/);
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
