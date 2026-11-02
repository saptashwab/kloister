import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  AuditAction,
  type ItemPreviewDto,
  type ItemReferrerDto,
  type NoteDto,
  type ProjectDto,
  type WorkItemDetailDto,
} from '@kloister/shared';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  call,
  login,
  type Res,
  resetDb,
  seedBucket,
  seedItem,
  seedProject,
  seedSprint,
  seedUser,
  startApp,
} from './support.js';

// Items in and out of the plan (M12 plan sections 2–4 and 6) against a real
// database: the "New items start in" bucket, sprints owned by Stories with
// their Tasks and Bugs following, ad-hoc items, and item references that
// never disclose hidden items.

const NAMES = ['pm', 'lead', 'member', 'scoped', 'buckets', 'outsider'] as const;
type Name = (typeof NAMES)[number];

describe('plan rules (db)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let ids: Record<Name, string>;
  let projectId: string;
  let todo: string;
  let doing: string;
  let sessions: Partial<Record<Name, string>> = {};

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
  });

  afterAll(async () => {
    await app.close();
  });

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
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: object,
  ): Promise<Res> {
    const sid = (sessions[name] ??= await login(app, `${name}@example.org`));
    return call(app, method, url, { sid, ...(body === undefined ? {} : { body }) });
  }

  const base = (suffix = ''): string => `/api/v1/projects/${projectId}${suffix}`;
  const item = (ref: string | number): string => base(`/items/${ref}`);

  beforeEach(async () => {
    sessions = {};
    await resetDb(prisma);
    const seeded: Partial<Record<Name, string>> = {};
    for (const name of NAMES)
      seeded[name] = (await seedUser(prisma, { email: `${name}@example.org` })).id;
    ids = seeded as Record<Name, string>;
    const project = await seedProject(prisma, 'KLO', [
      { userId: ids.pm, role: 'PM' },
      { userId: ids.lead, role: 'LEAD' },
      { userId: ids.member, role: 'MEMBER' },
      { userId: ids.scoped, role: 'MEMBER', visibility: 'OWN' },
    ]);
    projectId = project.id;
    todo = (await seedBucket(prisma, projectId, 'To Do')).id;
    doing = (await seedBucket(prisma, projectId, 'Doing')).id;
    await prisma.projectMember.create({
      data: {
        projectId,
        userId: ids.buckets,
        role: 'MEMBER',
        visibility: 'BUCKETS',
        allowedBucketIds: [todo],
      },
    });
  });

  describe('New items start in', () => {
    it('is PM-only, a bucket of the project, and reset when that bucket is deleted', async () => {
      expect(
        (await as('lead', 'PATCH', base(), { settings: { newItemBucketId: doing } })).statusCode,
      ).toBe(403);
      const other = await seedProject(prisma, 'OTH', [{ userId: ids.pm, role: 'PM' }]);
      const foreign = await seedBucket(prisma, other.id, 'Elsewhere');
      expect(
        (await as('pm', 'PATCH', base(), { settings: { newItemBucketId: foreign.id } })).statusCode,
      ).toBe(400);
      const set = await as('pm', 'PATCH', base(), { settings: { newItemBucketId: doing } });
      expect((set.json() as ProjectDto).settings.newItemBucketId).toBe(doing);
      const created = await as('member', 'POST', base('/items'), { type: 'TASK', title: 'New' });
      expect(created.statusCode).toBe(201);
      expect((created.json() as WorkItemDetailDto).bucketId).toBe(doing);
      // A BUCKETS-scoped Member who cannot see "Doing" gets the first bucket they can use.
      const scoped = await as('buckets', 'POST', base('/items'), { type: 'TASK', title: 'Mine' });
      expect((scoped.json() as WorkItemDetailDto).bucketId).toBe(todo);
      // Epics stay off the board.
      const epic = await as('pm', 'POST', base('/items'), { type: 'EPIC', title: 'Big' });
      expect((epic.json() as WorkItemDetailDto).bucketId).toBeNull();
      const removed = await as('pm', 'DELETE', base(`/buckets/${doing}?moveItemsTo=${todo}`));
      expect(removed.statusCode).toBe(204);
      const after = (await as('pm', 'GET', base())).json() as ProjectDto;
      expect(after.settings.newItemBucketId).toBeNull();
    });
  });

  describe('sprints follow the hierarchy', () => {
    it('refuses sprints on Epics and Features and clears one on a type change', async () => {
      const sprint = await seedSprint(prisma, projectId, 'S1');
      const epic = await as('pm', 'POST', base('/items'), {
        type: 'EPIC',
        title: 'E',
        sprintId: sprint.id,
      });
      expect(epic.statusCode).toBe(400);
      const story = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        type: 'STORY',
        bucketId: todo,
        sprintId: sprint.id,
      });
      const feature = await as('pm', 'PATCH', item(story.number), { type: 'FEATURE' });
      expect(feature.statusCode).toBe(200);
      expect((feature.json() as WorkItemDetailDto).sprintId).toBeNull();
      expect(
        (await as('pm', 'PATCH', item(story.number), { sprintId: sprint.id })).statusCode,
      ).toBe(400);
    });

    it('moves a Story’s Tasks and Bugs with it, except deliberate exceptions', async () => {
      const s1 = await seedSprint(prisma, projectId, 'S1');
      const s2 = await seedSprint(prisma, projectId, 'S2');
      const s3 = await seedSprint(prisma, projectId, 'S3');
      const story = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        type: 'STORY',
        bucketId: todo,
        sprintId: s1.id,
      });
      const same = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        parentId: story.id,
        bucketId: todo,
        sprintId: s1.id,
      });
      const none = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        type: 'BUG',
        parentId: story.id,
        bucketId: todo,
      });
      const elsewhere = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        parentId: story.id,
        bucketId: todo,
        sprintId: s3.id,
      });
      const res = await as('pm', 'PATCH', item(story.number), { sprintId: s2.id });
      expect(res.statusCode).toBe(200);
      const sprintOf = async (id: string) =>
        (await prisma.workItem.findUniqueOrThrow({ where: { id } })).sprintId;
      expect(await sprintOf(same.id)).toBe(s2.id);
      expect(await sprintOf(none.id)).toBe(s2.id);
      expect(await sprintOf(elsewhere.id)).toBe(s3.id);
      const followed = await prisma.auditLog.findMany({
        where: { action: AuditAction.SPRINT_FOLLOWED },
        orderBy: { createdAt: 'asc' },
      });
      expect(followed.map((f) => f.entityId).sort()).toEqual([same.id, none.id].sort());
      // Undo: the Story goes back and its followers with it.
      await as('pm', 'PATCH', item(story.number), { sprintId: s1.id });
      expect(await sprintOf(same.id)).toBe(s1.id);
      // A new child starts in its Story's sprint.
      const child = await as('member', 'POST', base('/items'), {
        type: 'TASK',
        title: 'Child',
        parentId: story.id,
      });
      expect((child.json() as WorkItemDetailDto).sprintId).toBe(s1.id);
    });

    it('keeps the plan setting: Members cannot change a scheduled Story’s sprint', async () => {
      const s1 = await seedSprint(prisma, projectId, 'S1');
      const story = await seedItem(prisma, projectId, {
        createdById: ids.member,
        type: 'STORY',
        bucketId: todo,
        sprintId: s1.id,
      });
      expect((await as('member', 'PATCH', item(story.number), { sprintId: null })).statusCode).toBe(
        403,
      );
    });

    it('closing a sprint moves an unfinished Story with its unfinished children', async () => {
      const s1 = await seedSprint(prisma, projectId, 'S1', 'ACTIVE');
      const s2 = await seedSprint(prisma, projectId, 'S2');
      const story = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        type: 'STORY',
        bucketId: todo,
        sprintId: s1.id,
      });
      const open = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        parentId: story.id,
        bucketId: todo,
        sprintId: s1.id,
      });
      const done = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        parentId: story.id,
        bucketId: todo,
        sprintId: s1.id,
        status: 'DONE',
      });
      const res = await as('pm', 'POST', base(`/sprints/${s1.id}/close`), {
        moveUnfinishedTo: s2.id,
      });
      expect(res.json()).toMatchObject({ movedItems: 2 });
      const sprintOf = async (id: string) =>
        (await prisma.workItem.findUniqueOrThrow({ where: { id } })).sprintId;
      expect([await sprintOf(story.id), await sprintOf(open.id), await sprintOf(done.id)]).toEqual([
        s2.id,
        s2.id,
        s1.id,
      ]);
    });
  });

  describe('ad-hoc items', () => {
    it('are Tasks and Bugs without parent, children or dependencies', async () => {
      expect(
        (await as('pm', 'POST', base('/items'), { type: 'STORY', title: 'S', adHoc: true }))
          .statusCode,
      ).toBe(400);
      const story = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        type: 'STORY',
        bucketId: todo,
      });
      expect(
        (
          await as('pm', 'POST', base('/items'), {
            type: 'TASK',
            title: 'T',
            adHoc: true,
            parentId: story.id,
          })
        ).statusCode,
      ).toBe(400);
      // Anyone who may create items may create ad-hoc ones.
      const created = await as('member', 'POST', base('/items'), {
        type: 'TASK',
        title: 'Call',
        adHoc: true,
      });
      expect(created.statusCode).toBe(201);
      const adHoc = created.json() as WorkItemDetailDto;
      expect(adHoc.adHoc).toBe(true);
      expect((await as('pm', 'PATCH', item(adHoc.number), { parentId: story.id })).statusCode).toBe(
        400,
      );
      expect(
        (
          await as('pm', 'POST', `${item(adHoc.number)}/dependencies`, {
            blockingItemId: story.id,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await as('pm', 'POST', `${item(story.number)}/dependencies`, {
            blockingItemId: adHoc.id,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await as('pm', 'POST', base('/timeline/reschedule'), {
            mode: 'preview',
            changes: [
              { item: String(adHoc.number), startDate: '2026-11-04', dueDate: '2026-11-05' },
            ],
          })
        ).statusCode,
      ).toBe(400);
    });

    it('needs no links to become ad hoc, and the change is a plan change', async () => {
      const task = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
      const other = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
      await prisma.workItemDependency.create({
        data: { projectId, blockedItemId: task.id, blockingItemId: other.id },
      });
      expect((await as('pm', 'PATCH', item(task.number), { adHoc: true })).statusCode).toBe(400);
      await prisma.workItemDependency.deleteMany({});
      // A Member may not take someone else's item out of the plan.
      await prisma.workItem.update({ where: { id: task.id }, data: { createdById: ids.member } });
      await prisma.workItem.update({
        where: { id: task.id },
        data: { startDate: new Date('2026-11-04T00:00:00.000Z') },
      });
      expect((await as('member', 'PATCH', item(task.number), { adHoc: true })).statusCode).toBe(
        403,
      );
      expect((await as('pm', 'PATCH', item(task.number), { adHoc: true })).statusCode).toBe(200);
    });
  });

  describe('item references', () => {
    it('marks only what the writer sees and shows marks only to readers who see them', async () => {
      const hidden = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
      const own = await seedItem(prisma, projectId, { createdById: ids.scoped, bucketId: todo });
      // The scoped Member cannot see the PM's item: their text stays plain.
      const plain = await as('scoped', 'PATCH', item(own.number), {
        description: `<p>See KLO-${hidden.number}</p>`,
      });
      expect((plain.json() as WorkItemDetailDto).description).not.toContain('data-ref');
      expect(await prisma.itemReference.count({ where: { sourceItemId: own.id } })).toBe(0);
      // The PM writes the same reference: it is marked.
      const marked = await as('pm', 'PATCH', item(own.number), {
        description: `<p>See #${hidden.number}</p>`,
      });
      const key = `KLO-${hidden.number}`;
      expect((marked.json() as WorkItemDetailDto).description).toContain(
        `<span data-ref="${key}">${key}</span>`,
      );
      // …but the scoped Member reads it as plain text.
      const read = (await as('scoped', 'GET', item(own.number))).json() as WorkItemDetailDto;
      expect(read.description).toBe(`<p>See <span>${key}</span></p>`);
      // Saving what they read keeps the PM's mark for everyone else.
      await as('scoped', 'PATCH', item(own.number), { description: `<p>See ${key}!</p>` });
      const kept = (await as('pm', 'GET', item(own.number))).json() as WorkItemDetailDto;
      expect(kept.description).toContain(`<span data-ref="${key}">`);
      // "Referenced in" for those who see the target only.
      const referrers = (
        await as('pm', 'GET', `${item(hidden.number)}/referenced-in`)
      ).json() as ItemReferrerDto[];
      expect(referrers.map((r) => r.id)).toEqual([own.id]);
      expect((await as('scoped', 'GET', `${item(hidden.number)}/referenced-in`)).statusCode).toBe(
        404,
      );
      // Previews never return hidden or foreign items.
      const preview = async (name: Name) =>
        ((await as(name, 'GET', `/api/v1/references?keys=${key}`)).json() as ItemPreviewDto[]).map(
          (p) => p.id,
        );
      expect(await preview('pm')).toEqual([hidden.id]);
      expect(await preview('scoped')).toEqual([]);
      expect(await preview('outsider')).toEqual([]);
      expect((await as('pm', 'GET', '/api/v1/references?keys=bad')).statusCode).toBe(400);
    });

    it('keeps references from notes and drops them with the note', async () => {
      const target = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
      const source = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
      const note = await as('pm', 'POST', `${item(source.number)}/notes`, {
        body: `<p>Blocked on KLO-${target.number}</p>`,
      });
      expect(note.statusCode).toBe(201);
      expect((note.json() as NoteDto).body).toContain('data-ref');
      expect(await prisma.itemReference.count({ where: { targetItemId: target.id } })).toBe(1);
      const { id } = note.json() as NoteDto;
      expect((await as('pm', 'DELETE', `${item(source.number)}/notes/${id}`)).statusCode).toBe(204);
      expect(await prisma.itemReference.count({ where: { targetItemId: target.id } })).toBe(0);
    });

    it('links other projects only for their members', async () => {
      const other = await seedProject(prisma, 'OPS', [{ userId: ids.pm, role: 'PM' }]);
      const bucket = await seedBucket(prisma, other.id, 'B');
      const foreign = await seedItem(prisma, other.id, {
        createdById: ids.pm,
        bucketId: bucket.id,
      });
      const source = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
      const key = `OPS-${foreign.number}`;
      const saved = await as('pm', 'PATCH', item(source.number), { description: `<p>${key}</p>` });
      expect((saved.json() as WorkItemDetailDto).description).toContain(`data-ref="${key}"`);
      // A Member of KLO who is not in OPS reads plain text.
      const read = (await as('member', 'GET', item(source.number))).json() as WorkItemDetailDto;
      expect(read.description).toBe(`<p><span>${key}</span></p>`);
    });
  });
});
