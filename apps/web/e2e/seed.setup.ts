import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test as setup } from '@playwright/test';
import { E2E_PASSWORD, PROJECT_KEY, USERS } from './support';

// Seeds the empty CI database the browser tests run against: the first
// admin through the real create-admin CLI (as install.sh will), then users,
// a project and work items through the HTTP API, exactly as a user would.

/** The API, called directly rather than through the dev server's proxy. */
const API = 'http://127.0.0.1:3000/api/v1';

/**
 * Calls the API with a session and the CSRF header the API requires.
 *
 * @param sid Session token, or null.
 * @param method HTTP method.
 * @param path Path below `/api/v1`.
 * @param body JSON body.
 * @returns The parsed JSON response.
 */
async function call<T>(
  sid: string | null,
  method: string,
  path: string,
  body?: object,
): Promise<T> {
  const res = await fetch(`${API}/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'kloister',
      ...(sid === null ? {} : { Cookie: `sid=${sid}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * Signs in and returns the session token from the `sid` cookie.
 *
 * @param email User email.
 * @param password Password.
 * @returns The session token.
 */
async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'kloister' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email}: ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('sid='));
  if (cookie === undefined) throw new Error(`login ${email}: no session cookie`);
  return cookie.slice('sid='.length).split(';')[0] ?? '';
}

/**
 * Signs in with a temporary password and sets the shared test password.
 *
 * @param email User email.
 * @param temporary Temporary password.
 * @returns A session token of the user.
 */
async function activate(email: string, temporary: string): Promise<string> {
  const sid = await login(email, temporary);
  await call(sid, 'POST', 'auth/change-password', {
    currentPassword: temporary,
    newPassword: E2E_PASSWORD,
  });
  return sid;
}

/**
 * A calendar date relative to today.
 *
 * @param days Days from today.
 * @returns `YYYY-MM-DD`.
 */
function day(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

setup('seed users, project and items', async () => {
  // Relative to this config's folder, not to wherever the runner started.
  const configFile = setup.info().config.configFile ?? '';
  const apiDir = resolve(dirname(configFile), '../../api');

  // The first admin, created by the CLI; its temporary password is read
  // from stdout and kept in memory only.
  const { stdout } = await promisify(execFile)(
    'node',
    ['dist/cli/create-admin.js', '--email', USERS.admin, '--name', 'Ada Admin'],
    { cwd: apiDir },
  );
  const temporary = /Temporary password[^:]*: (\S+)/.exec(stdout)?.[1];
  if (temporary === undefined) throw new Error(`create-admin printed no password:\n${stdout}`);
  const admin = await activate(USERS.admin, temporary);

  const ids: Record<string, string> = {};
  const sids: Record<string, string> = {};
  const names = { pm: 'Pat Manager', member: 'Mia Member', viewer: 'Vic Viewer' } as const;
  for (const role of ['pm', 'member', 'viewer'] as const) {
    const created = await call<{ user: { id: string }; temporaryPassword: string }>(
      admin,
      'POST',
      'admin/users',
      { email: USERS[role], displayName: names[role] },
    );
    ids[role] = created.user.id;
    sids[role] = await activate(USERS[role], created.temporaryPassword);
  }

  await call(admin, 'POST', 'projects', {
    key: PROJECT_KEY,
    name: 'Demo project',
    pmUserIds: [ids['pm']],
  });
  const pm = sids['pm'] ?? '';
  const project = `projects/${PROJECT_KEY}`;
  // The Member sees only their own items, so hidden ancestors show as titles.
  await call(pm, 'POST', `${project}/members`, {
    userId: ids['member'],
    role: 'MEMBER',
    visibility: 'OWN',
  });
  await call(pm, 'POST', `${project}/members`, { userId: ids['viewer'], role: 'VIEWER' });

  const buckets = await call<{ items: { id: string; name: string }[] }>(
    pm,
    'GET',
    `${project}/buckets`,
  );
  const bucket = (name: string) => buckets.items.find((b) => b.name === name)?.id;
  await call(pm, 'POST', `${project}/sprints`, {
    name: 'Sprint 1',
    startDate: day(0),
    endDate: day(13),
  });
  await call(pm, 'POST', `${project}/labels`, { name: 'backend', colour: '#3366cc' });

  // Items 1–6, in this order (see ITEMS in support.ts).
  const create = (body: object) => call<{ id: string }>(pm, 'POST', `${project}/items`, body);
  const epic = await create({ type: 'EPIC', title: 'Checkout' });
  const feature = await create({ type: 'FEATURE', title: 'Payments', parentId: epic.id });
  const story = await create({
    type: 'STORY',
    title: 'Pay by invoice',
    parentId: feature.id,
    bucketId: bucket('To Do'),
  });
  await create({
    type: 'TASK',
    title: 'Invoice form',
    parentId: story.id,
    bucketId: bucket('To Do'),
    assigneeIds: [ids['member']],
  });
  await create({
    type: 'TASK',
    title: 'Invoice PDF',
    parentId: story.id,
    bucketId: bucket('To Do'),
  });
  await create({
    type: 'BUG',
    title: 'Total rounds wrongly',
    bucketId: bucket('Backlog'),
    dueDate: day(-2),
  });
});
