import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  ErrorCode,
  type ErrorResponse,
  FILE_NAME_HEADER,
  UPLOAD_CONTENT_TYPE,
} from '@kloister/shared';
import { createApp } from '../src/app.factory.js';

// HTTP-level security checks that stop before any database query, so they
// run locally without Postgres. Full flows live in test/db/.

const CSRF = { [CSRF_HEADER]: CSRF_HEADER_VALUE };
const SOME_ID = '00000000-0000-4000-8000-000000000000';
const errorOf = (res: { json: () => unknown }) => res.json() as ErrorResponse;

describe('API security without a session (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env['LOGIN_RATE_LIMIT'] = '3';
    app = await createApp({ logger: false });
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env['LOGIN_RATE_LIMIT'];
  });

  // Permission tests: every non-public route rejects anonymous callers.
  it.each([
    ['GET', '/api/v1/me'],
    ['GET', '/api/v1/me/work'],
    ['GET', '/api/v1/me/personal'],
    ['POST', '/api/v1/me/personal'],
    ['PATCH', '/api/v1/me'],
    ['POST', '/api/v1/auth/logout'],
    ['POST', '/api/v1/auth/change-password'],
    ['GET', '/api/v1/admin/users'],
    ['GET', `/api/v1/admin/users/${SOME_ID}`],
    ['POST', '/api/v1/admin/users'],
    ['PATCH', `/api/v1/admin/users/${SOME_ID}`],
    ['POST', `/api/v1/admin/users/${SOME_ID}/reset-password`],
    ['GET', '/api/v1/admin/audit'],
    ['GET', '/api/v1/projects'],
    ['GET', `/api/v1/users/${SOME_ID}/work`],
    ['POST', '/api/v1/projects'],
    ['GET', `/api/v1/projects/${SOME_ID}`],
    ['GET', '/api/v1/projects/KLO'],
    ['PATCH', `/api/v1/projects/${SOME_ID}`],
    ['POST', `/api/v1/projects/${SOME_ID}/archive`],
    ['POST', `/api/v1/projects/${SOME_ID}/unarchive`],
    ['GET', `/api/v1/projects/${SOME_ID}/members`],
    ['GET', `/api/v1/projects/${SOME_ID}/member-candidates`],
    ['POST', `/api/v1/projects/${SOME_ID}/members`],
    ['PATCH', `/api/v1/projects/${SOME_ID}/members/${SOME_ID}`],
    ['DELETE', `/api/v1/projects/${SOME_ID}/members/${SOME_ID}`],
    ['GET', `/api/v1/projects/${SOME_ID}/teams`],
    ['POST', `/api/v1/projects/${SOME_ID}/teams`],
    ['PATCH', `/api/v1/projects/${SOME_ID}/teams/${SOME_ID}`],
    ['DELETE', `/api/v1/projects/${SOME_ID}/teams/${SOME_ID}`],
    ['PUT', `/api/v1/projects/${SOME_ID}/teams/${SOME_ID}/members/${SOME_ID}`],
    ['DELETE', `/api/v1/projects/${SOME_ID}/teams/${SOME_ID}/members/${SOME_ID}`],
    ['GET', `/api/v1/projects/${SOME_ID}/buckets`],
    ['POST', `/api/v1/projects/${SOME_ID}/buckets`],
    ['PATCH', `/api/v1/projects/${SOME_ID}/buckets/${SOME_ID}`],
    ['POST', `/api/v1/projects/${SOME_ID}/buckets/${SOME_ID}/move`],
    ['DELETE', `/api/v1/projects/${SOME_ID}/buckets/${SOME_ID}`],
    ['GET', `/api/v1/projects/${SOME_ID}/labels`],
    ['POST', `/api/v1/projects/${SOME_ID}/labels`],
    ['PATCH', `/api/v1/projects/${SOME_ID}/labels/${SOME_ID}`],
    ['DELETE', `/api/v1/projects/${SOME_ID}/labels/${SOME_ID}`],
    ['GET', `/api/v1/projects/${SOME_ID}/sprints`],
    ['POST', `/api/v1/projects/${SOME_ID}/sprints`],
    ['PATCH', `/api/v1/projects/${SOME_ID}/sprints/${SOME_ID}`],
    ['POST', `/api/v1/projects/${SOME_ID}/sprints/${SOME_ID}/start`],
    ['POST', `/api/v1/projects/${SOME_ID}/sprints/${SOME_ID}/close`],
    ['DELETE', `/api/v1/projects/${SOME_ID}/sprints/${SOME_ID}`],
    ['GET', `/api/v1/projects/${SOME_ID}/items`],
    ['POST', `/api/v1/projects/${SOME_ID}/items`],
    ['GET', `/api/v1/projects/${SOME_ID}/items/1`],
    ['PATCH', `/api/v1/projects/${SOME_ID}/items/1`],
    ['DELETE', `/api/v1/projects/${SOME_ID}/items/1`],
    ['POST', `/api/v1/projects/${SOME_ID}/items/1/move`],
    ['GET', `/api/v1/projects/${SOME_ID}/items/1/children`],
    ['GET', `/api/v1/projects/${SOME_ID}/items/1/activity`],
    ['POST', `/api/v1/projects/${SOME_ID}/items/1/dependencies`],
    ['DELETE', `/api/v1/projects/${SOME_ID}/items/1/dependencies/${SOME_ID}`],
    ['GET', `/api/v1/projects/${SOME_ID}/items/1/checklist`],
    ['POST', `/api/v1/projects/${SOME_ID}/items/1/checklist`],
    ['PATCH', `/api/v1/projects/${SOME_ID}/items/1/checklist/${SOME_ID}`],
    ['POST', `/api/v1/projects/${SOME_ID}/items/1/checklist/${SOME_ID}/move`],
    ['DELETE', `/api/v1/projects/${SOME_ID}/items/1/checklist/${SOME_ID}`],
    ['GET', `/api/v1/projects/${SOME_ID}/items/1/notes`],
    ['POST', `/api/v1/projects/${SOME_ID}/items/1/notes`],
    ['PATCH', `/api/v1/projects/${SOME_ID}/items/1/notes/${SOME_ID}`],
    ['DELETE', `/api/v1/projects/${SOME_ID}/items/1/notes/${SOME_ID}`],
    ['GET', `/api/v1/projects/${SOME_ID}/items/1/attachments`],
    ['POST', `/api/v1/projects/${SOME_ID}/items/1/attachments`],
    ['GET', `/api/v1/projects/${SOME_ID}/items/1/attachments/${SOME_ID}`],
    ['DELETE', `/api/v1/projects/${SOME_ID}/items/1/attachments/${SOME_ID}`],
    ['POST', `/api/v1/projects/${SOME_ID}/items/1/images`],
    ['GET', `/api/v1/projects/${SOME_ID}/items/1/images/${SOME_ID}`],
    ['GET', '/api/v1/notifications'],
    ['GET', '/api/v1/notifications/unread-count'],
    ['POST', '/api/v1/notifications/read-all'],
    ['POST', `/api/v1/notifications/${SOME_ID}/read`],
    ['GET', '/api/v1/me/theme'],
    ['PUT', '/api/v1/me/theme'],
    ['DELETE', '/api/v1/me/theme'],
    ['GET', '/api/v1/admin/settings/security'],
    ['PUT', '/api/v1/admin/settings/security'],
    ['GET', '/api/v1/admin/settings/storage'],
    ['PUT', '/api/v1/admin/settings/storage'],
    ['GET', '/api/v1/admin/settings/storage/usage'],
    ['GET', '/api/v1/admin/settings/logs'],
    ['PUT', '/api/v1/admin/settings/logs'],
    ['GET', '/api/v1/admin/settings/theme'],
    ['PUT', '/api/v1/admin/settings/theme'],
    ['GET', '/api/v1/admin/settings/branding'],
    ['PUT', '/api/v1/admin/settings/branding'],
    ['PUT', '/api/v1/admin/settings/branding/logo'],
    ['DELETE', '/api/v1/admin/settings/branding/logo'],
    ['PUT', '/api/v1/admin/settings/branding/fonts/regular'],
    ['DELETE', '/api/v1/admin/settings/branding/fonts/bold'],
    ['PUT', '/api/v1/admin/settings/branding/fonts/bold'],
    ['DELETE', '/api/v1/admin/settings/branding/fonts/regular'],
    ['GET', '/api/v1/admin/backups'],
    ['PUT', '/api/v1/admin/backups/settings'],
    ['POST', '/api/v1/admin/backups/run'],
  ] as const)('%s %s returns 401 without a session', async (method, url) => {
    const res = await app.inject({ method, url, headers: CSRF, payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: ErrorCode.UNAUTHENTICATED, message: 'Not signed in' });
  });

  // Uploads send raw bytes; they must be refused before any of the body is
  // used, by the same CSRF and session checks as every other write.
  it.each([
    `/api/v1/projects/${SOME_ID}/items/1/attachments`,
    `/api/v1/projects/${SOME_ID}/items/1/images`,
  ])('refuses uploads to %s without the CSRF header or a session', async (url) => {
    const upload = {
      method: 'POST' as const,
      url,
      payload: Buffer.from('GIF89a'),
    };
    const headers = { 'content-type': UPLOAD_CONTENT_TYPE, [FILE_NAME_HEADER]: 'a.gif' };
    const noCsrf = await app.inject({ ...upload, headers });
    expect(noCsrf.statusCode).toBe(403);
    expect(errorOf(noCsrf).code).toBe(ErrorCode.CSRF_HEADER_MISSING);
    const noSession = await app.inject({ ...upload, headers: { ...headers, ...CSRF } });
    expect(noSession.statusCode).toBe(401);
    expect(errorOf(noSession).code).toBe(ErrorCode.UNAUTHENTICATED);
  });

  // Branding uploads are admin-only and refused the same way, before any of
  // the file is read.
  it.each([
    '/api/v1/admin/settings/branding/logo',
    '/api/v1/admin/settings/branding/fonts/regular',
  ])('refuses branding uploads to %s without the CSRF header or a session', async (url) => {
    const upload = { method: 'PUT' as const, url, payload: Buffer.from('wOF2') };
    const headers = { 'content-type': UPLOAD_CONTENT_TYPE, [FILE_NAME_HEADER]: 'a.woff2' };
    const noCsrf = await app.inject({ ...upload, headers });
    expect(noCsrf.statusCode).toBe(403);
    expect(errorOf(noCsrf).code).toBe(ErrorCode.CSRF_HEADER_MISSING);
    const noSession = await app.inject({ ...upload, headers: { ...headers, ...CSRF } });
    expect(noSession.statusCode).toBe(401);
  });

  // The public branding routes need no session but only serve what pages
  // draw: an unknown font weight is a 404 before anything is read.
  it('answers unknown public branding files with 404 without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/branding/fonts/italic' });
    expect(res.statusCode).toBe(404);
    expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
  });

  it('requires the CSRF header on state-changing requests, even public ones', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'a@b.c', password: 'x' },
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe(ErrorCode.CSRF_HEADER_MISSING);
  });

  it('rejects a wrong CSRF header value', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { [CSRF_HEADER]: 'XMLHttpRequest' },
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe(ErrorCode.CSRF_HEADER_MISSING);
  });

  it('checks CSRF before authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/users' });
    expect(res.statusCode).toBe(401);
    const post = await app.inject({ method: 'POST', url: '/api/v1/admin/users', payload: {} });
    expect(post.statusCode).toBe(403);
  });

  it('returns validation errors in the standard shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...CSRF, 'x-forwarded-for': '198.51.100.1' },
      payload: { email: 42, extra: true },
    });
    expect(res.statusCode).toBe(400);
    const body = errorOf(res);
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
    const fields = (body.details as { field: string }[]).map((d) => d.field).sort();
    expect(fields).toEqual(['email', 'extra', 'password']);
  });

  it('returns malformed JSON errors in the standard shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...CSRF, 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.2' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('returns 404 for unknown routes in the standard shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(errorOf(res).code).toBe(ErrorCode.NOT_FOUND);
  });

  describe('login rate limit (limit 3 per window in this suite)', () => {
    const attempt = (headers: Record<string, string>, remoteAddress = '127.0.0.1') =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { ...CSRF, ...headers },
        // Invalid body: fails validation after the rate limit guard, so no
        // database access is needed to exercise the limiter.
        payload: {},
        remoteAddress,
      });

    it('answers 429 with Retry-After once an IP exceeds the limit', async () => {
      const headers = { 'x-forwarded-for': '203.0.113.10' };
      for (let i = 0; i < 3; i++) {
        expect((await attempt(headers)).statusCode).toBe(400);
      }
      const limited = await attempt(headers);
      expect(limited.statusCode).toBe(429);
      expect(errorOf(limited).code).toBe(ErrorCode.RATE_LIMITED);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('keys on the client IP forwarded by the trusted (loopback) proxy', async () => {
      for (let i = 0; i < 3; i++) await attempt({ 'x-forwarded-for': '203.0.113.20' });
      expect((await attempt({ 'x-forwarded-for': '203.0.113.20' })).statusCode).toBe(429);
      // A different client behind the same proxy has its own budget.
      expect((await attempt({ 'x-forwarded-for': '203.0.113.21' })).statusCode).toBe(400);
    });

    it('ignores X-Forwarded-For from untrusted peers, so it cannot be used to dodge the limit', async () => {
      const peer = '192.0.2.50';
      for (let i = 0; i < 3; i++) {
        await attempt({ 'x-forwarded-for': `203.0.113.${100 + i}` }, peer);
      }
      const res = await attempt({ 'x-forwarded-for': '203.0.113.200' }, peer);
      expect(res.statusCode).toBe(429);
    });
  });
});
