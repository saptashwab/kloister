import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ErrorCode, type ProjectDto, type UserWorkDto } from '@kloister/shared';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  call,
  codeOf,
  login,
  type Res,
  resetDb,
  seedBucket,
  seedItem,
  seedProject,
  seedTeam,
  seedUser,
  startApp,
} from './support.js';

// "All their work" (SPEC §6) against a real database: one person's items
// across projects, limited by the caller's own access in each project, and
// the per-project label style setting (SPEC §4, §6).

const NAMES = [
  'admin',
  'pm',
  'lead',
  'member',
  'memberB',
  'viewer',
  'teamMember',
  'dev',
  'other',
  'outsider',
] as const;
type Name = (typeof NAMES)[number];

describe('all their work (db)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  /** Seeded user ids by name. */
  let ids: Record<Name, string>;
  /** Item ids: KLO a1–a4, OPS o1, archived ARC r1. */
  let items: Record<'a1' | 'a2' | 'a3' | 'a4' | 'o1' | 'r1', string>;

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
  });

  afterAll(async () => {
    await app.close();
  });

  /** Session tokens signed in during the current test, by user. */
  let sessions: Partial<Record<Name, string>> = {};

  beforeEach(async () => {
    sessions = {};
    await resetDb(prisma);
    const seeded: Partial<Record<Name, string>> = {};
    for (const name of NAMES) {
      seeded[name] = (
        await seedUser(prisma, {
          email: `${name.toLowerCase()}@example.org`,
          systemRole: name === 'admin' ? 'ADMIN' : 'USER',
        })
      ).id;
    }
    ids = seeded as Record<Name, string>;

    // KLO: every scope of SPEC §3.3 is represented; dev is the person whose
    // work is listed. The admin is a member of no project.
    const klo = await seedProject(prisma, 'KLO', [
      { userId: ids.pm, role: 'PM' },
      { userId: ids.lead, role: 'LEAD' },
      { userId: ids.member, role: 'MEMBER', visibility: 'OWN' },
      { userId: ids.viewer, role: 'VIEWER' },
      { userId: ids.teamMember, role: 'MEMBER', visibility: 'TEAMS' },
      { userId: ids.dev, role: 'MEMBER' },
    ]);
    const todo = await seedBucket(prisma, klo.id, 'To Do');
    const doing = await seedBucket(prisma, klo.id, 'Doing');
    // memberB sees the To Do bucket only; added once the bucket exists.
    await prisma.projectMember.create({
      data: {
        projectId: klo.id,
        userId: ids.memberB,
        role: 'MEMBER',
        visibility: 'BUCKETS',
        allowedBucketIds: [todo.id],
      },
    });
    const team = await seedTeam(prisma, klo.id, 'T1', [{ userId: ids.teamMember, role: 'MEMBER' }]);

    const ops = await seedProject(prisma, 'OPS', [
      { userId: ids.pm, role: 'PM' },
      { userId: ids.dev, role: 'MEMBER' },
      { userId: ids.other, role: 'MEMBER' },
    ]);
    const opsBucket = await seedBucket(prisma, ops.id, 'To Do');
    const arc = await seedProject(
      prisma,
      'ARC',
      [
        { userId: ids.pm, role: 'PM' },
        { userId: ids.dev, role: 'MEMBER' },
      ],
      { archivedAt: new Date() },
    );
    const arcBucket = await seedBucket(prisma, arc.id, 'To Do');

    const pm = ids.pm;
    const a1 = await seedItem(prisma, klo.id, {
      createdById: pm,
      bucketId: todo.id,
      assigneeIds: [ids.dev],
    });
    const a2 = await seedItem(prisma, klo.id, {
      createdById: pm,
      bucketId: doing.id,
      teamId: team.id,
      assigneeIds: [ids.dev, ids.member],
    });
    const a3 = await seedItem(prisma, klo.id, {
      createdById: pm,
      bucketId: doing.id,
      status: 'DONE',
      assigneeIds: [ids.dev],
    });
    const a4 = await seedItem(prisma, klo.id, {
      createdById: pm,
      bucketId: todo.id,
      assigneeIds: [ids.member],
    });
    const o1 = await seedItem(prisma, ops.id, {
      createdById: pm,
      bucketId: opsBucket.id,
      assigneeIds: [ids.dev],
    });
    const r1 = await seedItem(prisma, arc.id, {
      createdById: pm,
      bucketId: arcBucket.id,
      assigneeIds: [ids.dev],
    });
    // Due dates decide the order: o1, then a1, then the undated a2.
    await prisma.workItem.update({
      where: { id: o1.id },
      data: { dueDate: new Date('2026-11-01T00:00:00.000Z') },
    });
    await prisma.workItem.update({
      where: { id: a1.id },
      data: { dueDate: new Date('2026-11-05T00:00:00.000Z') },
    });
    items = { a1: a1.id, a2: a2.id, a3: a3.id, a4: a4.id, o1: o1.id, r1: r1.id };
  });

  /**
   * Sends a request as a seeded user, signing in on first use.
   *
   * @param who The user.
   * @param url Path below `/api/v1`.
   * @returns The response.
   */
  async function get(who: Name, url: string): Promise<Res> {
    sessions[who] ??= await login(app, `${who.toLowerCase()}@example.org`);
    return call(app, 'GET', `/api/v1${url}`, { sid: sessions[who] });
  }

  /**
   * Lists dev's work as a user and returns the item ids in order.
   *
   * @param who The caller.
   * @param query Extra query string.
   * @returns The ids.
   */
  async function workOf(who: Name, query = ''): Promise<string[]> {
    const res = await get(who, `/users/${ids.dev}/work${query}`);
    expect(res.statusCode).toBe(200);
    return (res.json() as UserWorkDto).items.map((i) => i.id);
  }

  it('lists open items across the caller’s unarchived projects, due date first', async () => {
    expect(await workOf('pm')).toEqual([items.o1, items.a1, items.a2]);
    expect(await workOf('dev')).toEqual([items.o1, items.a1, items.a2]);
  });

  for (const who of NAMES) {
    it(`me/work obeys the same project role and scope as the own-person list for ${who}`, async () => {
      const mine = await get(who, '/me/work?includeCreated=true&includeDone=true');
      const person = await get(who, `/users/${ids[who]}/work?includeCreated=true&includeDone=true`);
      expect(mine.statusCode).toBe(200);
      expect(mine.json()).toEqual(person.json());
      expect(await prisma.auditLog.count({ where: { action: 'ADMIN_CROSS_PROJECT_ACCESS' } })).toBe(
        0,
      );
    });
  }

  it('includes Done items on request', async () => {
    const listed = await workOf('pm', '?includeDone=true');
    // Dated items first, by due date; undated ones after them (by id).
    expect(listed.slice(0, 2)).toEqual([items.o1, items.a1]);
    expect(listed.slice(2).sort()).toEqual([items.a2, items.a3].sort());
  });

  it('returns the person with their email and summaries with project keys', async () => {
    const res = await get('pm', `/users/${ids.dev}/work`);
    const body = res.json() as UserWorkDto;
    expect(body.user).toEqual({ id: ids.dev, displayName: 'dev', email: 'dev@example.org' });
    expect(body.items[0]).toMatchObject({
      key: 'OPS-1',
      projectKey: 'OPS',
      projectName: 'Project OPS',
      dueDate: '2026-11-01',
    });
  });

  it('limits each project to the caller’s visibility scope', async () => {
    // Leads and Viewers with ALL see dev's KLO items; Lead is not in OPS.
    expect(await workOf('lead')).toEqual([items.a1, items.a2]);
    expect(await workOf('viewer')).toEqual([items.a1, items.a2]);
    // OWN: only the item also assigned to the caller.
    expect(await workOf('member')).toEqual([items.a2]);
    // BUCKETS: only the To Do bucket.
    expect(await workOf('memberB')).toEqual([items.a1]);
    // TEAMS: only the item of the caller's team.
    expect(await workOf('teamMember')).toEqual([items.a2]);
    // Shares only OPS with dev.
    expect(await workOf('other')).toEqual([items.o1]);
  });

  it('never lists items assigned to someone else or in archived projects', async () => {
    for (const who of ['pm', 'dev'] as const) {
      const listed = await workOf(who, '?includeDone=true');
      expect(listed).not.toContain(items.a4);
      expect(listed).not.toContain(items.r1);
    }
  });

  it('answers 404 for people the caller shares no project with', async () => {
    const outsider = await get('outsider', `/users/${ids.dev}/work`);
    expect(outsider.statusCode).toBe(404);
    expect(codeOf(outsider)).toBe(ErrorCode.NOT_FOUND);
    // other shares OPS with dev but no project with memberB.
    expect((await get('other', `/users/${ids.memberB}/work`)).statusCode).toBe(404);
    // Unknown users look the same.
    const unknown = await get('pm', '/users/00000000-0000-4000-8000-000000000000/work');
    expect(unknown.statusCode).toBe(404);
  });

  it('lets a caller without projects list their own (empty) work', async () => {
    const res = await get('outsider', `/users/${ids.outsider}/work`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as UserWorkDto).items).toEqual([]);
  });

  it('lets admins look anyone up but only shows items of their own projects', async () => {
    const res = await get('admin', `/users/${ids.dev}/work`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as UserWorkDto;
    expect(body.user.id).toBe(ids.dev);
    expect(body.items).toEqual([]);
    // Nothing was read from projects the admin is not a member of.
    expect(await prisma.auditLog.count({ where: { action: 'ADMIN_CROSS_PROJECT_ACCESS' } })).toBe(
      0,
    );
  });

  it('pages with a cursor and ignores cursors the caller cannot see', async () => {
    const first = (await get('pm', `/users/${ids.dev}/work?limit=2`)).json() as UserWorkDto;
    expect(first.items.map((i) => i.id)).toEqual([items.o1, items.a1]);
    expect(first.nextCursor).toBe(items.a1);
    const second = (
      await get('pm', `/users/${ids.dev}/work?limit=2&cursor=${first.nextCursor ?? ''}`)
    ).json() as UserWorkDto;
    expect(second.items.map((i) => i.id)).toEqual([items.a2]);
    expect(second.nextCursor).toBeNull();
    // One item per page walks dated items, then undated ones (Done included,
    // so two undated items follow each other).
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?includeDone=true&limit=1${cursor === null ? '' : `&cursor=${cursor}`}`;
      const pageOf = (await get('pm', `/users/${ids.dev}/work${query}`)).json() as UserWorkDto;
      seen.push(...pageOf.items.map((i) => i.id));
      cursor = pageOf.nextCursor;
    } while (cursor !== null && seen.length < 10);
    expect(seen.slice(0, 2)).toEqual([items.o1, items.a1]);
    expect(seen.slice(2).sort()).toEqual([items.a2, items.a3].sort());
    // a1 is outside the OWN scope of member: an empty page, not an error.
    const hidden = await get('member', `/users/${ids.dev}/work?cursor=${items.a1}`);
    expect(hidden.statusCode).toBe(200);
    expect((hidden.json() as UserWorkDto).items).toEqual([]);
  });

  it('orders a day by due time first, then untimed items by priority, across pages (M8.5)', async () => {
    const day = new Date('2026-11-05T00:00:00.000Z');
    await prisma.workItem.update({ where: { id: items.a1 }, data: { dueDate: day, priority: 3 } });
    await prisma.workItem.update({
      where: { id: items.a2 },
      data: { dueDate: day, dueTime: 17 * 60, priority: 4 },
    });
    await prisma.workItem.update({
      where: { id: items.a3 },
      data: { dueDate: day, priority: 1, status: 'NOT_STARTED' },
    });
    const expected = [items.o1, items.a2, items.a3, items.a1];
    expect(await workOf('pm')).toEqual(expected);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?limit=1${cursor === null ? '' : `&cursor=${cursor}`}`;
      const pageOf = (await get('pm', `/users/${ids.dev}/work${query}`)).json() as UserWorkDto;
      seen.push(...pageOf.items.map((i) => i.id));
      cursor = pageOf.nextCursor;
    } while (cursor !== null && seen.length < 10);
    expect(seen).toEqual(expected);
    const first = (await get('pm', `/users/${ids.dev}/work`)).json() as UserWorkDto;
    expect(first.items[1]).toMatchObject({ dueDate: '2026-11-05', dueTime: '17:00' });
  });

  it('rejects bad input and anonymous callers', async () => {
    expect((await get('pm', '/users/not-a-uuid/work')).statusCode).toBe(400);
    expect((await get('pm', `/users/${ids.dev}/work?includeDone=maybe`)).statusCode).toBe(400);
    const anonymous = await call(app, 'GET', `/api/v1/users/${ids.dev}/work`);
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('label style setting (db)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    const pm = await seedUser(prisma, { email: 'pm@example.org' });
    const lead = await seedUser(prisma, { email: 'lead@example.org' });
    const member = await seedUser(prisma, { email: 'member@example.org' });
    await seedUser(prisma, { email: 'admin@example.org', systemRole: 'ADMIN' });
    await seedProject(prisma, 'KLO', [
      { userId: pm.id, role: 'PM' },
      { userId: lead.id, role: 'LEAD' },
      { userId: member.id, role: 'MEMBER' },
    ]);
  });

  /**
   * Changes the label style as a user.
   *
   * @param who The caller.
   * @param labelStyle The new style.
   * @returns The response.
   */
  async function setStyle(
    who: 'pm' | 'lead' | 'member' | 'admin',
    labelStyle: unknown,
  ): Promise<Res> {
    const sid = await login(app, `${who}@example.org`);
    return call(app, 'PATCH', '/api/v1/projects/KLO', { sid, body: { settings: { labelStyle } } });
  }

  it('defaults to SOLID and is changed by PMs only, with an audit entry', async () => {
    const sid = await login(app, 'member@example.org');
    const before = (await call(app, 'GET', '/api/v1/projects/KLO', { sid })).json() as ProjectDto;
    expect(before.settings.labelStyle).toBe('SOLID');

    expect((await setStyle('lead', 'TINTED')).statusCode).toBe(403);
    expect((await setStyle('member', 'TINTED')).statusCode).toBe(403);

    const res = await setStyle('pm', 'COVER');
    expect(res.statusCode).toBe(200);
    expect((res.json() as ProjectDto).settings.labelStyle).toBe('COVER');
    const entry = await prisma.auditLog.findFirst({ where: { action: 'PROJECT_UPDATED' } });
    expect(entry?.meta).toEqual({
      changes: { 'settings.labelStyle': { from: 'SOLID', to: 'COVER' } },
    });
  });

  it('is refused for admins who are not members and on archived projects', async () => {
    const admin = await setStyle('admin', 'TINTED');
    expect(admin.statusCode).toBe(403);
    await prisma.project.update({ where: { key: 'KLO' }, data: { archivedAt: new Date() } });
    const archived = await setStyle('pm', 'TINTED');
    expect(archived.statusCode).toBe(409);
    expect(codeOf(archived)).toBe(ErrorCode.PROJECT_ARCHIVED);
    const stored = await prisma.project.findUniqueOrThrow({ where: { key: 'KLO' } });
    expect(stored.settings).not.toHaveProperty('labelStyle', 'TINTED');
  });

  it('rejects unknown styles', async () => {
    const res = await setStyle('pm', 'NEON');
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe(ErrorCode.VALIDATION_FAILED);
  });
});
