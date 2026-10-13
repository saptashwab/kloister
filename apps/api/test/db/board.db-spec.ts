import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  AuditAction,
  type BucketDto,
  type CloseSprintResult,
  ErrorCode,
  type LabelDto,
  type Page,
  type ProjectDto,
  type SprintDto,
  type WorkItemDetailDto,
} from '@kloister/shared';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  call,
  codeOf,
  login,
  type Res,
  resetDb,
  seedBucket,
  seedItem,
  seedLabel,
  seedProject,
  seedSprint,
  seedUser,
  startApp,
} from './support.js';

// Board structure against a real database: buckets with entry rules, labels
// and sprints, including the HTTP permission matrix for the SPEC §3.2 row
// "Manage buckets, labels, sprints".

type Name = 'admin' | 'pm' | 'lead' | 'member' | 'viewer' | 'outsider';

describe('board: buckets, labels, sprints (db)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  let ids: Record<Name, string>;
  let projectId: string;
  let todo: string;
  let done: string;
  let labelId: string;
  let sprintId: string;

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
    for (const name of ['admin', 'pm', 'lead', 'member', 'viewer', 'outsider'] as const) {
      seeded[name] = (
        await seedUser(prisma, {
          email: `${name}@example.org`,
          systemRole: name === 'admin' ? 'ADMIN' : 'USER',
        })
      ).id;
    }
    ids = seeded as Record<Name, string>;
    projectId = (
      await seedProject(prisma, 'KLO', [
        { userId: ids.pm, role: 'PM' },
        { userId: ids.lead, role: 'LEAD' },
        { userId: ids.member, role: 'MEMBER' },
        { userId: ids.viewer, role: 'VIEWER' },
      ])
    ).id;
    todo = (await seedBucket(prisma, projectId, 'To Do')).id;
    done = (
      await seedBucket(prisma, projectId, 'Done', { onEnterMode: 'SET', onEnterStatus: 'DONE' })
    ).id;
    labelId = (await seedLabel(prisma, projectId, 'ui')).id;
    sprintId = (await seedSprint(prisma, projectId, 'Sprint 1')).id;
  });

  const base = () => `/api/v1/projects/${projectId}`;

  /**
   * Signs in a seeded user and sends one request.
   *
   * @param name Seeded user.
   * @param method HTTP method.
   * @param url Path.
   * @param body JSON body.
   * @returns The response.
   */
  async function as(
    name: Name,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    body?: object,
  ): Promise<Res> {
    const sid = (sessions[name] ??= await login(app, `${name}@example.org`));
    return call(app, method, url, { sid, ...(body === undefined ? {} : { body }) });
  }

  describe('permission matrix (SPEC §3.2 "Manage buckets, labels, sprints")', () => {
    type Caller = Name;
    type Route = {
      name: string;
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      url: () => string;
      body?: object;
      expect: Record<Caller, number>;
    };
    const read = { pm: 200, lead: 200, member: 200, viewer: 200, outsider: 404, admin: 200 };
    const manage = (ok: number) => ({
      pm: ok,
      lead: ok,
      member: 403,
      viewer: 403,
      outsider: 404,
      admin: 403,
    });
    // Ordered so a permitted caller's run succeeds end to end.
    const routes: Route[] = [
      { name: 'list buckets', method: 'GET', url: () => `${base()}/buckets`, expect: read },
      {
        name: 'create bucket',
        method: 'POST',
        url: () => `${base()}/buckets`,
        body: { name: 'Review', onEnterMode: 'SET_IF_NOT_STARTED', onEnterStatus: 'IN_PROGRESS' },
        expect: manage(201),
      },
      {
        name: 'update bucket',
        method: 'PATCH',
        url: () => `${base()}/buckets/${todo}`,
        body: { name: 'Ready' },
        expect: manage(200),
      },
      {
        name: 'reorder bucket',
        method: 'POST',
        url: () => `${base()}/buckets/${done}/move`,
        body: {},
        expect: manage(200),
      },
      {
        name: 'delete bucket',
        method: 'DELETE',
        url: () => `${base()}/buckets/${done}`,
        expect: manage(204),
      },
      { name: 'list labels', method: 'GET', url: () => `${base()}/labels`, expect: read },
      {
        name: 'create label',
        method: 'POST',
        url: () => `${base()}/labels`,
        body: { name: 'backend', colour: '#AA00FF' },
        expect: manage(201),
      },
      {
        name: 'update label',
        method: 'PATCH',
        url: () => `${base()}/labels/${labelId}`,
        body: { colour: '#000000' },
        expect: manage(200),
      },
      {
        name: 'delete label',
        method: 'DELETE',
        url: () => `${base()}/labels/${labelId}`,
        expect: manage(204),
      },
      { name: 'list sprints', method: 'GET', url: () => `${base()}/sprints`, expect: read },
      {
        name: 'create sprint',
        method: 'POST',
        url: () => `${base()}/sprints`,
        body: { name: 'Sprint 2', startDate: '2026-11-16', endDate: '2026-11-27' },
        expect: manage(201),
      },
      {
        name: 'update sprint',
        method: 'PATCH',
        url: () => `${base()}/sprints/${sprintId}`,
        body: { adoIterationPath: 'Root\\Sprint 1' },
        expect: manage(200),
      },
      {
        name: 'start sprint',
        method: 'POST',
        url: () => `${base()}/sprints/${sprintId}/start`,
        expect: manage(200),
      },
      {
        name: 'close sprint',
        method: 'POST',
        url: () => `${base()}/sprints/${sprintId}/close`,
        body: {},
        expect: manage(200),
      },
      {
        name: 'delete sprint',
        method: 'DELETE',
        url: () => `${base()}/sprints/${sprintId}`,
        expect: manage(204),
      },
    ];

    it.each(['pm', 'lead', 'member', 'viewer', 'outsider', 'admin'] as const)(
      'enforces every board route for %s',
      async (caller) => {
        const sid = await login(app, `${caller}@example.org`);
        for (const route of routes) {
          const res = await call(app, route.method, route.url(), {
            sid,
            ...(route.body === undefined ? {} : { body: route.body }),
          });
          expect({ route: route.name, status: res.statusCode }).toEqual({
            route: route.name,
            status: route.expect[caller],
          });
          if (res.statusCode === 404) expect(codeOf(res)).toBe(ErrorCode.NOT_FOUND);
          if (res.statusCode === 403) expect(codeOf(res)).toBe(ErrorCode.FORBIDDEN);
        }
        if (caller !== 'pm' && caller !== 'lead') {
          expect(await prisma.bucket.count()).toBe(2);
          expect(await prisma.label.count()).toBe(1);
          expect(await prisma.sprint.count()).toBe(1);
        }
      },
    );

    it('refuses board changes on archived projects but still lists', async () => {
      await prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
      const create = await as('pm', 'POST', `${base()}/labels`, { name: 'x', colour: '#000000' });
      expect(codeOf(create)).toBe(ErrorCode.PROJECT_ARCHIVED);
      expect((await as('pm', 'GET', `${base()}/sprints`)).statusCode).toBe(200);
    });
  });

  describe('buckets', () => {
    it('gives new projects the default buckets of SPEC §4.2', async () => {
      const created = await as('admin', 'POST', '/api/v1/projects', {
        key: 'NEW',
        name: 'New',
        pmUserIds: [ids.pm],
      });
      expect(created.statusCode).toBe(201);
      const res = await as('pm', 'GET', '/api/v1/projects/NEW/buckets');
      expect(
        (res.json() as Page<BucketDto>).items.map((b) => [b.name, b.onEnterMode, b.onEnterStatus]),
      ).toEqual([
        ['Backlog', 'NONE', null],
        ['To Do', 'NONE', null],
        ['In Progress', 'SET_IF_NOT_STARTED', 'IN_PROGRESS'],
        ['Done', 'SET', 'DONE'],
      ]);
    });

    it('validates entry rules', async () => {
      for (const body of [
        { name: 'x', onEnterMode: 'SET' },
        { name: 'x', onEnterStatus: 'DONE' },
        { name: 'x', onEnterMode: 'SOMETIMES' },
        { name: '' },
      ]) {
        const res = await as('pm', 'POST', `${base()}/buckets`, body);
        expect({ body, status: res.statusCode }).toEqual({ body, status: 400 });
      }
      const none = await as('pm', 'PATCH', `${base()}/buckets/${done}`, { onEnterMode: 'NONE' });
      expect(none.json()).toMatchObject({ onEnterMode: 'NONE', onEnterStatus: null });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: AuditAction.BUCKET_UPDATED },
      });
      expect(audit.meta).toMatchObject({
        changes: {
          onEnterMode: { from: 'SET', to: 'NONE' },
          onEnterStatus: { from: 'DONE', to: null },
        },
      });
    });

    it('appends new buckets and reorders them', async () => {
      const created = await as('pm', 'POST', `${base()}/buckets`, { name: 'Later' });
      const later = (created.json() as BucketDto).id;
      const names = async () =>
        ((await as('pm', 'GET', `${base()}/buckets`)).json() as Page<BucketDto>).items.map(
          (b) => b.name,
        );
      expect(await names()).toEqual(['To Do', 'Done', 'Later']);
      await as('pm', 'POST', `${base()}/buckets/${later}/move`, {});
      expect(await names()).toEqual(['Later', 'To Do', 'Done']);
      await as('pm', 'POST', `${base()}/buckets/${later}/move`, { afterId: todo });
      expect(await names()).toEqual(['To Do', 'Later', 'Done']);
      const bad = await as('pm', 'POST', `${base()}/buckets/${later}/move`, { afterId: later });
      expect(bad.statusCode).toBe(400);
    });

    it('deletes a non-empty bucket only by moving its items, keeping their status', async () => {
      const a = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: done });
      const b = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: done });
      await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
      const refused = await as('pm', 'DELETE', `${base()}/buckets/${done}`);
      expect(refused.statusCode).toBe(409);
      expect(codeOf(refused)).toBe(ErrorCode.BUCKET_NOT_EMPTY);
      const self = await as('pm', 'DELETE', `${base()}/buckets/${done}?moveItemsTo=${done}`);
      expect(self.statusCode).toBe(400);
      const moved = await as('pm', 'DELETE', `${base()}/buckets/${done}?moveItemsTo=${todo}`);
      expect(moved.statusCode).toBe(204);
      const rows = await prisma.workItem.findMany({ orderBy: { position: 'asc' } });
      expect(rows.map((r) => [r.number, r.bucketId, r.status])).toEqual([
        [3, todo, 'NOT_STARTED'],
        [a.number, todo, 'NOT_STARTED'],
        [b.number, todo, 'NOT_STARTED'],
      ]);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: AuditAction.BUCKET_DELETED },
      });
      expect(audit.meta).toMatchObject({ name: 'Done', movedItems: 2, movedTo: todo });
    });

    it('never deletes the last bucket', async () => {
      expect((await as('pm', 'DELETE', `${base()}/buckets/${done}`)).statusCode).toBe(204);
      const last = await as('pm', 'DELETE', `${base()}/buckets/${todo}`);
      expect(last.statusCode).toBe(409);
      expect(codeOf(last)).toBe(ErrorCode.CONFLICT);
    });

    it('removes a deleted bucket from member scopes and the status map', async () => {
      await prisma.projectMember.update({
        where: { projectId_userId: { projectId, userId: ids.member } },
        data: { visibility: 'BUCKETS', allowedBucketIds: [todo, done] },
      });
      const settings = await as('pm', 'PATCH', base(), {
        settings: { statusToBucket: { DONE: done, NOT_STARTED: todo } },
      });
      expect((settings.json() as ProjectDto).settings.statusToBucket).toEqual({
        DONE: done,
        NOT_STARTED: todo,
      });
      expect((await as('pm', 'DELETE', `${base()}/buckets/${done}`)).statusCode).toBe(204);
      const member = await prisma.projectMember.findUniqueOrThrow({
        where: { projectId_userId: { projectId, userId: ids.member } },
      });
      expect(member.allowedBucketIds).toEqual([todo]);
      const project = (await as('pm', 'GET', base())).json() as ProjectDto;
      expect(project.settings.statusToBucket).toEqual({ NOT_STARTED: todo });
    });

    it('accepts only project buckets in BUCKETS scopes and the status map', async () => {
      const other = await seedProject(prisma, 'OTH', [{ userId: ids.pm, role: 'PM' }]);
      const foreign = await seedBucket(prisma, other.id, 'Theirs');
      const scope = await as('pm', 'PATCH', `${base()}/members/${ids.member}`, {
        visibility: 'BUCKETS',
        allowedBucketIds: [todo, foreign.id],
      });
      expect(scope.statusCode).toBe(400);
      const ok = await as('pm', 'PATCH', `${base()}/members/${ids.member}`, {
        visibility: 'BUCKETS',
        allowedBucketIds: [todo],
      });
      expect(ok.json()).toMatchObject({ allowedBucketIds: [todo] });
      const add = await as('pm', 'POST', `${base()}/members`, {
        userId: ids.outsider,
        role: 'VIEWER',
        visibility: 'BUCKETS',
        allowedBucketIds: [foreign.id],
      });
      expect(add.statusCode).toBe(400);
      for (const statusToBucket of [
        { DONE: foreign.id },
        { LATER: todo },
        { DONE: 'not-a-uuid' },
        [todo],
      ]) {
        const res = await as('pm', 'PATCH', base(), { settings: { statusToBucket } });
        expect({ statusToBucket, status: res.statusCode }).toEqual({ statusToBucket, status: 400 });
      }
      // Leads manage buckets but not project settings.
      const lead = await as('lead', 'PATCH', base(), { settings: { statusToBucket: {} } });
      expect(lead.statusCode).toBe(403);
    });

    it('answers 404 for buckets of other projects', async () => {
      const other = await seedProject(prisma, 'OTH', [{ userId: ids.outsider, role: 'PM' }]);
      const foreign = await seedBucket(prisma, other.id, 'Theirs');
      for (const [method, url] of [
        ['PATCH', `${base()}/buckets/${foreign.id}`],
        ['POST', `${base()}/buckets/${foreign.id}/move`],
        ['DELETE', `${base()}/buckets/${foreign.id}`],
      ] as const) {
        const body = method === 'PATCH' ? { name: 'x' } : method === 'POST' ? {} : undefined;
        const res = await as('pm', method, url, body);
        expect({ url, status: res.statusCode }).toEqual({ url, status: 404 });
      }
    });
  });

  describe('labels', () => {
    it('keeps names unique per project and lowercases colours', async () => {
      const dup = await as('pm', 'POST', `${base()}/labels`, { name: 'ui', colour: '#000000' });
      expect(dup.statusCode).toBe(409);
      const created = await as('pm', 'POST', `${base()}/labels`, {
        name: 'api',
        colour: '#ABCDEF',
      });
      expect(created.json()).toMatchObject({ name: 'api', colour: '#abcdef' });
      for (const colour of ['red', '#abc', '#GGGGGG']) {
        const res = await as('pm', 'POST', `${base()}/labels`, { name: 'x', colour });
        expect({ colour, status: res.statusCode }).toEqual({ colour, status: 400 });
      }
      const list = (await as('viewer', 'GET', `${base()}/labels`)).json() as Page<LabelDto>;
      expect(list.items.map((l) => l.name)).toEqual(['api', 'ui']);
    });

    it('removes a deleted label from items', async () => {
      const itemRow = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
      await as('pm', 'PATCH', `${base()}/items/${itemRow.number}`, { labelIds: [labelId] });
      expect((await as('pm', 'DELETE', `${base()}/labels/${labelId}`)).statusCode).toBe(204);
      const res = await as('pm', 'GET', `${base()}/items/${itemRow.number}`);
      expect((res.json() as WorkItemDetailDto).labelIds).toEqual([]);
    });
  });

  describe('sprints', () => {
    it('validates dates', async () => {
      const backwards = await as('pm', 'POST', `${base()}/sprints`, {
        name: 'x',
        startDate: '2026-11-10',
        endDate: '2026-11-09',
      });
      expect(backwards.statusCode).toBe(400);
      const invalid = await as('pm', 'POST', `${base()}/sprints`, {
        name: 'x',
        startDate: '2026-11-31',
        endDate: '2026-12-09',
      });
      expect(invalid.statusCode).toBe(400);
      const patch = await as('pm', 'PATCH', `${base()}/sprints/${sprintId}`, {
        endDate: '2026-11-01',
      });
      expect(patch.statusCode).toBe(400);
      const ok = await as('pm', 'PATCH', `${base()}/sprints/${sprintId}`, {
        endDate: '2026-11-20',
      });
      expect(ok.json()).toMatchObject({ startDate: '2026-11-02', endDate: '2026-11-20' });
    });

    it('keeps one active sprint and never restarts a closed one', async () => {
      const second = await seedSprint(prisma, projectId, 'Sprint 2');
      expect((await as('pm', 'POST', `${base()}/sprints/${sprintId}/start`)).statusCode).toBe(200);
      const both = await as('pm', 'POST', `${base()}/sprints/${second.id}/start`);
      expect(both.statusCode).toBe(409);
      // Starting the active sprint again is a no-op.
      expect((await as('pm', 'POST', `${base()}/sprints/${sprintId}/start`)).statusCode).toBe(200);
      expect((await as('pm', 'POST', `${base()}/sprints/${sprintId}/close`, {})).statusCode).toBe(
        200,
      );
      expect((await as('pm', 'POST', `${base()}/sprints/${sprintId}/start`)).statusCode).toBe(409);
      expect((await as('pm', 'POST', `${base()}/sprints/${sprintId}/close`, {})).statusCode).toBe(
        409,
      );
      expect((await as('pm', 'POST', `${base()}/sprints/${second.id}/start`)).statusCode).toBe(200);
    });

    it('closes a sprint, moving unfinished items to another sprint or the backlog', async () => {
      const next = await seedSprint(prisma, projectId, 'Sprint 2');
      const closedSprint = await seedSprint(prisma, projectId, 'Old', 'CLOSED');
      const open = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        bucketId: todo,
        sprintId,
      });
      const finished = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        bucketId: done,
        sprintId,
        status: 'DONE',
      });
      for (const target of [sprintId, closedSprint.id, '00000000-0000-4000-8000-000000000000']) {
        const res = await as('pm', 'POST', `${base()}/sprints/${sprintId}/close`, {
          moveUnfinishedTo: target,
        });
        expect({ target, status: res.statusCode }).toEqual({ target, status: 400 });
      }
      const res = await as('pm', 'POST', `${base()}/sprints/${sprintId}/close`, {
        moveUnfinishedTo: next.id,
      });
      const result = res.json() as CloseSprintResult;
      expect(result.movedItems).toBe(1);
      expect(result.sprint.state).toBe('CLOSED');
      const rows = await prisma.workItem.findMany({ orderBy: { number: 'asc' } });
      expect(rows.map((r) => [r.id, r.sprintId])).toEqual([
        [open.id, next.id],
        [finished.id, sprintId],
      ]);
      // Closed sprints take no new items.
      const add = await as('pm', 'PATCH', `${base()}/items/${finished.number}`, { sprintId });
      expect(add.statusCode).toBe(200);
      const moveIn = await as('pm', 'PATCH', `${base()}/items/${open.number}`, { sprintId });
      expect(moveIn.statusCode).toBe(400);
      // Moving to the backlog clears the sprint.
      const toBacklog = await as('pm', 'POST', `${base()}/sprints/${next.id}/close`, {
        moveUnfinishedTo: null,
      });
      expect((toBacklog.json() as CloseSprintResult).movedItems).toBe(1);
      expect((await prisma.workItem.findUniqueOrThrow({ where: { id: open.id } })).sprintId).toBe(
        null,
      );
    });

    it('deleting a sprint leaves its items without one', async () => {
      const itemRow = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        bucketId: todo,
        sprintId,
      });
      expect((await as('lead', 'DELETE', `${base()}/sprints/${sprintId}`)).statusCode).toBe(204);
      expect(
        (await prisma.workItem.findUniqueOrThrow({ where: { id: itemRow.id } })).sprintId,
      ).toBeNull();
      const list = (await as('pm', 'GET', `${base()}/sprints`)).json() as Page<SprintDto>;
      expect(list.items).toEqual([]);
    });
  });
});
