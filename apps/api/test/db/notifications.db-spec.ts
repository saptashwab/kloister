import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  ErrorCode,
  type NotificationDto,
  NotificationType,
  type Page,
  type UnreadCountDto,
} from '@kloister/shared';
import { toDbDate } from '../../src/common/dates.js';
import { localDate } from '../../src/notifications/due-dates.js';
import { NotificationsService } from '../../src/notifications/notifications.service.js';
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

// In-app notifications against a real database (SPEC §6): the five types,
// who receives them (never the actor, never someone who cannot see the
// item), the daily due-date check, and the recipient-only endpoints.

const NAMES = ['pm', 'member', 'member2', 'viewer', 'outsider', 'admin'] as const;
type Name = (typeof NAMES)[number];

describe('notifications (db)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let ids: Record<Name, string>;
  let projectId: string;
  let buckets: Record<'todo' | 'done', string>;
  /** Created by the Member, in To Do. */
  let memberItem: { id: string; number: number };
  /** Created by the PM, in To Do. */
  let pmItem: { id: string; number: number };
  let sessions: Partial<Record<Name, string>> = {};

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
  });

  afterAll(async () => {
    await app.close();
  });

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
        { userId: ids.member, role: 'MEMBER' },
        { userId: ids.member2, role: 'MEMBER' },
        { userId: ids.viewer, role: 'VIEWER' },
      ])
    ).id;
    buckets = {
      todo: (await seedBucket(prisma, projectId, 'To Do')).id,
      done: (
        await seedBucket(prisma, projectId, 'Done', { onEnterMode: 'SET', onEnterStatus: 'DONE' })
      ).id,
    };
    memberItem = await seedItem(prisma, projectId, {
      createdById: ids.member,
      bucketId: buckets.todo,
    });
    pmItem = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: buckets.todo });
  });

  const item = (n: number) => `/api/v1/projects/${projectId}/items/${n}`;

  /**
   * Sends one request as a seeded user.
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

  /**
   * A user's notifications as the API lists them.
   *
   * @param name Seeded user.
   * @param query Optional query string.
   * @returns The notifications.
   */
  async function inbox(name: Name, query = ''): Promise<NotificationDto[]> {
    const res = await as(name, 'GET', `/api/v1/notifications${query}`);
    expect(res.statusCode).toBe(200);
    return (res.json() as Page<NotificationDto>).items;
  }

  /**
   * Stored notifications of one user, as type and item id pairs.
   *
   * @param name Seeded user.
   * @returns The rows.
   */
  async function stored(name: Name): Promise<[string, string][]> {
    const rows = await prisma.notification.findMany({
      where: { userId: ids[name] },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => [r.type, r.workItemId]);
  }

  describe('assigned to you', () => {
    it('notifies people someone else assigns, on create and on edit', async () => {
      const created = await as('pm', 'POST', `/api/v1/projects/${projectId}/items`, {
        type: 'TASK',
        title: 'New',
        bucketId: buckets.todo,
        assigneeIds: [ids.member, ids.pm],
      });
      const newId = (created.json() as { id: string }).id;
      await as('pm', 'PATCH', item(pmItem.number), { assigneeIds: [ids.member2] });
      expect(await stored('member')).toEqual([[NotificationType.ASSIGNED, newId]]);
      expect(await stored('member2')).toEqual([[NotificationType.ASSIGNED, pmItem.id]]);
      // Assigning yourself notifies nobody.
      expect(await stored('pm')).toEqual([]);
    });

    it('only notifies newly added assignees', async () => {
      await as('pm', 'PATCH', item(pmItem.number), { assigneeIds: [ids.member] });
      await as('pm', 'PATCH', item(pmItem.number), { assigneeIds: [ids.member, ids.member2] });
      expect(await stored('member')).toHaveLength(1);
      expect(await stored('member2')).toHaveLength(1);
    });

    it('skips assignees who cannot see the item and deactivated accounts', async () => {
      await prisma.projectMember.update({
        where: { projectId_userId: { projectId, userId: ids.member2 } },
        data: { visibility: 'BUCKETS', allowedBucketIds: [buckets.done] },
      });
      await prisma.user.update({ where: { id: ids.viewer }, data: { isActive: false } });
      // member2 cannot see To Do even when assigned (BUCKETS scope).
      const res = await as('pm', 'PATCH', item(pmItem.number), {
        assigneeIds: [ids.member2, ids.viewer],
      });
      expect(res.statusCode).toBe(200);
      expect(await prisma.notification.count()).toBe(0);
    });
  });

  describe('status change on items you created', () => {
    it('notifies the creator when someone else changes the status, also by a move', async () => {
      await as('pm', 'PATCH', item(memberItem.number), { status: 'IN_PROGRESS' });
      await as('pm', 'POST', `${item(memberItem.number)}/move`, { bucketId: buckets.done });
      expect(await stored('member')).toEqual([
        [NotificationType.STATUS_CHANGED, memberItem.id],
        [NotificationType.STATUS_CHANGED, memberItem.id],
      ]);
    });

    it('does not notify creators about their own changes or moves that keep the status', async () => {
      await as('member', 'PATCH', item(memberItem.number), { status: 'IN_PROGRESS' });
      const todo2 = (await seedBucket(prisma, projectId, 'Later')).id;
      await as('pm', 'POST', `${item(memberItem.number)}/move`, { bucketId: todo2 });
      await as('pm', 'PATCH', item(memberItem.number), { title: 'Renamed' });
      expect(await stored('member')).toEqual([]);
    });
  });

  describe('mentioned', () => {
    const mention = (id: string, name: string) => `<span data-mention="${id}">@${name}</span>`;

    it('notifies mentioned people who can see the item, not the author', async () => {
      await prisma.projectMember.update({
        where: { projectId_userId: { projectId, userId: ids.member2 } },
        data: { visibility: 'OWN' },
      });
      await as('member', 'POST', `${item(pmItem.number)}/notes`, {
        body: `<p>${mention(ids.viewer, 'viewer')} ${mention(ids.member2, 'member2')} ${mention(ids.member, 'me')} ${mention(ids.outsider, 'outsider')}</p>`,
      });
      expect(await stored('viewer')).toEqual([[NotificationType.MENTIONED, pmItem.id]]);
      expect(await stored('member2')).toEqual([]);
      expect(await stored('member')).toEqual([]);
      expect(await stored('outsider')).toEqual([]);
    });

    it('notifies only newly mentioned people when a note is edited', async () => {
      const res = await as('member', 'POST', `${item(pmItem.number)}/notes`, {
        body: mention(ids.viewer, 'viewer'),
      });
      const noteId = (res.json() as { id: string }).id;
      await as('member', 'PATCH', `${item(pmItem.number)}/notes/${noteId}`, {
        body: `${mention(ids.viewer, 'viewer')} ${mention(ids.pm, 'pm')}`,
      });
      expect(await stored('viewer')).toHaveLength(1);
      expect(await stored('pm')).toEqual([[NotificationType.MENTIONED, pmItem.id]]);
    });
  });

  describe('due dates (daily check at 09:00 server time)', () => {
    const now = new Date();
    const due = async (id: string, days: number, status?: 'DONE') => {
      await prisma.workItem.update({
        where: { id },
        data: { dueDate: toDbDate(localDate(now, days)), ...(status ? { status } : {}) },
      });
    };

    it('announces items due tomorrow and newly overdue items once', async () => {
      await prisma.workItemAssignee.create({
        data: { workItemId: pmItem.id, projectId, userId: ids.member2 },
      });
      await due(pmItem.id, 1);
      // Nobody is assigned, so its creator hears about it.
      await due(memberItem.id, -1);
      const service = app.get(NotificationsService);
      expect(await service.checkDueDates(now)).toBe(2);
      expect(await service.checkDueDates(now)).toBe(0);
      expect(await stored('member2')).toEqual([[NotificationType.DUE_TOMORROW, pmItem.id]]);
      expect(await stored('member')).toEqual([[NotificationType.OVERDUE, memberItem.id]]);
      // The PM created pmItem but it has an assignee.
      expect(await stored('pm')).toEqual([]);
    });

    it('announces items due today whose due time has passed, once (M8.5)', async () => {
      const nine = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0);
      await prisma.workItem.update({
        where: { id: memberItem.id },
        data: { dueDate: toDbDate(localDate(nine)), dueTime: 8 * 60 },
      });
      await prisma.workItem.update({
        where: { id: pmItem.id },
        data: { dueDate: toDbDate(localDate(nine)), dueTime: 17 * 60 },
      });
      const service = app.get(NotificationsService);
      expect(await service.checkDueDates(nine)).toBe(1);
      expect(await service.checkDueDates(nine)).toBe(0);
      expect(await stored('member')).toEqual([[NotificationType.OVERDUE, memberItem.id]]);
    });

    it('skips Done items, items overdue for more than a week and archived projects', async () => {
      await due(pmItem.id, 1, 'DONE');
      await due(memberItem.id, -8);
      const service = app.get(NotificationsService);
      expect(await service.checkDueDates(now)).toBe(0);
      await due(memberItem.id, 1);
      await prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
      expect(await service.checkDueDates(now)).toBe(0);
    });
  });

  describe('the recipient endpoints', () => {
    beforeEach(async () => {
      await as('pm', 'PATCH', item(pmItem.number), { assigneeIds: [ids.member] });
      await as('pm', 'PATCH', item(memberItem.number), { status: 'BLOCKED' });
      // Fixed times, so "newest first" never depends on two writes' milliseconds.
      await prisma.notification.updateMany({
        where: { workItemId: pmItem.id },
        data: { createdAt: new Date('2026-10-14T08:00:00.000Z') },
      });
      await prisma.notification.updateMany({
        where: { workItemId: memberItem.id },
        data: { createdAt: new Date('2026-10-14T09:00:00.000Z') },
      });
    });

    it("lists the caller's notifications newest first, with the item and actor", async () => {
      const list = await inbox('member');
      expect(list.map((n) => [n.type, n.item.key])).toEqual([
        [NotificationType.STATUS_CHANGED, `KLO-${memberItem.number}`],
        [NotificationType.ASSIGNED, `KLO-${pmItem.number}`],
      ]);
      expect(list[0]).toMatchObject({
        item: { projectKey: 'KLO', number: memberItem.number },
        actor: { id: ids.pm, displayName: 'pm' },
        readAt: null,
      });
      expect(await inbox('member2')).toEqual([]);
    });

    it('counts unread notifications and marks them read', async () => {
      const count = async () =>
        ((await as('member', 'GET', '/api/v1/notifications/unread-count')).json() as UnreadCountDto)
          .count;
      expect(await count()).toBe(2);
      const [first] = await inbox('member');
      expect(
        (await as('member', 'POST', `/api/v1/notifications/${first?.id ?? ''}/read`)).statusCode,
      ).toBe(204);
      expect(await count()).toBe(1);
      expect(await inbox('member', '?unread=true')).toHaveLength(1);
      expect((await as('member', 'POST', '/api/v1/notifications/read-all')).statusCode).toBe(204);
      expect(await count()).toBe(0);
      expect((await inbox('member')).every((n) => n.readAt !== null)).toBe(true);
    });

    it("answers 404 for anyone else's notification and changes nothing", async () => {
      const [mine] = await inbox('member');
      for (const name of ['member2', 'pm', 'admin', 'outsider'] as const) {
        const res = await as(name, 'POST', `/api/v1/notifications/${mine?.id ?? ''}/read`);
        expect(res.statusCode).toBe(404);
        expect(codeOf(res)).toBe(ErrorCode.NOT_FOUND);
      }
      expect(await prisma.notification.count({ where: { readAt: { not: null } } })).toBe(0);
    });

    it('hides notifications about items the recipient can no longer see', async () => {
      await prisma.projectMember.update({
        where: { projectId_userId: { projectId, userId: ids.member } },
        data: { visibility: 'OWN' },
      });
      await prisma.workItemAssignee.deleteMany({ where: { workItemId: pmItem.id } });
      const list = await inbox('member');
      expect(list.map((n) => n.item.id)).toEqual([memberItem.id]);
      const hidden = await prisma.notification.findFirstOrThrow({
        where: { userId: ids.member, workItemId: pmItem.id },
      });
      const read = await as('member', 'POST', `/api/v1/notifications/${hidden.id}/read`);
      expect(read.statusCode).toBe(404);
      const count = (
        await as('member', 'GET', '/api/v1/notifications/unread-count')
      ).json() as UnreadCountDto;
      expect(count.count).toBe(1);
    });

    it('applies the BUCKETS and TEAMS scopes and team Lead rights to the list and count', async () => {
      const count = async () =>
        ((await as('member', 'GET', '/api/v1/notifications/unread-count')).json() as UnreadCountDto)
          .count;
      const scope = (visibility: 'BUCKETS' | 'TEAMS' | 'OWN', allowedBucketIds: string[] = []) =>
        prisma.projectMember.update({
          where: { projectId_userId: { projectId, userId: ids.member } },
          data: { visibility, allowedBucketIds },
        });
      await scope('BUCKETS', [buckets.done]);
      expect(await inbox('member')).toEqual([]);
      expect(await count()).toBe(0);

      const team = await seedTeam(prisma, projectId, 'T', [{ userId: ids.member, role: 'MEMBER' }]);
      await prisma.workItem.update({ where: { id: pmItem.id }, data: { teamId: team.id } });
      await scope('TEAMS');
      expect((await inbox('member')).map((n) => n.item.id)).toEqual([pmItem.id]);
      expect(await count()).toBe(1);

      // Leading the team shows its items under any scope (SPEC §3.5).
      await prisma.teamMember.updateMany({ where: { teamId: team.id }, data: { role: 'LEAD' } });
      await prisma.workItemAssignee.deleteMany({ where: { workItemId: pmItem.id } });
      await scope('OWN');
      expect((await inbox('member')).map((n) => n.item.id).sort()).toEqual(
        [pmItem.id, memberItem.id].sort(),
      );
    });

    it('hides notifications of archived projects and of projects the recipient left', async () => {
      await prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
      expect(await inbox('member')).toEqual([]);
      await prisma.project.update({ where: { id: projectId }, data: { archivedAt: null } });
      await prisma.projectMember.delete({
        where: { projectId_userId: { projectId, userId: ids.member } },
      });
      expect(await inbox('member')).toEqual([]);
    });

    it('deletes notifications with their item', async () => {
      expect((await as('pm', 'DELETE', item(pmItem.number))).statusCode).toBe(204);
      expect(await prisma.notification.count({ where: { workItemId: pmItem.id } })).toBe(0);
    });

    it('gives an empty page for a cursor the caller cannot use', async () => {
      const other = await prisma.notification.findFirstOrThrow({ where: { userId: ids.member } });
      const res = await as('member2', 'GET', `/api/v1/notifications?cursor=${other.id}`);
      expect(res.json()).toEqual({ items: [], nextCursor: null });
    });
  });
});
