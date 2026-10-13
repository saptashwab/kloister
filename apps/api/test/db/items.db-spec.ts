import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  AuditAction,
  type AuditEntryDto,
  type ChecklistItemDto,
  ErrorCode,
  type Page,
  type WorkItemDetailDto,
  type WorkItemDto,
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
  seedTeam,
  seedUser,
  startApp,
} from './support.js';

// Work items against a real database: the HTTP permission tests for every
// item row of SPEC §3.2, every visibility scope of §3.3 and every team rule
// of §3.5, plus the hierarchy (§4.1) and bucket/status rules (§4.2).

const NAMES = [
  'admin',
  'pm',
  'lead',
  'member',
  'member2',
  'viewer',
  'teamLead',
  'outsider',
] as const;
type Name = (typeof NAMES)[number];

describe('work items (db)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  /** Seeded user ids by name. */
  let ids: Record<Name, string>;
  let projectId: string;
  /** Seeded buckets: todo (no rule), doing (SET_IF_NOT_STARTED → IN_PROGRESS), done (SET → DONE). */
  let buckets: Record<'todo' | 'doing' | 'done', string>;
  /** T1: teamLead leads it, member is a Member. T2: member2 is a Member. */
  let teams: Record<'t1' | 't2', string>;
  /** Seeded item numbers. */
  const N = {
    epic: 1,
    feature: 2,
    story: 3,
    theirs: 4,
    mine: 5,
    assigned: 6,
    teamItem: 7,
    memberParent: 8,
    memberChild: 9,
  } as const;
  let itemIds: Record<keyof typeof N, string>;

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
    projectId = (
      await seedProject(prisma, 'KLO', [
        { userId: ids.pm, role: 'PM' },
        { userId: ids.lead, role: 'LEAD' },
        { userId: ids.member, role: 'MEMBER' },
        { userId: ids.member2, role: 'MEMBER' },
        { userId: ids.viewer, role: 'VIEWER' },
        // A project Member with the narrowest scope, who leads team T1.
        { userId: ids.teamLead, role: 'MEMBER', visibility: 'OWN' },
      ])
    ).id;
    buckets = {
      todo: (await seedBucket(prisma, projectId, 'To Do')).id,
      doing: (
        await seedBucket(prisma, projectId, 'Doing', {
          onEnterMode: 'SET_IF_NOT_STARTED',
          onEnterStatus: 'IN_PROGRESS',
        })
      ).id,
      done: (
        await seedBucket(prisma, projectId, 'Done', { onEnterMode: 'SET', onEnterStatus: 'DONE' })
      ).id,
    };
    teams = {
      t1: (
        await seedTeam(prisma, projectId, 'T1', [
          { userId: ids.teamLead, role: 'LEAD' },
          { userId: ids.member, role: 'MEMBER' },
        ])
      ).id,
      t2: (await seedTeam(prisma, projectId, 'T2', [{ userId: ids.member2, role: 'MEMBER' }])).id,
    };
    const pm = ids.pm;
    const epic = await seedItem(prisma, projectId, {
      createdById: pm,
      type: 'EPIC',
      title: 'Epic',
    });
    const feature = await seedItem(prisma, projectId, {
      createdById: pm,
      type: 'FEATURE',
      title: 'Feature',
      parentId: epic.id,
    });
    const story = await seedItem(prisma, projectId, {
      createdById: pm,
      type: 'STORY',
      title: 'Story',
      parentId: feature.id,
      bucketId: buckets.todo,
    });
    const theirs = await seedItem(prisma, projectId, {
      createdById: pm,
      parentId: story.id,
      bucketId: buckets.todo,
    });
    const mine = await seedItem(prisma, projectId, {
      createdById: ids.member,
      bucketId: buckets.todo,
    });
    const assigned = await seedItem(prisma, projectId, {
      createdById: pm,
      bucketId: buckets.doing,
      assigneeIds: [ids.member],
    });
    const teamItem = await seedItem(prisma, projectId, {
      createdById: pm,
      bucketId: buckets.todo,
      teamId: teams.t1,
    });
    const memberParent = await seedItem(prisma, projectId, {
      createdById: ids.member,
      type: 'STORY',
      bucketId: buckets.todo,
    });
    const memberChild = await seedItem(prisma, projectId, {
      createdById: ids.member,
      parentId: memberParent.id,
      bucketId: buckets.todo,
    });
    itemIds = {
      epic: epic.id,
      feature: feature.id,
      story: story.id,
      theirs: theirs.id,
      mine: mine.id,
      assigned: assigned.id,
      teamItem: teamItem.id,
      memberParent: memberParent.id,
      memberChild: memberChild.id,
    };
  });

  const items = () => `/api/v1/projects/${projectId}/items`;
  const item = (n: number | string) => `${items()}/${n}`;

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
    const sid = (sessions[name] ??= await login(app, `${name.toLowerCase()}@example.org`));
    return call(app, method, url, { sid, ...(body === undefined ? {} : { body }) });
  }

  /**
   * Changes a member's stored visibility directly.
   *
   * @param name Seeded user.
   * @param visibility New scope.
   * @param allowedBucketIds Buckets for the BUCKETS scope.
   */
  async function setScope(
    name: Name,
    visibility: 'ALL' | 'BUCKETS' | 'OWN' | 'TEAMS',
    allowedBucketIds: string[] = [],
  ): Promise<void> {
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId, userId: ids[name] } },
      data: { visibility, allowedBucketIds },
    });
  }

  /**
   * Lists the item numbers a user sees.
   *
   * @param name Seeded user.
   * @param query Optional query string.
   * @returns Sorted item numbers.
   */
  async function visibleNumbers(name: Name, query = ''): Promise<number[]> {
    const res = await as(name, 'GET', `${items()}?limit=100${query}`);
    expect(res.statusCode).toBe(200);
    return (res.json() as Page<WorkItemDto>).items.map((i) => i.number).sort((a, b) => a - b);
  }

  describe('permission matrix (SPEC §3.2 item rows)', () => {
    type Caller = 'pm' | 'lead' | 'member' | 'viewer' | 'outsider' | 'admin';
    const CALLERS: Caller[] = ['pm', 'lead', 'member', 'viewer', 'outsider', 'admin'];
    type Row = {
      name: string;
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      url: () => string;
      body?: (caller: Caller) => object;
      setting?: boolean;
      /** Extra rows the route needs, created before the request. */
      setup?: () => Promise<void>;
      expect: Record<Caller, number>;
    };
    // Non-members get 404; admins who are not members are read-only (403).
    const refusedOutside = { outsider: 404, admin: 403 };
    const ROWS: Row[] = [
      {
        name: 'view items',
        method: 'GET',
        url: () => item(N.theirs),
        expect: { pm: 200, lead: 200, member: 200, viewer: 200, outsider: 404, admin: 200 },
      },
      {
        name: 'list items',
        method: 'GET',
        url: items,
        expect: { pm: 200, lead: 200, member: 200, viewer: 200, outsider: 404, admin: 200 },
      },
      {
        name: 'create items',
        method: 'POST',
        url: items,
        body: () => ({ type: 'TASK', title: 'New', bucketId: buckets.todo }),
        expect: { pm: 201, lead: 201, member: 201, viewer: 403, ...refusedOutside },
      },
      {
        name: 'edit any item',
        method: 'PATCH',
        url: () => item(N.theirs),
        body: () => ({ title: 'Edited' }),
        expect: { pm: 200, lead: 200, member: 403, viewer: 403, ...refusedOutside },
      },
      {
        name: 'edit items created by self',
        method: 'PATCH',
        url: () => item(N.mine),
        body: () => ({ title: 'Edited' }),
        expect: { pm: 200, lead: 200, member: 200, viewer: 403, ...refusedOutside },
      },
      {
        name: 'edit items assigned to self',
        method: 'PATCH',
        url: () => item(N.assigned),
        body: () => ({ priority: 1 }),
        expect: { pm: 200, lead: 200, member: 200, viewer: 403, ...refusedOutside },
      },
      {
        name: 'assign items to others (setting off)',
        method: 'PATCH',
        url: () => item(N.mine),
        body: () => ({ assigneeIds: [ids.member2] }),
        expect: { pm: 200, lead: 200, member: 403, viewer: 403, ...refusedOutside },
      },
      {
        name: 'assign items to others (setting on)',
        method: 'PATCH',
        url: () => item(N.mine),
        body: () => ({ assigneeIds: [ids.member2] }),
        setting: true,
        expect: { pm: 200, lead: 200, member: 200, viewer: 403, ...refusedOutside },
      },
      {
        name: 'assign items to self',
        method: 'PATCH',
        url: () => item(N.mine),
        body: (caller) => ({ assigneeIds: [ids[caller]] }),
        expect: { pm: 200, lead: 200, member: 200, viewer: 403, ...refusedOutside },
      },
      {
        name: 'move any card',
        method: 'POST',
        url: () => `${item(N.theirs)}/move`,
        body: () => ({ bucketId: buckets.doing }),
        expect: { pm: 200, lead: 200, member: 403, viewer: 403, ...refusedOutside },
      },
      {
        name: 'move own and assigned cards',
        method: 'POST',
        url: () => `${item(N.assigned)}/move`,
        body: () => ({ bucketId: buckets.done }),
        expect: { pm: 200, lead: 200, member: 200, viewer: 403, ...refusedOutside },
      },
      {
        name: 'move cards created by self',
        method: 'POST',
        url: () => `${item(N.mine)}/move`,
        body: () => ({ bucketId: buckets.doing }),
        expect: { pm: 200, lead: 200, member: 200, viewer: 403, ...refusedOutside },
      },
      {
        name: 'delete any item',
        method: 'DELETE',
        url: () => item(N.theirs),
        expect: { pm: 204, lead: 204, member: 403, viewer: 403, ...refusedOutside },
      },
      {
        name: 'delete own created item without children',
        method: 'DELETE',
        url: () => item(N.mine),
        expect: { pm: 204, lead: 204, member: 204, viewer: 403, ...refusedOutside },
      },
      {
        name: 'delete an assigned (not created) item',
        method: 'DELETE',
        url: () => item(N.assigned),
        expect: { pm: 204, lead: 204, member: 403, viewer: 403, ...refusedOutside },
      },
      {
        name: 'delete own created item with children',
        method: 'DELETE',
        url: () => item(N.memberParent),
        // PMs and Leads may, but must cascade (409 HAS_CHILDREN).
        expect: { pm: 409, lead: 409, member: 403, viewer: 403, ...refusedOutside },
      },
      {
        name: 'delete with cascade',
        method: 'DELETE',
        url: () => `${item(N.memberParent)}?cascade=true`,
        expect: { pm: 204, lead: 204, member: 403, viewer: 403, ...refusedOutside },
      },
    ];

    /** A checklist line on the Member's own item, and a dependency of it. */
    let lineId = '';
    const withLine = async (): Promise<void> => {
      lineId = (
        await prisma.checklistItem.create({
          data: { workItemId: itemIds.mine, text: 'Line', position: 1024 },
        })
      ).id;
    };
    const withDependency = async (): Promise<void> => {
      await prisma.workItemDependency.create({
        data: { projectId, blockedItemId: itemIds.mine, blockingItemId: itemIds.theirs },
      });
    };
    const read = { pm: 200, lead: 200, member: 200, viewer: 200, outsider: 404, admin: 200 };
    const editOwn = (ok: number) => ({
      pm: ok,
      lead: ok,
      member: ok,
      viewer: 403,
      ...refusedOutside,
    });
    const editAny = (ok: number) => ({
      pm: ok,
      lead: ok,
      member: 403,
      viewer: 403,
      ...refusedOutside,
    });
    ROWS.push(
      {
        name: 'list children',
        method: 'GET',
        url: () => `${item(N.story)}/children`,
        expect: read,
      },
      {
        name: 'read activity',
        method: 'GET',
        url: () => `${item(N.theirs)}/activity`,
        expect: read,
      },
      {
        name: 'read checklist',
        method: 'GET',
        url: () => `${item(N.theirs)}/checklist`,
        expect: read,
      },
      {
        name: 'add checklist line to own item',
        method: 'POST',
        url: () => `${item(N.mine)}/checklist`,
        body: () => ({ text: 'New' }),
        expect: editOwn(201),
      },
      {
        name: "add checklist line to another's item",
        method: 'POST',
        url: () => `${item(N.theirs)}/checklist`,
        body: () => ({ text: 'New' }),
        expect: editAny(201),
      },
      {
        name: 'tick checklist line',
        method: 'PATCH',
        url: () => `${item(N.mine)}/checklist/${lineId}`,
        body: () => ({ done: true }),
        setup: withLine,
        expect: editOwn(200),
      },
      {
        name: 'reorder checklist line',
        method: 'POST',
        url: () => `${item(N.mine)}/checklist/${lineId}/move`,
        body: () => ({}),
        setup: withLine,
        expect: editOwn(200),
      },
      {
        name: 'delete checklist line',
        method: 'DELETE',
        url: () => `${item(N.mine)}/checklist/${lineId}`,
        setup: withLine,
        expect: editOwn(204),
      },
      {
        name: 'add dependency to own item',
        method: 'POST',
        url: () => `${item(N.mine)}/dependencies`,
        body: () => ({ blockingItemId: itemIds.theirs }),
        expect: editOwn(200),
      },
      {
        name: "add dependency to another's item",
        method: 'POST',
        url: () => `${item(N.theirs)}/dependencies`,
        body: () => ({ blockingItemId: itemIds.assigned }),
        expect: editAny(200),
      },
      {
        name: 'remove dependency from own item',
        method: 'DELETE',
        url: () => `${item(N.mine)}/dependencies/${itemIds.theirs}`,
        setup: withDependency,
        expect: editOwn(200),
      },
    );

    for (const row of ROWS) {
      for (const caller of CALLERS) {
        it(`${row.name}: ${caller} → ${row.expect[caller]}`, async () => {
          await row.setup?.();
          // Sign in first so the login's own audit row is part of the baseline.
          sessions[caller] ??= await login(app, `${caller.toLowerCase()}@example.org`);
          const before = {
            checklist: await prisma.checklistItem.findMany({ orderBy: { id: 'asc' } }),
            dependencies: await prisma.workItemDependency.count(),
            audit: await prisma.auditLog.count({
              where: { action: { not: AuditAction.ADMIN_CROSS_PROJECT_ACCESS } },
            }),
          };
          if (row.setting === true) {
            await prisma.project.update({
              where: { id: projectId },
              data: { settings: { membersCanAssignOthers: true } },
            });
          }
          const res = await as(caller, row.method, row.url(), row.body?.(caller));
          expect(res.statusCode).toBe(row.expect[caller]);
          if (res.statusCode === 404) expect(codeOf(res)).toBe(ErrorCode.NOT_FOUND);
          if (res.statusCode === 403) expect(codeOf(res)).toBe(ErrorCode.FORBIDDEN);
          if (res.statusCode === 409) expect(codeOf(res)).toBe(ErrorCode.HAS_CHILDREN);
          if (res.statusCode >= 400) {
            // A refused request changes nothing.
            expect(await prisma.workItem.count()).toBe(Object.keys(N).length);
            expect(
              await prisma.auditLog.count({
                where: { action: { not: AuditAction.ADMIN_CROSS_PROJECT_ACCESS } },
              }),
            ).toBe(before.audit);
            expect(await prisma.checklistItem.findMany({ orderBy: { id: 'asc' } })).toEqual(
              before.checklist,
            );
            expect(await prisma.workItemDependency.count()).toBe(before.dependencies);
          }
        });
      }
    }

    it('notes and attachments: reported per item until the M5 endpoints exist', async () => {
      const annotate: Record<string, boolean> = {};
      for (const caller of ['pm', 'lead', 'member', 'viewer', 'admin'] as const) {
        const res = await as(caller, 'GET', item(N.theirs));
        annotate[caller] = (res.json() as WorkItemDetailDto).can.annotate;
      }
      expect(annotate).toEqual({ pm: true, lead: true, member: true, viewer: false, admin: false });
    });

    it('reports capabilities that match the rules', async () => {
      const mine = (await as('member', 'GET', item(N.mine))).json() as WorkItemDetailDto;
      expect(mine.can).toEqual({
        edit: true,
        move: true,
        delete: true,
        deleteCascade: false,
        annotate: true,
      });
      const theirs = (await as('member', 'GET', item(N.theirs))).json() as WorkItemDetailDto;
      expect(theirs.can).toMatchObject({ edit: false, move: false, delete: false });
      const lead = (await as('lead', 'GET', item(N.story))).json() as WorkItemDetailDto;
      expect(lead.can).toMatchObject({ edit: true, delete: true, deleteCascade: true });
    });
  });

  describe('visibility scopes (SPEC §3.3)', () => {
    it('ALL: a Member sees every item', async () => {
      expect(await visibleNumbers('member')).toEqual(Object.values(N).sort((a, b) => a - b));
    });

    it('BUCKETS: only items in the chosen buckets; others are 404', async () => {
      await setScope('member', 'BUCKETS', [buckets.todo]);
      expect(await visibleNumbers('member')).toEqual([
        N.story,
        N.theirs,
        N.mine,
        N.teamItem,
        N.memberParent,
        N.memberChild,
      ]);
      // The assigned card sits in "Doing", outside the scope: every route says 404.
      for (const [method, url, body] of [
        ['GET', item(N.assigned), undefined],
        ['PATCH', item(N.assigned), { title: 'x' }],
        ['POST', `${item(N.assigned)}/move`, { bucketId: buckets.todo }],
        ['DELETE', item(N.assigned), undefined],
        ['GET', `${item(N.assigned)}/children`, undefined],
        ['GET', `${item(N.assigned)}/activity`, undefined],
        ['GET', `${item(N.assigned)}/checklist`, undefined],
        ['POST', `${item(N.assigned)}/checklist`, { text: 'x' }],
        ['POST', `${item(N.assigned)}/dependencies`, { blockingItemId: itemIds.mine }],
        ['GET', item(N.epic), undefined],
      ] as const) {
        const res = await as('member', method, url, body);
        expect({ method, url, status: res.statusCode }).toEqual({ method, url, status: 404 });
      }
    });

    it('OWN: only items created by or assigned to the user', async () => {
      await setScope('member', 'OWN');
      expect(await visibleNumbers('member')).toEqual([
        N.mine,
        N.assigned,
        N.memberParent,
        N.memberChild,
      ]);
      expect((await as('member', 'GET', item(N.theirs))).statusCode).toBe(404);
    });

    it('TEAMS: only items of the teams the user belongs to', async () => {
      await setScope('member', 'TEAMS');
      expect(await visibleNumbers('member')).toEqual([N.teamItem]);
      await setScope('member2', 'TEAMS');
      expect(await visibleNumbers('member2')).toEqual([]);
      expect((await as('member2', 'GET', item(N.teamItem))).statusCode).toBe(404);
    });

    it('scopes apply to Viewers the same way', async () => {
      await setScope('viewer', 'OWN');
      expect(await visibleNumbers('viewer')).toEqual([]);
      await setScope('viewer', 'BUCKETS', [buckets.doing]);
      expect(await visibleNumbers('viewer')).toEqual([N.assigned]);
      // Viewers may not write at all, so every write is 403 whichever item it names.
      expect((await as('viewer', 'GET', item(N.assigned))).statusCode).toBe(200);
      expect((await as('viewer', 'PATCH', item(N.theirs), { title: 'x' })).statusCode).toBe(403);
    });

    it('out-of-scope items are 404 even where in-scope ones would be 403', async () => {
      await setScope('member', 'BUCKETS', [buckets.todo]);
      expect((await as('member', 'PATCH', item(N.theirs), { title: 'x' })).statusCode).toBe(403);
      expect((await as('member', 'PATCH', item(N.assigned), { title: 'x' })).statusCode).toBe(404);
    });

    it('shows ancestors of visible items as read-only titles only', async () => {
      await setScope('member', 'BUCKETS', [buckets.todo]);
      const res = await as('member', 'GET', item(N.theirs));
      const detail = res.json() as WorkItemDetailDto;
      expect(detail.ancestors).toEqual([
        { id: itemIds.epic, number: N.epic, key: 'KLO-1', type: 'EPIC', title: 'Epic' },
        { id: itemIds.feature, number: N.feature, key: 'KLO-2', type: 'FEATURE', title: 'Feature' },
        { id: itemIds.story, number: N.story, key: 'KLO-3', type: 'STORY', title: 'Story' },
      ]);
      const list = (await as('member', 'GET', `${items()}?type=TASK`)).json() as Page<WorkItemDto>;
      expect(list.items.find((i) => i.number === N.theirs)?.ancestors.map((a) => a.title)).toEqual([
        'Epic',
        'Feature',
        'Story',
      ]);
    });

    it('lists only visible children', async () => {
      await prisma.workItem.update({
        where: { id: itemIds.assigned },
        data: { parentId: itemIds.story },
      });
      await setScope('member', 'BUCKETS', [buckets.todo]);
      const res = await as('member', 'GET', `${item(N.story)}/children`);
      expect((res.json() as Page<WorkItemDto>).items.map((i) => i.number)).toEqual([N.theirs]);
      const pm = await as('pm', 'GET', `${item(N.story)}/children`);
      expect((pm.json() as Page<WorkItemDto>).items.map((i) => i.number)).toEqual([
        N.theirs,
        N.assigned,
      ]);
    });

    it('PMs and Leads see everything whatever is stored for them', async () => {
      await setScope('lead', 'OWN');
      await setScope('pm', 'TEAMS');
      expect(await visibleNumbers('lead')).toHaveLength(Object.keys(N).length);
      expect(await visibleNumbers('pm')).toHaveLength(Object.keys(N).length);
    });

    it('does not let a caller create or move cards outside their own scope', async () => {
      await setScope('member', 'BUCKETS', [buckets.todo]);
      const create = await as('member', 'POST', items(), {
        type: 'TASK',
        title: 'x',
        bucketId: buckets.doing,
      });
      expect(create.statusCode).toBe(400);
      const move = await as('member', 'POST', `${item(N.mine)}/move`, { bucketId: buckets.done });
      expect(move.statusCode).toBe(400);
      expect(
        (await prisma.workItem.findUniqueOrThrow({ where: { id: itemIds.mine } })).bucketId,
      ).toBe(buckets.todo);
    });

    it('does not accept invisible items as parents, neighbours or blockers', async () => {
      await setScope('member', 'OWN');
      const parent = await as('member', 'PATCH', item(N.mine), { parentId: itemIds.story });
      expect(parent.statusCode).toBe(400);
      const blocker = await as('member', 'POST', `${item(N.mine)}/dependencies`, {
        blockingItemId: itemIds.theirs,
      });
      expect(blocker.statusCode).toBe(400);
      const neighbour = await as('member', 'POST', `${item(N.mine)}/move`, {
        afterId: itemIds.theirs,
      });
      expect(neighbour.statusCode).toBe(400);
    });
  });

  describe('teams (SPEC §3.5)', () => {
    it('a team Lead has Lead rights on team items whatever their scope', async () => {
      // teamLead is a project Member with the OWN scope who leads T1.
      expect(await visibleNumbers('teamLead')).toEqual([N.teamItem]);
      expect((await as('teamLead', 'GET', item(N.teamItem))).statusCode).toBe(200);
      expect((await as('teamLead', 'PATCH', item(N.teamItem), { title: 'T' })).statusCode).toBe(
        200,
      );
      const assign = await as('teamLead', 'PATCH', item(N.teamItem), {
        assigneeIds: [ids.member2],
      });
      expect(assign.statusCode).toBe(200);
      const move = await as('teamLead', 'POST', `${item(N.teamItem)}/move`, {
        bucketId: buckets.doing,
      });
      expect(move.statusCode).toBe(200);
      expect((await as('teamLead', 'DELETE', item(N.teamItem))).statusCode).toBe(204);
    });

    it('team Lead rights stop at the team', async () => {
      expect((await as('teamLead', 'GET', item(N.theirs))).statusCode).toBe(404);
      await setScope('teamLead', 'ALL');
      expect((await as('teamLead', 'PATCH', item(N.theirs), { title: 'x' })).statusCode).toBe(403);
      expect((await as('teamLead', 'DELETE', item(N.theirs))).statusCode).toBe(403);
    });

    it('team Leads cannot cascade-delete', async () => {
      const parent = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        type: 'STORY',
        bucketId: buckets.todo,
        teamId: teams.t1,
      });
      await seedItem(prisma, projectId, {
        createdById: ids.pm,
        parentId: parent.id,
        bucketId: buckets.todo,
      });
      const cascade = await as('teamLead', 'DELETE', `${item(parent.number)}?cascade=true`);
      expect(cascade.statusCode).toBe(403);
      const plain = await as('teamLead', 'DELETE', item(parent.number));
      expect(plain.statusCode).toBe(409);
      expect(codeOf(plain)).toBe(ErrorCode.HAS_CHILDREN);
    });

    it('team membership alone adds nothing to the project role', async () => {
      // member is a Member of T1, not its Lead.
      expect((await as('member', 'PATCH', item(N.teamItem), { title: 'x' })).statusCode).toBe(403);
      const move = await as('member', 'POST', `${item(N.teamItem)}/move`, {
        bucketId: buckets.doing,
      });
      expect(move.statusCode).toBe(403);
    });

    it('a Viewer stored as team Lead gets no Lead rights', async () => {
      await prisma.teamMember.create({
        data: { teamId: teams.t1, projectId, userId: ids.viewer, role: 'LEAD' },
      });
      expect((await as('viewer', 'PATCH', item(N.teamItem), { title: 'x' })).statusCode).toBe(403);
      expect((await as('viewer', 'DELETE', item(N.teamItem))).statusCode).toBe(403);
    });

    it('decides who may set an item team', async () => {
      const inOwnTeam = await as('member', 'POST', items(), {
        type: 'TASK',
        title: 'Mine in T1',
        bucketId: buckets.todo,
        teamId: teams.t1,
      });
      expect(inOwnTeam.statusCode).toBe(201);
      const inOtherTeam = await as('member', 'POST', items(), {
        type: 'TASK',
        title: 'x',
        bucketId: buckets.todo,
        teamId: teams.t2,
      });
      expect(inOtherTeam.statusCode).toBe(403);
      // Editing: a plain team Member cannot move an item into a team.
      expect((await as('member', 'PATCH', item(N.mine), { teamId: teams.t1 })).statusCode).toBe(
        403,
      );
      // A team Lead moves their own items into and out of the team they lead.
      const own = await seedItem(prisma, projectId, {
        createdById: ids.teamLead,
        bucketId: buckets.todo,
      });
      expect(
        (await as('teamLead', 'PATCH', item(own.number), { teamId: teams.t1 })).statusCode,
      ).toBe(200);
      expect((await as('teamLead', 'PATCH', item(N.teamItem), { teamId: null })).statusCode).toBe(
        200,
      );
      expect(
        (await as('teamLead', 'PATCH', item(own.number), { teamId: teams.t2 })).statusCode,
      ).toBe(403);
      // Project PMs and Leads set any team.
      expect((await as('lead', 'PATCH', item(N.theirs), { teamId: teams.t2 })).statusCode).toBe(
        200,
      );
      expect(
        (
          await as('pm', 'PATCH', item(N.theirs), {
            teamId: '00000000-0000-4000-8000-000000000000',
          })
        ).statusCode,
      ).toBe(400);
    });

    it('a TEAMS-scope Member creates items in their team and sees them', async () => {
      await setScope('member', 'TEAMS');
      const created = await as('member', 'POST', items(), {
        type: 'TASK',
        title: 'Team work',
        bucketId: buckets.todo,
        teamId: teams.t1,
      });
      expect(created.statusCode).toBe(201);
      const number = (created.json() as WorkItemDetailDto).number;
      expect((await as('member', 'GET', item(number))).statusCode).toBe(200);
      const noTeam = await as('member', 'POST', items(), {
        type: 'TASK',
        title: 'Lost',
        bucketId: buckets.todo,
      });
      expect(noTeam.statusCode).toBe(400);
    });

    it('deleting a team leaves its items without a team', async () => {
      expect(
        (await as('pm', 'DELETE', `/api/v1/projects/${projectId}/teams/${teams.t1}`)).statusCode,
      ).toBe(204);
      expect(
        (await prisma.workItem.findUniqueOrThrow({ where: { id: itemIds.teamItem } })).teamId,
      ).toBeNull();
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: AuditAction.TEAM_DELETED },
      });
      expect(audit.meta).toMatchObject({ items: 1 });
    });

    it('a team Lead with a narrow scope creates and edits items of the team they lead', async () => {
      const created = await as('teamLead', 'POST', items(), {
        type: 'TASK',
        title: 'Led',
        bucketId: buckets.todo,
        teamId: teams.t1,
        assigneeIds: [ids.member2],
      });
      expect(created.statusCode).toBe(201);
      const line = await as('teamLead', 'POST', `${item(N.teamItem)}/checklist`, { text: 'x' });
      expect(line.statusCode).toBe(201);
      const dep = await as('teamLead', 'POST', `${item(N.teamItem)}/dependencies`, {
        blockingItemId: (created.json() as WorkItemDetailDto).id,
      });
      expect(dep.statusCode).toBe(200);
      // Moving one of their own items into the team they lead and assigning
      // others in the same request uses the new team for the assignment rule.
      const own = await seedItem(prisma, projectId, {
        createdById: ids.teamLead,
        bucketId: buckets.todo,
      });
      const both = await as('teamLead', 'PATCH', item(own.number), {
        teamId: teams.t1,
        assigneeIds: [ids.member2],
      });
      expect(both.json()).toMatchObject({ teamId: teams.t1, assigneeIds: [ids.member2] });
    });

    it('parent links and dependencies may cross teams', async () => {
      const other = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        bucketId: buckets.todo,
        teamId: teams.t2,
      });
      const dep = await as('pm', 'POST', `${item(N.teamItem)}/dependencies`, {
        blockingItemId: other.id,
      });
      expect(dep.statusCode).toBe(200);
      const parent = await as('pm', 'PATCH', item(N.teamItem), { parentId: itemIds.story });
      expect(parent.statusCode).toBe(200);
    });
  });

  describe('items', () => {
    it('numbers items per project, never reuses numbers, and reads by number or uuid', async () => {
      const first = await as('pm', 'POST', items(), {
        type: 'BUG',
        title: 'Crash',
        bucketId: buckets.todo,
      });
      expect(first.statusCode).toBe(201);
      const created = first.json() as WorkItemDetailDto;
      expect(created).toMatchObject({ number: 10, key: 'KLO-10', type: 'BUG', priority: 2 });
      expect((await as('pm', 'DELETE', item(10))).statusCode).toBe(204);
      const next = await as('pm', 'POST', items(), {
        type: 'TASK',
        title: 'Next',
        bucketId: buckets.todo,
      });
      expect((next.json() as WorkItemDetailDto).number).toBe(11);
      const byId = await as('pm', 'GET', item(itemIds.mine));
      expect((byId.json() as WorkItemDetailDto).number).toBe(N.mine);
      for (const bad of ['0', 'abc', 'KLO-5', '99']) {
        expect((await as('pm', 'GET', item(bad))).statusCode).toBe(404);
      }
      // Numbers are per project.
      const other = await seedProject(prisma, 'OTH', [{ userId: ids.pm, role: 'PM' }]);
      const bucket = await seedBucket(prisma, other.id, 'B');
      const res = await as('pm', 'POST', `/api/v1/projects/OTH/items`, {
        type: 'TASK',
        title: 'x',
        bucketId: bucket.id,
      });
      expect((res.json() as WorkItemDetailDto).key).toBe('OTH-1');
    });

    it('enforces the hierarchy rules (SPEC §4.1)', async () => {
      const bad = [
        { type: 'TASK', title: 'x', bucketId: buckets.todo, parentId: itemIds.epic },
        { type: 'STORY', title: 'x', bucketId: buckets.todo, parentId: itemIds.epic },
        { type: 'FEATURE', title: 'x', parentId: itemIds.story },
        { type: 'EPIC', title: 'x', parentId: itemIds.epic },
      ];
      for (const body of bad) {
        expect((await as('pm', 'POST', items(), body)).statusCode).toBe(400);
      }
      const ok = await as('pm', 'POST', items(), {
        type: 'TASK',
        title: 'Under a feature',
        bucketId: buckets.todo,
        parentId: itemIds.feature,
      });
      expect(ok.statusCode).toBe(201);
      // The story has a TASK child, which a TASK may not contain.
      expect((await as('pm', 'PATCH', item(N.story), { type: 'TASK' })).statusCode).toBe(400);
      // A feature with a STORY child cannot become a story itself.
      expect((await as('pm', 'PATCH', item(N.feature), { type: 'STORY' })).statusCode).toBe(400);
      // A feature off the board cannot become a story until it is in a bucket.
      const loose = await seedItem(prisma, projectId, { createdById: ids.pm, type: 'FEATURE' });
      const toStory = await as('pm', 'PATCH', item(loose.number), { type: 'STORY' });
      expect(toStory.statusCode).toBe(400);
      expect((toStory.json() as { details: { field: string }[] }).details[0]?.field).toBe('type');
      await as('pm', 'POST', `${item(loose.number)}/move`, { bucketId: buckets.todo });
      expect((await as('pm', 'PATCH', item(loose.number), { type: 'STORY' })).statusCode).toBe(200);
      // A task cannot keep a STORY parent if it becomes a FEATURE.
      expect((await as('pm', 'PATCH', item(N.theirs), { type: 'FEATURE' })).statusCode).toBe(400);
      // A parent in another project is not found.
      const other = await seedProject(prisma, 'OTH', [{ userId: ids.pm, role: 'PM' }]);
      const foreign = await seedItem(prisma, other.id, { createdById: ids.pm, type: 'STORY' });
      expect((await as('pm', 'PATCH', item(N.mine), { parentId: foreign.id })).statusCode).toBe(
        400,
      );
      // Re-parenting and clearing the parent work.
      expect(
        (await as('pm', 'PATCH', item(N.theirs), { parentId: itemIds.feature })).statusCode,
      ).toBe(200);
      expect((await as('pm', 'PATCH', item(N.theirs), { parentId: null })).statusCode).toBe(200);
    });

    it('requires a bucket for stories, tasks and bugs, not for epics and features', async () => {
      expect((await as('pm', 'POST', items(), { type: 'TASK', title: 'x' })).statusCode).toBe(400);
      expect((await as('pm', 'POST', items(), { type: 'EPIC', title: 'x' })).statusCode).toBe(201);
      const off = await as('pm', 'POST', `${item(N.mine)}/move`, { bucketId: null });
      expect(off.statusCode).toBe(400);
      const epicOn = await as('pm', 'POST', `${item(N.epic)}/move`, { bucketId: buckets.todo });
      expect(epicOn.statusCode).toBe(200);
      const epicOff = await as('pm', 'POST', `${item(N.epic)}/move`, { bucketId: null });
      expect((epicOff.json() as WorkItemDetailDto).bucketId).toBeNull();
    });

    it('refuses deleting an item with children unless cascading (SPEC §4.1)', async () => {
      const plain = await as('pm', 'DELETE', item(N.epic));
      expect(plain.statusCode).toBe(409);
      expect(codeOf(plain)).toBe(ErrorCode.HAS_CHILDREN);
      expect((await as('pm', 'DELETE', `${item(N.epic)}?cascade=true`)).statusCode).toBe(204);
      expect(await prisma.workItem.count({ where: { number: { in: [1, 2, 3, 4] } } })).toBe(0);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: AuditAction.ITEM_DELETED },
      });
      expect(audit.meta).toMatchObject({ number: 1, cascade: true, descendants: 3 });
      expect((await as('pm', 'DELETE', `${item(N.mine)}?cascade=maybe`)).statusCode).toBe(400);
    });

    it('applies bucket entry rules when cards move (SPEC §4.2)', async () => {
      const toDoing = await as('pm', 'POST', `${item(N.theirs)}/move`, { bucketId: buckets.doing });
      expect(toDoing.json()).toMatchObject({ bucketId: buckets.doing, status: 'IN_PROGRESS' });
      // SET_IF_NOT_STARTED leaves a started card alone.
      await prisma.workItem.update({ where: { id: itemIds.mine }, data: { status: 'BLOCKED' } });
      const blocked = await as('pm', 'POST', `${item(N.mine)}/move`, { bucketId: buckets.doing });
      expect(blocked.json()).toMatchObject({ status: 'BLOCKED' });
      // SET always sets, and DONE stamps completedAt.
      const done = (
        await as('pm', 'POST', `${item(N.mine)}/move`, { bucketId: buckets.done })
      ).json() as WorkItemDetailDto;
      expect(done.status).toBe('DONE');
      expect(done.completedAt).not.toBeNull();
      // NONE keeps the status; leaving DONE through a status edit clears completedAt.
      const back = await as('pm', 'POST', `${item(N.mine)}/move`, { bucketId: buckets.todo });
      expect(back.json()).toMatchObject({ status: 'DONE' });
      const reopened = await as('pm', 'PATCH', item(N.mine), { status: 'IN_PROGRESS' });
      expect(reopened.json()).toMatchObject({ status: 'IN_PROGRESS', completedAt: null });
      const moves = await prisma.auditLog.findMany({ where: { action: AuditAction.ITEM_MOVED } });
      expect(moves).toHaveLength(4);
    });

    it('orders cards within a bucket and puts new cards on top', async () => {
      const order = async () =>
        (
          (
            await as('pm', 'GET', `${items()}?bucketId=${buckets.todo}&sort=position`)
          ).json() as Page<WorkItemDto>
        ).items.map((i) => i.number);
      const before = await order();
      expect(before[0]).toBe(N.story);
      const moved = await as('pm', 'POST', `${item(N.story)}/move`, { afterId: itemIds.mine });
      expect(moved.statusCode).toBe(200);
      expect(moved.json()).toMatchObject({ status: 'NOT_STARTED', bucketId: buckets.todo });
      expect(await order()).toEqual([
        N.theirs,
        N.mine,
        N.story,
        N.teamItem,
        N.memberParent,
        N.memberChild,
      ]);
      await as('pm', 'POST', `${item(N.memberChild)}/move`, {});
      expect((await order())[0]).toBe(N.memberChild);
      const created = await as('pm', 'POST', items(), {
        type: 'TASK',
        title: 'Top',
        bucketId: buckets.todo,
      });
      expect((await order())[0]).toBe((created.json() as WorkItemDetailDto).number);
      // Reordering is not a bucket change and is not audited.
      expect(await prisma.auditLog.count({ where: { action: AuditAction.ITEM_MOVED } })).toBe(0);
      // The neighbour must be in the target bucket.
      const wrong = await as('pm', 'POST', `${item(N.story)}/move`, { afterId: itemIds.assigned });
      expect(wrong.statusCode).toBe(400);
    });

    it('moves a card when its new status is mapped to a bucket (SPEC §4.2)', async () => {
      const settings = await as('pm', 'PATCH', `/api/v1/projects/${projectId}`, {
        settings: { statusToBucket: { DONE: buckets.done, BLOCKED: buckets.done } },
      });
      expect(settings.statusCode).toBe(200);
      const done = await as('pm', 'PATCH', item(N.theirs), { status: 'DONE' });
      expect(done.json()).toMatchObject({ status: 'DONE', bucketId: buckets.done });
      // The target bucket's own rule (SET → DONE) does not override the chosen status.
      const blocked = await as('pm', 'PATCH', item(N.mine), { status: 'BLOCKED' });
      expect(blocked.json()).toMatchObject({ status: 'BLOCKED', bucketId: buckets.done });
      // Unmapped statuses and items off the board stay where they are.
      const started = await as('pm', 'PATCH', item(N.memberChild), { status: 'IN_PROGRESS' });
      expect(started.json()).toMatchObject({ bucketId: buckets.todo });
      const epic = await as('pm', 'PATCH', item(N.epic), { status: 'DONE' });
      expect(epic.json()).toMatchObject({ status: 'DONE', bucketId: null });
    });

    it('applies the bucket rule on create unless a status is given', async () => {
      const ruled = await as('pm', 'POST', items(), {
        type: 'TASK',
        title: 'x',
        bucketId: buckets.done,
      });
      expect(ruled.json()).toMatchObject({ status: 'DONE' });
      expect((ruled.json() as WorkItemDetailDto).completedAt).not.toBeNull();
      const explicit = await as('pm', 'POST', items(), {
        type: 'TASK',
        title: 'x',
        bucketId: buckets.done,
        status: 'BLOCKED',
      });
      expect(explicit.json()).toMatchObject({ status: 'BLOCKED', completedAt: null });
    });

    it('sanitizes descriptions and audits only that they changed', async () => {
      const res = await as('pm', 'PATCH', item(N.theirs), {
        description: '<p onclick="x()">Hi<script>alert(1)</script></p><img src="http://x/y.png">',
      });
      expect((res.json() as WorkItemDetailDto).description).toBe('<p>Hi</p>');
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: AuditAction.ITEM_UPDATED },
      });
      expect(audit.meta).toMatchObject({ changes: { description: { from: null, to: null } } });
      expect(JSON.stringify(audit.meta)).not.toContain('Hi');
    });

    it('manages checklists, which never change status', async () => {
      const base = `${item(N.mine)}/checklist`;
      const a = (await as('member', 'POST', base, { text: 'A' })).json() as ChecklistItemDto;
      const b = (
        await as('member', 'POST', base, { text: 'B', done: true })
      ).json() as ChecklistItemDto;
      expect((await as('member', 'PATCH', `${base}/${a.id}`, { done: true })).statusCode).toBe(200);
      const moved = await as('member', 'POST', `${base}/${b.id}/move`, {});
      expect(moved.statusCode).toBe(200);
      const list = (await as('viewer', 'GET', base)).json() as ChecklistItemDto[];
      expect(list.map((l) => l.text)).toEqual(['B', 'A']);
      const detail = (await as('member', 'GET', item(N.mine))).json() as WorkItemDetailDto;
      expect(detail.checklist).toEqual({ done: 2, total: 2 });
      expect(detail.status).toBe('NOT_STARTED');
      expect((await as('member', 'DELETE', `${base}/${a.id}`)).statusCode).toBe(204);
      // Checklist changes follow the edit rule and stay on their item.
      expect((await as('member2', 'POST', base, { text: 'C' })).statusCode).toBe(403);
      expect((await as('viewer', 'PATCH', `${base}/${b.id}`, { done: false })).statusCode).toBe(
        403,
      );
      expect(
        (await as('member', 'PATCH', `${item(N.assigned)}/checklist/${b.id}`, { done: false }))
          .statusCode,
      ).toBe(404);
      const actions = await prisma.auditLog.findMany({
        where: { entityId: itemIds.mine },
        select: { action: true },
      });
      expect(actions.map((x) => x.action).sort()).toEqual([
        AuditAction.CHECKLIST_ITEM_ADDED,
        AuditAction.CHECKLIST_ITEM_ADDED,
        AuditAction.CHECKLIST_ITEM_REMOVED,
        AuditAction.CHECKLIST_ITEM_UPDATED,
      ]);
    });

    it('adds and removes dependencies and rejects cycles', async () => {
      const add = async (blocked: number, blocking: string) =>
        as('pm', 'POST', `${item(blocked)}/dependencies`, { blockingItemId: blocking });
      expect((await add(N.theirs, itemIds.mine)).statusCode).toBe(200);
      expect((await add(N.mine, itemIds.assigned)).statusCode).toBe(200);
      // Idempotent.
      expect((await add(N.theirs, itemIds.mine)).statusCode).toBe(200);
      expect(await prisma.workItemDependency.count()).toBe(2);
      // assigned → mine → theirs would close a loop.
      expect((await add(N.assigned, itemIds.theirs)).statusCode).toBe(400);
      expect((await add(N.mine, itemIds.mine)).statusCode).toBe(400);
      const detail = (await as('pm', 'GET', item(N.mine))).json() as WorkItemDetailDto;
      expect(detail.blockedBy.map((r) => r.number)).toEqual([N.assigned]);
      expect(detail.blocks.map((r) => r.number)).toEqual([N.theirs]);
      // A Member can manage dependencies of their own items only.
      expect(
        (
          await as('member', 'POST', `${item(N.mine)}/dependencies`, {
            blockingItemId: itemIds.theirs,
          })
        ).statusCode,
      ).toBe(400); // would close a loop
      expect(
        (await as('member', 'DELETE', `${item(N.theirs)}/dependencies/${itemIds.mine}`)).statusCode,
      ).toBe(403);
      const removed = await as('pm', 'DELETE', `${item(N.theirs)}/dependencies/${itemIds.mine}`);
      expect((removed.json() as WorkItemDetailDto).blockedBy).toEqual([]);
      expect(
        (await as('pm', 'DELETE', `${item(N.theirs)}/dependencies/${itemIds.mine}`)).statusCode,
      ).toBe(404);
      // Hidden blockers are not shown, and cannot be removed by the caller.
      await setScope('member', 'BUCKETS', [buckets.todo]);
      const hidden = (await as('member', 'GET', item(N.mine))).json() as WorkItemDetailDto;
      expect(hidden.blockedBy).toEqual([]);
      expect(
        (await as('member', 'DELETE', `${item(N.mine)}/dependencies/${itemIds.assigned}`))
          .statusCode,
      ).toBe(404);
    });

    it('validates labels, sprints, assignees and dates', async () => {
      const label = await seedLabel(prisma, projectId, 'ui');
      const other = await seedProject(prisma, 'OTH', [{ userId: ids.pm, role: 'PM' }]);
      const foreignLabel = await seedLabel(prisma, other.id, 'ui');
      const open = await seedSprint(prisma, projectId, 'S1');
      const closed = await seedSprint(prisma, projectId, 'S0', 'CLOSED');
      const ok = await as('pm', 'PATCH', item(N.theirs), {
        labelIds: [label.id],
        sprintId: open.id,
        startDate: '2026-11-02',
        dueDate: '2026-11-05',
      });
      expect(ok.json()).toMatchObject({
        labelIds: [label.id],
        sprintId: open.id,
        startDate: '2026-11-02',
        dueDate: '2026-11-05',
      });
      for (const body of [
        { labelIds: [foreignLabel.id] },
        { sprintId: closed.id },
        { assigneeIds: [ids.outsider] },
        { dueDate: '2026-11-01' },
        { dueDate: '2026-02-30' },
        { priority: 5 },
        { title: '' },
        { title: null },
        { bucketId: buckets.done },
        { unknown: 1 },
      ]) {
        const res = await as('pm', 'PATCH', item(N.theirs), body);
        expect({ body, status: res.statusCode }).toEqual({ body, status: 400 });
      }
      // Filters.
      expect(await visibleNumbers('pm', `&labelId=${label.id}`)).toEqual([N.theirs]);
      expect(await visibleNumbers('pm', `&sprintId=${open.id}`)).toEqual([N.theirs]);
      expect(await visibleNumbers('pm', `&assigneeId=${ids.member}`)).toEqual([N.assigned]);
      expect(await visibleNumbers('pm', `&teamId=${teams.t1}`)).toEqual([N.teamItem]);
      expect(await visibleNumbers('pm', '&parentId=none&type=EPIC')).toEqual([N.epic]);
      expect(await visibleNumbers('pm', '&q=stor')).toEqual([N.story]);
      expect(await visibleNumbers('pm', '&q=6')).toEqual([N.assigned]);
      expect(await visibleNumbers('pm', '&dueFrom=2026-11-05&dueTo=2026-11-05')).toEqual([
        N.theirs,
      ]);
      expect((await as('pm', 'GET', `${items()}?sprintId=soon`)).statusCode).toBe(400);
    });

    it('records the activity history of an item', async () => {
      await as('pm', 'PATCH', item(N.mine), { title: 'Renamed', priority: 1 });
      await as('pm', 'POST', `${item(N.mine)}/move`, { bucketId: buckets.doing });
      const res = await as('member', 'GET', `${item(N.mine)}/activity`);
      const page = res.json() as Page<AuditEntryDto>;
      expect(page.items.map((e) => e.action)).toEqual([
        AuditAction.ITEM_MOVED,
        AuditAction.ITEM_UPDATED,
      ]);
      expect(page.items[1]?.meta).toMatchObject({
        changes: { title: { from: `Item ${N.mine}`, to: 'Renamed' }, priority: { from: 2, to: 1 } },
      });
    });

    it('removes assignments when a member leaves the project', async () => {
      const res = await as('pm', 'DELETE', `/api/v1/projects/${projectId}/members/${ids.member}`);
      expect(res.statusCode).toBe(204);
      expect(await prisma.workItemAssignee.count({ where: { userId: ids.member } })).toBe(0);
      // Items they created stay.
      expect(await prisma.workItem.count({ where: { createdById: ids.member } })).toBe(3);
    });

    it('refuses item writes on archived projects but still reads them', async () => {
      await prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
      expect((await as('pm', 'GET', item(N.mine))).statusCode).toBe(200);
      for (const [method, url, body] of [
        ['POST', items(), { type: 'EPIC', title: 'x' }],
        ['PATCH', item(N.mine), { title: 'x' }],
        ['POST', `${item(N.mine)}/move`, { bucketId: buckets.doing }],
        ['DELETE', item(N.mine), undefined],
        ['POST', `${item(N.mine)}/checklist`, { text: 'x' }],
        ['POST', `${item(N.mine)}/dependencies`, { blockingItemId: itemIds.theirs }],
        ['DELETE', `${item(N.mine)}/dependencies/${itemIds.theirs}`, undefined],
        ['PATCH', `${item(N.mine)}/checklist/${itemIds.theirs}`, { done: true }],
        ['POST', `${item(N.mine)}/checklist/${itemIds.theirs}/move`, {}],
        ['DELETE', `${item(N.mine)}/checklist/${itemIds.theirs}`, undefined],
      ] as const) {
        const res = await as('pm', method, url, body);
        expect({ url, code: codeOf(res) }).toEqual({ url, code: ErrorCode.PROJECT_ARCHIVED });
      }
    });

    it('audits admin reads of items in projects they are not a member of', async () => {
      expect((await as('admin', 'GET', item(N.mine))).statusCode).toBe(200);
      expect((await as('admin', 'GET', items())).statusCode).toBe(200);
      const audits = await prisma.auditLog.findMany({
        where: { action: AuditAction.ADMIN_CROSS_PROJECT_ACCESS, actorId: ids.admin },
      });
      expect(audits.map((a) => (a.meta as { via: string }).via).sort()).toEqual([
        'GET /api/v1/projects/:id/items',
        'GET /api/v1/projects/:id/items/:item',
      ]);
    });

    it('only moves a card through the status map to a bucket the caller can see', async () => {
      await as('pm', 'PATCH', `/api/v1/projects/${projectId}`, {
        settings: { statusToBucket: { DONE: buckets.done } },
      });
      await setScope('member', 'BUCKETS', [buckets.todo]);
      const res = await as('member', 'PATCH', item(N.mine), { status: 'DONE' });
      expect(res.json()).toMatchObject({ status: 'DONE', bucketId: buckets.todo });
    });

    it('treats upper-case ids like lower-case ones', async () => {
      const upper = (id: string) => id.toUpperCase();
      const after = await as('pm', 'POST', `${item(N.story)}/move`, {
        afterId: upper(itemIds.mine),
      });
      expect(after.statusCode).toBe(200);
      const self = await as('pm', 'POST', `${item(N.mine)}/dependencies`, {
        blockingItemId: upper(itemIds.mine),
      });
      expect(self.statusCode).toBe(400);
      const same = await as('pm', 'POST', `${item(upper(itemIds.mine))}/move`, {
        bucketId: upper(buckets.todo),
      });
      expect(same.statusCode).toBe(200);
      expect(await prisma.auditLog.count({ where: { action: AuditAction.ITEM_MOVED } })).toBe(0);
      const assignSelf = await as('member', 'PATCH', item(N.mine), {
        assigneeIds: [upper(ids.member)],
      });
      expect(assignSelf.json()).toMatchObject({ assigneeIds: [ids.member] });
      expect(await visibleNumbers('pm', `&bucketId=${upper(buckets.doing)}`)).toEqual([N.assigned]);
    });

    it('does not reveal hidden children, blockers or parents', async () => {
      await prisma.workItem.update({
        where: { id: itemIds.assigned },
        data: { parentId: itemIds.story },
      });
      await as('pm', 'POST', `${item(N.mine)}/dependencies`, { blockingItemId: itemIds.assigned });
      await as('pm', 'PATCH', item(N.mine), { parentId: itemIds.story });
      await setScope('member', 'BUCKETS', [buckets.todo]);
      // Child counts only include visible children.
      const story = (await as('member', 'GET', item(N.story))).json() as WorkItemDetailDto;
      expect(story.childCount).toBe(2);
      const pmStory = (await as('pm', 'GET', item(N.story))).json() as WorkItemDetailDto;
      expect(pmStory.childCount).toBe(3);
      // Activity hides the hidden blocker; the visible parent stays.
      const activity = (
        (await as('member', 'GET', `${item(N.mine)}/activity`)).json() as Page<AuditEntryDto>
      ).items;
      const added = activity.find((e) => e.action === AuditAction.DEPENDENCY_ADDED);
      expect(added?.meta).toMatchObject({
        blockingItemId: null,
        blockingNumber: null,
        redacted: true,
      });
      const parent = activity.find((e) => e.action === AuditAction.ITEM_UPDATED);
      expect(parent?.meta).toMatchObject({
        changes: { parentId: { from: null, to: itemIds.story } },
      });
      expect(JSON.stringify(activity)).not.toContain(itemIds.assigned);
      // A hidden item as a list cursor gives an empty page, like an unknown one.
      const hidden = await as('member', 'GET', `${items()}?cursor=${itemIds.assigned}`);
      expect(hidden.json()).toEqual({ items: [], nextCursor: null });
      const visible = await as('member', 'GET', `${items()}?cursor=${itemIds.story}&limit=1`);
      expect((visible.json() as Page<WorkItemDto>).items.map((i) => i.number)).toEqual([N.theirs]);
    });
  });
});
