import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { CSRF_HEADER, CSRF_HEADER_VALUE, type SystemRole } from '@kloister/shared';
import { createApp } from '../../src/app.factory.js';
import { PasswordService } from '../../src/auth/password.service.js';
import type { User } from '../../src/generated/prisma/client.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

// Helpers for tests against a real, disposable Postgres (see jest.db.config.js).

/** Cookie path the tests configure, to assert the Path attribute. */
export const TEST_APP_NAME = 'kloister-test';

/** Default password for seeded users (meets the 12-character minimum). */
export const PASSWORD = 'seeded-password-1';

/**
 * Boots the full app. The login rate limit is raised so suites that sign in
 * many times from the same address are not throttled; the limiter itself is
 * covered by the database-free e2e tests.
 *
 * @returns The app and its Prisma client.
 */
export async function startApp(): Promise<{ app: NestFastifyApplication; prisma: PrismaService }> {
  process.env['APP_NAME'] = TEST_APP_NAME;
  process.env['LOGIN_RATE_LIMIT'] = '10000';
  const app = await createApp({ logger: false });
  await app.getHttpAdapter().getInstance().ready();
  return { app, prisma: app.get(PrismaService) };
}

/**
 * Empties every table so each test starts from a clean database.
 *
 * @param prisma Database client.
 * @returns Resolves once truncated.
 */
export async function resetDb(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "Session", "AppSetting", "User" RESTART IDENTITY CASCADE',
  );
}

const passwords = new PasswordService();

/**
 * Inserts a user directly.
 *
 * @param prisma Database client.
 * @param fields Email plus optional role, password and flags.
 * @param fields.email Login email.
 * @param fields.systemRole Defaults to USER.
 * @param fields.password Defaults to {@link PASSWORD}.
 * @param fields.mustChangePassword Defaults to false.
 * @param fields.isActive Defaults to true.
 * @returns The created row.
 */
export async function seedUser(
  prisma: PrismaService,
  fields: {
    email: string;
    systemRole?: SystemRole;
    password?: string;
    mustChangePassword?: boolean;
    isActive?: boolean;
  },
): Promise<User> {
  return prisma.user.create({
    data: {
      email: fields.email,
      displayName: fields.email.split('@')[0] ?? fields.email,
      systemRole: fields.systemRole ?? 'USER',
      passwordHash: await passwords.hash(fields.password ?? PASSWORD),
      mustChangePassword: fields.mustChangePassword ?? false,
      isActive: fields.isActive ?? true,
    },
  });
}

/** Minimal response view used by the helpers. */
export interface Res {
  statusCode: number;
  json: () => unknown;
  headers: Record<string, unknown>;
  cookies: { name: string; value: string; [key: string]: unknown }[];
}

/**
 * Sends a request with the CSRF header and an optional session cookie.
 *
 * @param app The app.
 * @param method HTTP method.
 * @param url Path including `/api/v1`.
 * @param options Session cookie value and JSON body.
 * @param options.sid Session token, if signed in.
 * @param options.body JSON body.
 * @returns The response.
 */
export async function call(
  app: NestFastifyApplication,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { sid?: string; body?: object } = {},
): Promise<Res> {
  const res = await app.inject({
    method,
    url,
    headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE },
    ...(options.sid === undefined ? {} : { cookies: { sid: options.sid } }),
    ...(options.body === undefined ? {} : { payload: options.body }),
  });
  return res;
}

/**
 * Signs in and returns the session token from the cookie.
 *
 * @param app The app.
 * @param email Login email.
 * @param password Login password.
 * @returns The session token.
 */
export async function login(
  app: NestFastifyApplication,
  email: string,
  password = PASSWORD,
): Promise<string> {
  const res = await call(app, 'POST', '/api/v1/auth/login', { body: { email, password } });
  if (res.statusCode !== 200) {
    throw new Error(`login failed for ${email}: ${res.statusCode} ${JSON.stringify(res.json())}`);
  }
  const cookie = res.cookies.find((c) => c.name === 'sid');
  if (cookie === undefined) throw new Error('no session cookie');
  return cookie.value;
}

/**
 * Reads the `code` field of an error response.
 *
 * @param res The response.
 * @returns The error code.
 */
export function codeOf(res: Res): string {
  return (res.json() as { code: string }).code;
}
