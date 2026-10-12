import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../src/app.factory.js';

describe('GET /api/v1/health (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp({ logger: false });
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // Permission test: the endpoint must be reachable with no session cookie,
  // because the deploy scripts call it before any user exists.
  it('returns 200 without authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('is only served under the API prefix', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(404);
  });
});
