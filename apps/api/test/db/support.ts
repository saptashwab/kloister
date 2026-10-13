import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { CSRF_HEADER, CSRF_HEADER_VALUE, type SystemRole } from '@kloister/shared';
import { createApp } from '../../src/app.factory.js';
import { PasswordService } from '../../src/auth/password.service.js';
import type {
  Bucket,
  Label,
  Project,
  Sprint,
  Team,
  User,
  WorkItem,
} from '../../src/generated/prisma/client.js';
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
    'TRUNCATE TABLE "AuditLog", "Session", "AppSetting", "ChecklistItem", "WorkItemLabel", "WorkItemDependency", "WorkItemAssignee", "WorkItem", "Label", "Sprint", "Bucket", "TeamMember", "Team", "ProjectMember", "Project", "User" RESTART IDENTITY CASCADE',
  );
}

const passwords = new PasswordService();

/** Hash of {@link PASSWORD}, computed once: argon2 is slow by design. */
let defaultHash: Promise<string> | undefined;

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
      passwordHash:
        fields.password === undefined
          ? await (defaultHash ??= passwords.hash(PASSWORD))
          : await passwords.hash(fields.password),
      mustChangePassword: fields.mustChangePassword ?? false,
      isActive: fields.isActive ?? true,
    },
  });
}

/**
 * Inserts a project with its members directly.
 *
 * @param prisma Database client.
 * @param key Project key.
 * @param members Memberships to create.
 * @param fields Optional extra project fields.
 * @param fields.archivedAt Archive timestamp.
 * @param fields.settings Stored settings JSON.
 * @returns The created project.
 */
export async function seedProject(
  prisma: PrismaService,
  key: string,
  members: {
    userId: string;
    role: 'PM' | 'LEAD' | 'MEMBER' | 'VIEWER';
    visibility?: 'ALL' | 'BUCKETS' | 'OWN' | 'TEAMS';
    allowedBucketIds?: string[];
  }[],
  fields: { archivedAt?: Date; settings?: object } = {},
): Promise<Project> {
  return prisma.project.create({
    data: {
      key,
      name: `Project ${key}`,
      ...(fields.archivedAt === undefined ? {} : { archivedAt: fields.archivedAt }),
      ...(fields.settings === undefined ? {} : { settings: fields.settings }),
      members: { create: members },
    },
  });
}

/**
 * Inserts a team with members directly. Members must already be project
 * members (the database enforces it).
 *
 * @param prisma Database client.
 * @param projectId Project id.
 * @param name Team name.
 * @param members Team memberships to create.
 * @returns The created team.
 */
export async function seedTeam(
  prisma: PrismaService,
  projectId: string,
  name: string,
  members: { userId: string; role: 'LEAD' | 'MEMBER' }[] = [],
): Promise<Team> {
  return prisma.team.create({
    data: {
      projectId,
      name,
      // Prisma fills teamId and projectId from the parent team.
      members: { create: members },
    },
  });
}

/**
 * Inserts a bucket directly, after the project's existing buckets.
 *
 * @param prisma Database client.
 * @param projectId Project id.
 * @param name Bucket name.
 * @param rule Optional entry rule.
 * @param rule.onEnterMode Rule mode.
 * @param rule.onEnterStatus Status the rule sets.
 * @returns The created bucket.
 */
export async function seedBucket(
  prisma: PrismaService,
  projectId: string,
  name: string,
  rule: {
    onEnterMode?: 'NONE' | 'SET' | 'SET_IF_NOT_STARTED';
    onEnterStatus?: 'NOT_STARTED' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE';
  } = {},
): Promise<Bucket> {
  const count = await prisma.bucket.count({ where: { projectId } });
  return prisma.bucket.create({
    data: { projectId, name, position: (count + 1) * 1024, ...rule },
  });
}

/**
 * Inserts a work item directly, taking the next item number. Assignees must
 * be project members (the database enforces it).
 *
 * @param prisma Database client.
 * @param projectId Project id.
 * @param fields Item fields.
 * @param fields.createdById Creator.
 * @param fields.type Defaults to TASK.
 * @param fields.title Defaults to "Item <n>".
 * @param fields.bucketId Bucket (required for STORY/TASK/BUG).
 * @param fields.parentId Parent item.
 * @param fields.teamId Team.
 * @param fields.sprintId Sprint.
 * @param fields.status Defaults to NOT_STARTED.
 * @param fields.position Defaults to the item number times 1024.
 * @param fields.assigneeIds Assignees.
 * @returns The created item.
 */
export async function seedItem(
  prisma: PrismaService,
  projectId: string,
  fields: {
    createdById: string;
    type?: 'EPIC' | 'FEATURE' | 'STORY' | 'TASK' | 'BUG';
    title?: string;
    bucketId?: string | null;
    parentId?: string | null;
    teamId?: string | null;
    sprintId?: string | null;
    status?: 'NOT_STARTED' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE';
    position?: number;
    assigneeIds?: string[];
  },
): Promise<WorkItem> {
  const { lastItemNumber: number } = await prisma.project.update({
    where: { id: projectId },
    data: { lastItemNumber: { increment: 1 } },
  });
  const item = await prisma.workItem.create({
    data: {
      projectId,
      number,
      type: fields.type ?? 'TASK',
      title: fields.title ?? `Item ${number}`,
      bucketId: fields.bucketId ?? null,
      parentId: fields.parentId ?? null,
      teamId: fields.teamId ?? null,
      sprintId: fields.sprintId ?? null,
      status: fields.status ?? 'NOT_STARTED',
      position: fields.position ?? number * 1024,
      createdById: fields.createdById,
    },
  });
  if (fields.assigneeIds !== undefined && fields.assigneeIds.length > 0) {
    // Explicit columns: both composite keys need projectId.
    await prisma.workItemAssignee.createMany({
      data: fields.assigneeIds.map((userId) => ({ workItemId: item.id, projectId, userId })),
    });
  }
  return item;
}

/**
 * Inserts a label directly.
 *
 * @param prisma Database client.
 * @param projectId Project id.
 * @param name Label name.
 * @returns The created label.
 */
export function seedLabel(prisma: PrismaService, projectId: string, name: string): Promise<Label> {
  return prisma.label.create({ data: { projectId, name, colour: '#336699' } });
}

/**
 * Inserts a sprint directly.
 *
 * @param prisma Database client.
 * @param projectId Project id.
 * @param name Sprint name.
 * @param state Defaults to PLANNED.
 * @returns The created sprint.
 */
export function seedSprint(
  prisma: PrismaService,
  projectId: string,
  name: string,
  state: 'PLANNED' | 'ACTIVE' | 'CLOSED' = 'PLANNED',
): Promise<Sprint> {
  return prisma.sprint.create({
    data: {
      projectId,
      name,
      state,
      startDate: new Date('2026-11-02T00:00:00.000Z'),
      endDate: new Date('2026-11-13T00:00:00.000Z'),
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
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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
