import { jest } from '@jest/globals';
import type { AuditService } from '../../src/audit/audit.service.js';
import { AppConfig } from '../../src/config/app-config.js';
import type { Project, User } from '../../src/generated/prisma/client.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  DEFAULT_SECURITY_SETTINGS,
  type SecuritySettings,
  type SettingsService,
} from '../../src/settings/settings.service.js';

// Hand-rolled fakes for unit tests that must run without Postgres. Each
// Prisma delegate method is a jest.fn the test can program per case.

/** An async mock function; tests program resolved values per case. */
export type Fn = jest.Mock<(...args: unknown[]) => Promise<unknown>>;

/**
 * Builds a mock function.
 *
 * @returns A fresh jest mock.
 */
const fn = (): Fn => jest.fn<(...args: unknown[]) => Promise<unknown>>();

/** The subset of Prisma the services under test use, all mocked. */
export interface FakePrisma {
  user: { findUnique: Fn; findMany: Fn; create: Fn; update: Fn; count: Fn };
  session: { findUnique: Fn; create: Fn; update: Fn; deleteMany: Fn };
  auditLog: { create: Fn; findMany: Fn };
  appSetting: { findUnique: Fn };
  project: { findUnique: Fn; findMany: Fn; create: Fn; update: Fn };
  projectMember: {
    findUnique: Fn;
    findMany: Fn;
    create: Fn;
    update: Fn;
    delete: Fn;
    count: Fn;
  };
  team: { findFirst: Fn; findMany: Fn; create: Fn; update: Fn; delete: Fn };
  teamMember: { count: Fn; upsert: Fn; delete: Fn };
  $transaction: Fn;
}

/**
 * Creates a fake Prisma client whose `$transaction` runs the callback with
 * the same fake, so writes inside transactions land on the same mocks.
 *
 * @returns The fake and the same object typed as PrismaService.
 */
export function fakePrisma(): { fake: FakePrisma; prisma: PrismaService } {
  const fake: FakePrisma = {
    user: { findUnique: fn(), findMany: fn(), create: fn(), update: fn(), count: fn() },
    session: { findUnique: fn(), create: fn(), update: fn(), deleteMany: fn() },
    auditLog: { create: fn(), findMany: fn() },
    appSetting: { findUnique: fn() },
    project: { findUnique: fn(), findMany: fn(), create: fn(), update: fn() },
    projectMember: {
      findUnique: fn(),
      findMany: fn(),
      create: fn(),
      update: fn(),
      delete: fn(),
      count: fn(),
    },
    team: { findFirst: fn(), findMany: fn(), create: fn(), update: fn(), delete: fn() },
    teamMember: { count: fn(), upsert: fn(), delete: fn() },
    $transaction: fn(),
  };
  fake.$transaction.mockImplementation((callback: unknown) =>
    (callback as (tx: FakePrisma) => Promise<unknown>)(fake),
  );
  fake.session.deleteMany.mockResolvedValue({ count: 0 });
  fake.auditLog.create.mockResolvedValue({});
  fake.teamMember.count.mockResolvedValue(0);
  return { fake, prisma: fake as unknown as PrismaService };
}

/**
 * A settings service returning fixed values.
 *
 * @param overrides Values to change from the defaults.
 * @returns The fake service.
 */
export function fakeSettings(overrides: Partial<SecuritySettings> = {}): SettingsService {
  const settings = { ...DEFAULT_SECURITY_SETTINGS, ...overrides };
  return { getSecurity: () => Promise.resolve(settings) } as unknown as SettingsService;
}

/** Audit service fake that captures records. */
export interface FakeAudit {
  /** Every record passed to `record`. */
  records: { action: string; actorId: string | null; entityId?: string | null; meta?: unknown }[];
  /** The fake typed as AuditService. */
  service: AuditService;
}

/**
 * Creates an audit service fake.
 *
 * @returns The fake and its captured records.
 */
export function fakeAudit(): FakeAudit {
  const records: FakeAudit['records'] = [];
  const service = {
    record: (record: FakeAudit['records'][number]) => {
      records.push(record);
      return Promise.resolve();
    },
  } as unknown as AuditService;
  return { records, service };
}

/**
 * Builds a user row with sensible defaults.
 *
 * @param overrides Fields to change.
 * @returns The user.
 */
export function makeUser(overrides: Partial<User> = {}): User {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'user@example.org',
    displayName: 'Test User',
    passwordHash: 'hash',
    systemRole: 'USER',
    mustChangePassword: false,
    isActive: true,
    failedLoginCount: 0,
    lockedUntil: null,
    themePrefs: {},
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Builds a project row with sensible defaults.
 *
 * @param overrides Fields to change.
 * @returns The project.
 */
export function makeProject(overrides: Partial<Project> = {}): Project {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id: '33333333-3333-4333-8333-333333333333',
    key: 'KLO',
    name: 'Test project',
    description: '',
    archivedAt: null,
    settings: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Builds a configuration for tests.
 *
 * @param overrides Fields to change.
 * @returns The configuration.
 */
export function makeConfig(
  overrides: Partial<ConstructorParameters<typeof AppConfig>[0]> = {},
): AppConfig {
  return new AppConfig({
    databaseUrl: 'postgresql://unused',
    host: '127.0.0.1',
    port: 3000,
    cookiePath: '/kloister-test/',
    trustProxy: 'loopback',
    loginRateLimit: 10,
    loginRateWindowMs: 60_000,
    ...overrides,
  });
}
