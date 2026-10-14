import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  FILE_NAME_HEADER,
  type SystemRole,
  UPLOAD_CONTENT_TYPE,
} from '@kloister/shared';
import { createApp } from '../../src/app.factory.js';
import { PasswordService } from '../../src/auth/password.service.js';
import type {
  Attachment,
  Bucket,
  Label,
  Note,
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
 * Attachments folder of this test run: a fresh temporary directory, so
 * uploads never land anywhere real.
 */
export const ATTACHMENTS_DIR = mkdtempSync(join(tmpdir(), 'kloister-db-attachments-'));

/** Branding folder of this test run (logo and font uploads). */
export const BRANDING_DIR = mkdtempSync(join(tmpdir(), 'kloister-db-branding-'));

/** Backups folder of this test run. */
export const BACKUP_DIR = mkdtempSync(join(tmpdir(), 'kloister-db-backups-'));

/**
 * Folder of the fake pg_dump. Creating `fail` in it makes the next dump fail;
 * creating `slow` makes it take a second.
 */
export const FAKE_PG_DUMP_DIR = mkdtempSync(join(tmpdir(), 'kloister-db-pgdump-'));

/**
 * A stand-in for pg_dump (a POSIX shell script, as on the CI runner), so no
 * database test depends on the runner's pg_dump matching the Postgres
 * server version. It writes a small file to the `--file=` target, records
 * its environment and arguments next to it, and fails or waits on request.
 */
export const FAKE_PG_DUMP = join(FAKE_PG_DUMP_DIR, 'pg_dump');
writeFileSync(
  FAKE_PG_DUMP,
  [
    '#!/bin/sh',
    `dir='${FAKE_PG_DUMP_DIR}'`,
    'out=""',
    'for arg in "$@"; do case "$arg" in --file=*) out="${arg#--file=}";; esac; done',
    'printf "%s\\n" "$@" > "$dir/args"',
    'env > "$dir/env"',
    'if [ -f "$dir/slow" ]; then sleep 1; fi',
    // A failing dump leaves half a file behind, which the app must remove.
    'if [ -f "$dir/fail" ]; then printf "PGDMP half" > "$out"; echo "pg_dump: error: simulated failure" >&2; exit 2; fi',
    'printf "PGDMP fake dump of %s\\n" "$PGDATABASE" > "$out"',
    '',
  ].join('\n'),
  { mode: 0o755 },
);

/**
 * Boots the full app. The login rate limit is raised so suites that sign in
 * many times from the same address are not throttled; the limiter itself is
 * covered by the database-free e2e tests. Uploads go to {@link ATTACHMENTS_DIR},
 * branding files to {@link BRANDING_DIR}, backups to {@link BACKUP_DIR} via
 * {@link FAKE_PG_DUMP}; logs are silenced.
 *
 * @returns The app and its Prisma client.
 */
export async function startApp(): Promise<{ app: NestFastifyApplication; prisma: PrismaService }> {
  process.env['APP_NAME'] = TEST_APP_NAME;
  process.env['LOGIN_RATE_LIMIT'] = '10000';
  process.env['ATTACHMENTS_DIR'] = ATTACHMENTS_DIR;
  process.env['BRANDING_DIR'] = BRANDING_DIR;
  process.env['BACKUP_DIR'] = BACKUP_DIR;
  process.env['PG_DUMP_PATH'] = FAKE_PG_DUMP;
  process.env['LOG_LEVEL'] = 'silent';
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
    'TRUNCATE TABLE "Notification", "Attachment", "Note", "AuditLog", "Session", "AppSetting", "ChecklistItem", "WorkItemLabel", "WorkItemDependency", "WorkItemAssignee", "WorkItem", "Label", "Sprint", "Bucket", "TeamMember", "Team", "ProjectMember", "Project", "User" RESTART IDENTITY CASCADE',
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

/**
 * Inserts a note directly.
 *
 * @param prisma Database client.
 * @param workItemId Item id.
 * @param authorId Author.
 * @param body Stored (already safe) HTML.
 * @returns The created note.
 */
export function seedNote(
  prisma: PrismaService,
  workItemId: string,
  authorId: string,
  body = '<p>Seeded note</p>',
): Promise<Note> {
  return prisma.note.create({ data: { workItemId, authorId, body } });
}

/** A tiny valid GIF (1 x 1 pixel), used as an image and attachment in tests. */
export const GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

/**
 * Inserts an attachment (or inline image) row and writes its file into
 * {@link ATTACHMENTS_DIR}, as an upload would.
 *
 * @param prisma Database client.
 * @param projectId The item's project.
 * @param workItemId Item id.
 * @param uploaderId Uploader.
 * @param fields Optional fields.
 * @param fields.inline True for an inline image.
 * @param fields.name File name.
 * @param fields.bytes Content; a tiny GIF by default.
 * @param fields.createdAt Upload time; now by default.
 * @returns The created row.
 */
export async function seedAttachment(
  prisma: PrismaService,
  projectId: string,
  workItemId: string,
  uploaderId: string,
  fields: { inline?: boolean; name?: string; bytes?: Buffer; createdAt?: Date } = {},
): Promise<Attachment> {
  const bytes = fields.bytes ?? GIF;
  const storedName = randomUUID();
  await mkdir(join(ATTACHMENTS_DIR, projectId), { recursive: true });
  await writeFile(join(ATTACHMENTS_DIR, projectId, storedName), bytes);
  return prisma.attachment.create({
    data: {
      workItemId,
      uploaderId,
      originalName: fields.name ?? 'seeded.gif',
      storedName,
      sizeBytes: bytes.length,
      mimeType: 'image/gif',
      sha256: 'seeded',
      inline: fields.inline ?? false,
      ...(fields.createdAt === undefined ? {} : { createdAt: fields.createdAt }),
    },
  });
}

/**
 * Reports whether a stored file exists on disk.
 *
 * @param projectId Project id.
 * @param storedName Stored name.
 * @returns True if the file is there.
 */
export async function storedFileExists(projectId: string, storedName: string): Promise<boolean> {
  try {
    await access(join(ATTACHMENTS_DIR, projectId, storedName));
    return true;
  } catch {
    return false;
  }
}

/**
 * Uploads raw bytes the way the web app does: `application/octet-stream`
 * with the name, percent-encoded, in the `x-file-name` header.
 *
 * @param app The app.
 * @param url Upload path including `/api/v1`.
 * @param sid Session token.
 * @param bytes File content.
 * @param name File name.
 * @param method POST, or PUT for branding files.
 * @returns The response.
 */
export async function upload(
  app: NestFastifyApplication,
  url: string,
  sid: string,
  bytes: Buffer,
  name = 'file.gif',
  method: 'POST' | 'PUT' = 'POST',
): Promise<Res> {
  return app.inject({
    method,
    url,
    headers: {
      [CSRF_HEADER]: CSRF_HEADER_VALUE,
      'content-type': UPLOAD_CONTENT_TYPE,
      [FILE_NAME_HEADER]: encodeURIComponent(name),
    },
    cookies: { sid },
    payload: bytes,
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
