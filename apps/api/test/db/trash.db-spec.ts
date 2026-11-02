import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  AuditAction,
  type DeleteItemResult,
  type Page,
  type RestoreBatchResult,
  type TrashBatchDto,
  type WorkItemDetailDto,
  type WorkItemDto,
} from '@kloister/shared';
import { TrashService } from '../../src/items/trash.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  call,
  login,
  type Res,
  resetDb,
  seedBucket,
  seedItem,
  seedProject,
  seedUser,
  startApp,
} from './support.js';

// The project trash (M12 plan section 5) against a real database: deleting
// moves items to the trash in batches, the permission matrix for listing,
// restoring and permanently deleting, restore without a trashed parent,
// every item route family ignoring trashed items, and the nightly purge.

const NAMES = ['pm', 'lead', 'member', 'member2', 'viewer', 'scoped', 'outsider', 'admin'] as const;
type Name = (typeof NAMES)[number];

describe('trash (db)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let ids: Record<Name, string>;
  let projectId: string;
  let todo: string;
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
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    body?: object,
  ): Promise<Res> {
    const sid = (sessions[name] ??= await login(app, `${name}@example.org`));
    return call(app, method, url, { sid, ...(body === undefined ? {} : { body }) });
  }

  const base = (suffix = ''): string => `/api/v1/projects/${projectId}${suffix}`;
  const item = (ref: string | number): string => base(`/items/${ref}`);

  /**
   * Trashes an item as the PM and returns its batch.
   *
   * @param ref Item uuid or number.
   * @param cascade Whether to delete the subtree.
   * @returns The batch id.
   */
  async function trash(ref: string | number, cascade = false): Promise<string> {
    const res = await as('pm', 'DELETE', `${item(ref)}${cascade ? '?cascade=true' : ''}`);
    expect(res.statusCode).toBe(200);
    return (res.json() as DeleteItemResult).batchId;
  }

  beforeEach(async () => {
    sessions = {};
    await resetDb(prisma);
    const seeded: Partial<Record<Name, string>> = {};
    for (const name of NAMES) {
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
        { userId: ids.member2, role: 'MEMBER' },
        { userId: ids.viewer, role: 'VIEWER' },
        { userId: ids.scoped, role: 'MEMBER', visibility: 'OWN' },
      ])
    ).id;
    todo = (await seedBucket(prisma, projectId, 'To Do')).id;
  });

  describe('permissions', () => {
    const LIST = {
      pm: 200,
      lead: 200,
      member: 200,
      member2: 200,
      viewer: 403,
      scoped: 200,
      outsider: 404,
      admin: 403,
    };
    for (const [name, status] of Object.entries(LIST) as [Name, number][]) {
      it(`lists the trash: ${name} → ${status}`, async () => {
        expect((await as(name, 'GET', base('/trash'))).statusCode).toBe(status);
      });
    }

    const RESTORE_PMS = {
      pm: 200,
      lead: 200,
      member: 403,
      member2: 403,
      viewer: 403,
      scoped: 404,
      outsider: 404,
      admin: 403,
    };
    for (const [name, status] of Object.entries(RESTORE_PMS) as [Name, number][]) {
      it(`restores a PM's batch: ${name} → ${status}`, async () => {
        const own = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
        const batch = await trash(own.number);
        const res = await as(name, 'POST', base(`/trash/${batch}/restore`));
        expect(res.statusCode).toBe(status);
        const row = await prisma.workItem.findUniqueOrThrow({ where: { id: own.id } });
        expect(row.deletedAt === null).toBe(status === 200);
      });
    }

    const PURGE = {
      pm: 204,
      lead: 403,
      member: 403,
      member2: 403,
      viewer: 403,
      scoped: 403,
      outsider: 404,
      admin: 403,
    };
    for (const [name, status] of Object.entries(PURGE) as [Name, number][]) {
      it(`deletes a batch permanently: ${name} → ${status}`, async () => {
        const own = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
        const batch = await trash(own.number);
        const res = await as(name, 'DELETE', base(`/trash/${batch}`));
        expect(res.statusCode).toBe(status);
        expect(await prisma.workItem.count({ where: { id: own.id } })).toBe(status === 204 ? 0 : 1);
        if (status === 204)
          expect(
            await prisma.auditLog.count({
              where: { action: AuditAction.ITEM_PURGED, entityId: own.id },
            }),
          ).toBe(1);
      });
    }

    it('lets Members restore what they deleted themselves, nobody else’s', async () => {
      const mine = await seedItem(prisma, projectId, { createdById: ids.member, bucketId: todo });
      const deleted = await as('member', 'DELETE', item(mine.number));
      expect(deleted.statusCode).toBe(200);
      const { batchId } = deleted.json() as DeleteItemResult;
      const listed = (await as('member', 'GET', base('/trash'))).json() as TrashBatchDto[];
      expect(listed).toEqual([
        expect.objectContaining({
          id: batchId,
          canRestore: true,
          canPurge: false,
          deletedBy: { id: ids.member, displayName: expect.any(String) as string },
        }),
      ]);
      expect((await as('member2', 'POST', base(`/trash/${batchId}/restore`))).statusCode).toBe(403);
      expect((await as('member', 'POST', base(`/trash/${batchId}/restore`))).statusCode).toBe(200);
      expect((await as('member', 'GET', item(mine.number))).statusCode).toBe(200);
    });

    it('lists only items the caller could see and hides other batches entirely', async () => {
      const hidden = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
      const own = await seedItem(prisma, projectId, { createdById: ids.scoped, bucketId: todo });
      await trash(hidden.number);
      const ownBatch = await trash(own.number);
      const listed = (await as('scoped', 'GET', base('/trash'))).json() as TrashBatchDto[];
      expect(listed.map((b) => b.id)).toEqual([ownBatch]);
      expect(listed[0].items.map((i) => i.id)).toEqual([own.id]);
      // Deleted by the PM, so the scoped Member may see but not restore it.
      expect(listed[0].canRestore).toBe(false);
    });

    it('refuses restores and purges with malformed or unknown batch ids', async () => {
      expect((await as('pm', 'POST', base('/trash/not-a-uuid/restore'))).statusCode).toBe(400);
      const unknown = '99999999-9999-4999-8999-999999999999';
      expect((await as('pm', 'POST', base(`/trash/${unknown}/restore`))).statusCode).toBe(404);
      expect((await as('pm', 'DELETE', base(`/trash/${unknown}`))).statusCode).toBe(404);
    });

    it('keeps archived projects read-only', async () => {
      const own = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
      const batch = await trash(own.number);
      await prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
      expect((await as('pm', 'GET', base('/trash'))).statusCode).toBe(200);
      expect((await as('pm', 'POST', base(`/trash/${batch}/restore`))).statusCode).not.toBe(200);
      expect((await as('pm', 'DELETE', base(`/trash/${batch}`))).statusCode).not.toBe(204);
    });
  });

  describe('restore', () => {
    it('restores a cascade together, keeping numbers, notes and links', async () => {
      const story = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        type: 'STORY',
        bucketId: todo,
      });
      const task = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        parentId: story.id,
        bucketId: todo,
      });
      const other = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
      await prisma.workItemDependency.create({
        data: { projectId, blockedItemId: other.id, blockingItemId: task.id },
      });
      await prisma.note.create({
        data: { workItemId: task.id, authorId: ids.pm, body: '<p>x</p>' },
      });
      const batch = await trash(story.number, true);
      const hidden = (await as('pm', 'GET', item(other.number))).json() as WorkItemDetailDto;
      expect(hidden.blockedBy).toEqual([]);
      const restored = await as('pm', 'POST', base(`/trash/${batch}/restore`));
      expect(restored.json()).toEqual({ restored: 2, parentDropped: false });
      const back = (await as('pm', 'GET', item(task.number))).json() as WorkItemDetailDto;
      expect(back).toMatchObject({ id: task.id, number: task.number, parentId: story.id });
      const blocked = (await as('pm', 'GET', item(other.number))).json() as WorkItemDetailDto;
      expect(blocked.blockedBy.map((b) => b.id)).toEqual([task.id]);
      expect((await as('pm', 'GET', `${item(task.number)}/notes`)).statusCode).toBe(200);
      expect(
        await prisma.auditLog.count({
          where: { action: AuditAction.ITEM_RESTORED, entityId: story.id },
        }),
      ).toBe(1);
    });

    it('restores an item without its parent while the parent is still in the trash', async () => {
      const story = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        type: 'STORY',
        bucketId: todo,
      });
      const task = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        parentId: story.id,
        bucketId: todo,
      });
      const taskBatch = await trash(task.number);
      await trash(story.number);
      const res = await as('pm', 'POST', base(`/trash/${taskBatch}/restore`));
      expect(res.json() as RestoreBatchResult).toEqual({ restored: 1, parentDropped: true });
      const back = (await as('pm', 'GET', item(task.number))).json() as WorkItemDetailDto;
      expect(back.parentId).toBeNull();
      expect((await as('pm', 'GET', item(story.number))).statusCode).toBe(404);
    });

    it('purges a parent batch while an earlier child batch stays in the trash', async () => {
      const story = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        type: 'STORY',
        bucketId: todo,
      });
      const task = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        parentId: story.id,
        bucketId: todo,
      });
      const taskBatch = await trash(task.number);
      const storyBatch = await trash(story.number);
      expect((await as('pm', 'DELETE', base(`/trash/${storyBatch}`))).statusCode).toBe(204);
      const res = await as('pm', 'POST', base(`/trash/${taskBatch}/restore`));
      expect(res.json()).toEqual({ restored: 1, parentDropped: false });
      expect(
        ((await as('pm', 'GET', item(task.number))).json() as WorkItemDto).parentId,
      ).toBeNull();
    });
  });

  describe('trashed items are gone from every route family', () => {
    it('leaves them out of lists, children, details, notes, timeline, work and summaries', async () => {
      const story = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        type: 'STORY',
        bucketId: todo,
      });
      const task = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        parentId: story.id,
        bucketId: todo,
        assigneeIds: [ids.member],
      });
      const blocker = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
      await prisma.workItemDependency.create({
        data: { projectId, blockedItemId: story.id, blockingItemId: blocker.id },
      });
      await trash(task.number);
      await trash(blocker.number);
      const list = (await as('pm', 'GET', base('/items'))).json() as Page<WorkItemDto>;
      expect(list.items.map((i) => i.id)).toEqual([story.id]);
      expect(list.items[0].childCount).toBe(0);
      const children = (
        await as('pm', 'GET', `${item(story.number)}/children`)
      ).json() as Page<WorkItemDto>;
      expect(children.items).toEqual([]);
      for (const path of ['', '/notes', '/activity', '/checklist', '/attachments'])
        expect((await as('pm', 'GET', `${item(task.number)}${path}`)).statusCode).toBe(404);
      expect((await as('pm', 'PATCH', item(task.number), { title: 'x' })).statusCode).toBe(404);
      const timeline = (await as('pm', 'GET', base('/timeline'))).json() as { edges: unknown[] };
      expect(timeline.edges).toEqual([]);
      const work = (await as('member', 'GET', '/api/v1/me/work')).json() as {
        items: { id: string }[];
      };
      expect(work.items.map((i) => i.id)).not.toContain(task.id);
      const projects = (await as('pm', 'GET', '/api/v1/projects')).json() as {
        items?: { summary?: { open: number } }[];
      };
      expect(JSON.stringify(projects)).not.toContain(task.id);
      // A new parent or dependency cannot name a trashed item.
      const other = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
      expect(
        (await as('pm', 'POST', `${item(other.number)}/dependencies`, { blockingItemId: task.id }))
          .statusCode,
      ).toBe(400);
    });

    it('lets a trashed child no longer block deleting its parent', async () => {
      const story = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        type: 'STORY',
        bucketId: todo,
      });
      const task = await seedItem(prisma, projectId, {
        createdById: ids.pm,
        parentId: story.id,
        bucketId: todo,
      });
      await trash(task.number);
      expect((await as('pm', 'DELETE', item(story.number))).statusCode).toBe(200);
    });

    it('moves trashed items along when their bucket is deleted', async () => {
      const doing = await seedBucket(prisma, projectId, 'Doing');
      const gone = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: doing.id });
      const batch = await trash(gone.number);
      // Only trashed items are left, so no destination is needed.
      expect((await as('pm', 'DELETE', base(`/buckets/${doing.id}`))).statusCode).toBe(204);
      expect((await as('pm', 'POST', base(`/trash/${batch}/restore`))).statusCode).toBe(200);
      const back = (await as('pm', 'GET', item(gone.number))).json() as WorkItemDto;
      expect(back.bucketId).toBe(todo);
    });
  });

  describe('purge', () => {
    it('removes batches older than the retention, one audit entry each', async () => {
      const old = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
      const recent = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
      await trash(old.number);
      await trash(recent.number);
      await prisma.workItem.update({
        where: { id: old.id },
        data: { deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
      });
      expect(await app.get(TrashService).purgeExpired(new Date())).toBe(1);
      expect(await prisma.workItem.count({ where: { id: old.id } })).toBe(0);
      expect(await prisma.workItem.count({ where: { id: recent.id } })).toBe(1);
      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { action: AuditAction.ITEM_PURGED },
      });
      expect(entry).toMatchObject({ actorId: null, entityId: old.id });
      expect(entry.meta).toMatchObject({ automatic: true, count: 1 });
    });

    it('follows the admin retention setting', async () => {
      const own = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
      await trash(own.number);
      const saved = await as('admin', 'PUT', '/api/v1/admin/settings/storage', {
        maxFileSizeMb: 25,
        projectQuotaMb: 2048,
        personalQuotaMb: 1024,
        trashRetentionDays: 1,
      });
      expect(saved.statusCode).toBe(200);
      const tooLong = await as('admin', 'PUT', '/api/v1/admin/settings/storage', {
        maxFileSizeMb: 25,
        projectQuotaMb: 2048,
        personalQuotaMb: 1024,
        trashRetentionDays: 366,
      });
      expect(tooLong.statusCode).toBe(400);
      const inTwoDays = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
      expect(await app.get(TrashService).purgeExpired(inTwoDays)).toBe(1);
    });
  });
});
