import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AuditAction, CLIENT_ID_HEADER, CSRF_HEADER, CSRF_HEADER_VALUE } from '@kloister/shared';
import { AuditService } from '../../src/audit/audit.service.js';
import { LiveHub } from '../../src/live/live-hub.js';
import { PgListener } from '../../src/live/pg-listener.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  call,
  login,
  resetDb,
  seedBucket,
  seedItem,
  seedProject,
  seedUser,
  startApp,
} from './support.js';

// Live updates against a real database and a real HTTP listener (M10 plan
// section 12): committed changes reach streams through LISTEN/NOTIFY,
// refused or rolled-back ones never do, bursts coalesce, visibility
// filters every event, and the stream never extends a session.

const NAMES = ['pm', 'member', 'scoped', 'outsider', 'admin'] as const;
type Name = (typeof NAMES)[number];

/** One open stream read over HTTP. */
interface OpenStream {
  /** Stream id from hello. */
  id: string;
  /** Events received so far. */
  events: { event: string; data: Record<string, unknown> }[];
  /** True once the server ended the stream. */
  ended: boolean;
  /** Closes it from the client side. */
  close(): void;
}

describe('live updates (db)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let base: string;
  let ids: Record<Name, string>;
  let sids: Record<Name, string>;
  let projectId: string;
  let todo: string;
  let other: string;
  const opened: OpenStream[] = [];

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    for (const s of opened.splice(0)) s.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    const seeded: Partial<Record<Name, string>> = {};
    for (const name of NAMES)
      seeded[name] = (
        await seedUser(prisma, {
          email: `${name}@example.org`,
          systemRole: name === 'admin' ? 'ADMIN' : 'USER',
        })
      ).id;
    ids = seeded as Record<Name, string>;
    projectId = (
      await seedProject(prisma, 'KLO', [
        { userId: ids.pm, role: 'PM' },
        { userId: ids.member, role: 'MEMBER' },
        { userId: ids.scoped, role: 'MEMBER', visibility: 'OWN' },
      ])
    ).id;
    todo = (await seedBucket(prisma, projectId, 'To Do')).id;
    other = (await seedBucket(prisma, projectId, 'Doing')).id;
    const tokens: Partial<Record<Name, string>> = {};
    for (const name of NAMES) tokens[name] = await login(app, `${name}@example.org`);
    sids = tokens as Record<Name, string>;
  });

  /**
   * Opens a stream over HTTP and waits for hello and a listening channel.
   *
   * @param name Who opens it.
   * @param client The tab's client id.
   * @returns The stream.
   */
  async function open(name: Name, client = `tab-${name}-0000`): Promise<OpenStream> {
    const abort = new AbortController();
    const response = await fetch(`${base}/api/v1/events?client=${client}`, {
      headers: { cookie: `sid=${sids[name]}` },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(response.headers.get('content-encoding')).toBeNull();
    const stream: OpenStream = { id: '', events: [], ended: false, close: () => abort.abort() };
    opened.push(stream);
    void (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = text.indexOf('\n\n')) !== -1) {
            const frame = text.slice(0, end);
            text = text.slice(end + 2);
            const event = /^event: (.+)$/m.exec(frame)?.[1];
            const data = /^data: (.+)$/m.exec(frame)?.[1];
            if (event !== undefined && data !== undefined)
              stream.events.push({ event, data: JSON.parse(data) as Record<string, unknown> });
          }
        }
      } catch {
        // Aborted by the test.
      }
      stream.ended = true;
    })();
    await until(() => stream.events.some((e) => e.event === 'hello'));
    stream.id = stream.events[0].data['streamId'] as string;
    await until(() => app.get(PgListener).listening);
    return stream;
  }

  /**
   * Waits for a condition, failing after five seconds.
   *
   * @param check The condition.
   * @returns Resolves once it holds.
   */
  async function until(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Waits long enough for any pending delivery.
   *
   * @returns Resolves after a quiet period.
   */
  async function quiet(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await app.get(LiveHub).settle();
  }

  /**
   * Follows the project with a stream.
   *
   * @param name The stream's owner.
   * @param stream The stream.
   * @param project Project id or key.
   * @returns The response status.
   */
  async function follow(name: Name, stream: OpenStream, project: string | null = projectId) {
    const res = await call(app, 'PUT', `/api/v1/events/${stream.id}/project`, {
      sid: sids[name],
      body: { projectId: project },
    });
    return res.statusCode;
  }

  const events = (stream: OpenStream, name: string) =>
    stream.events.filter((e) => e.event === name);

  it('requires a session and answers 204 while switched off', async () => {
    const anonymous = await fetch(`${base}/api/v1/events`);
    expect(anonymous.status).toBe(401);
    const status = await call(app, 'GET', '/api/v1/events/status', { sid: sids.member });
    expect(status.json()).toEqual({ enabled: true });
    await call(app, 'PUT', '/api/v1/admin/settings/live', {
      sid: sids.admin,
      body: { enabled: false },
    });
    const off = await app.inject({
      method: 'GET',
      url: '/api/v1/events',
      cookies: { sid: sids.member },
    });
    expect(off.statusCode).toBe(204);
  });

  it('lets only members follow a project, and only with their own stream', async () => {
    const member = await open('member');
    const admin = await open('admin');
    const outsider = await open('outsider');
    expect(await follow('member', member)).toBe(204);
    expect(await follow('member', member, 'KLO')).toBe(204);
    expect(await follow('outsider', outsider)).toBe(404);
    // An admin who is not a member gets 404 and leaves no cross-project entry.
    expect(await follow('admin', admin)).toBe(404);
    expect(
      await prisma.auditLog.count({ where: { action: AuditAction.ADMIN_CROSS_PROJECT_ACCESS } }),
    ).toBe(0);
    // Someone else's stream is unknown.
    expect(await follow('outsider', member, null)).toBe(404);
  });

  it('follows another person’s work for people the caller may look up, within their scope (v1.4.0)', async () => {
    const item = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
    await prisma.workItemAssignee.create({
      data: { workItemId: item.id, userId: ids.pm, projectId },
    });
    const member = await open('member');
    const scoped = await open('scoped');
    const outsider = await open('outsider');
    const admin = await open('admin');
    const work = (name: Name, stream: OpenStream, userId: string | null) =>
      call(app, 'PUT', `/api/v1/events/${stream.id}/work`, { sid: sids[name], body: { userId } });
    expect((await work('member', member, ids.pm)).statusCode).toBe(204);
    expect((await work('scoped', scoped, ids.pm)).statusCode).toBe(204);
    // People who share no project with the caller, and unknown people, are 404.
    expect((await work('outsider', outsider, ids.pm)).statusCode).toBe(404);
    expect((await work('member', member, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(
      404,
    );
    // Administrators may look anyone up, as for "View all their work".
    expect((await work('admin', admin, ids.pm)).statusCode).toBe(204);
    // Someone else's stream is unknown; a bad id is refused.
    expect((await work('outsider', member, null)).statusCode).toBe(404);
    expect((await work('member', member, 'nope')).statusCode).toBe(400);

    // A refused request (the unknown person above) leaves the stream following
    // nobody else, so the member follows the PM again.
    expect((await work('member', member, ids.pm)).statusCode).toBe(204);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/items/${item.id}/move`,
      headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE, [CLIENT_ID_HEADER]: 'tab-pm-0000' },
      cookies: { sid: sids.pm },
      payload: { bucketId: other },
    });
    expect(res.statusCode).toBe(200);
    await until(() => events(member, 'item-changed').length > 0);
    expect(events(member, 'item-changed')[0].data).toEqual({
      projectId,
      items: [{ id: item.id, actorId: ids.pm }],
    });
    await quiet();
    // The OWN-scoped Member cannot see the PM's item; the admin is no member.
    expect(scoped.events.filter((e) => e.event.startsWith('item'))).toEqual([]);
    expect(admin.events.filter((e) => e.event.startsWith('item'))).toEqual([]);
    // Back to their own work: no more of the PM's changes.
    expect((await work('member', member, null)).statusCode).toBe(204);
    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/items/${item.id}/move`,
      headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE, [CLIENT_ID_HEADER]: 'tab-pm-0000' },
      cookies: { sid: sids.pm },
      payload: { bucketId: todo },
    });
    await quiet();
    expect(events(member, 'item-changed')).toHaveLength(1);
  });

  it('accepts presence only on visible items of the followed project, on own streams', async () => {
    const hidden = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
    const own = await seedItem(prisma, projectId, { createdById: ids.scoped, bucketId: todo });
    const scoped = await open('scoped');
    const member = await open('member');
    const presence = (name: Name, stream: OpenStream, itemId: string | null) =>
      call(app, 'PUT', `/api/v1/events/${stream.id}/presence`, {
        sid: sids[name],
        body: { itemId, action: itemId === null ? null : 'viewing', field: null },
      });
    // Not following a project yet.
    expect((await presence('scoped', scoped, own.id)).statusCode).toBe(404);
    await follow('scoped', scoped);
    expect((await presence('scoped', scoped, own.id)).statusCode).toBe(204);
    // Outside the OWN scope: answered like an unknown item.
    expect((await presence('scoped', scoped, hidden.id)).statusCode).toBe(404);
    // Someone else's stream.
    expect((await presence('member', scoped, null)).statusCode).toBe(404);
    // A field outside the known list is refused.
    const bad = await call(app, 'PUT', `/api/v1/events/${member.id}/presence`, {
      sid: sids.member,
      body: { itemId: null, action: 'editing', field: 'secret notes' },
    });
    expect(bad.statusCode).toBe(400);
    // So is a page outside the known list; a known page is accepted.
    const badView = await call(app, 'PUT', `/api/v1/events/${scoped.id}/presence`, {
      sid: sids.scoped,
      body: { itemId: null, action: null, field: null, view: 'secret page' },
    });
    expect(badView.statusCode).toBe(400);
    const view = await call(app, 'PUT', `/api/v1/events/${scoped.id}/presence`, {
      sid: sids.scoped,
      body: { itemId: own.id, action: 'viewing', field: null, view: 'timeline' },
    });
    expect(view.statusCode).toBe(204);
    // Someone else's stream stays refused with a page too.
    const foreign = await call(app, 'PUT', `/api/v1/events/${scoped.id}/presence`, {
      sid: sids.member,
      body: { itemId: null, action: null, field: null, view: 'board' },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('filters the item list by ids within the caller’s scope, at most 100', async () => {
    const hidden = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
    const own = await seedItem(prisma, projectId, { createdById: ids.scoped, bucketId: todo });
    const res = await call(
      app,
      'GET',
      `/api/v1/projects/${projectId}/items?ids=${hidden.id},${own.id}`,
      {
        sid: sids.scoped,
      },
    );
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([own.id]);
    const many = Array.from({ length: 101 }, () => own.id).join(',');
    const tooMany = await call(app, 'GET', `/api/v1/projects/${projectId}/items?ids=${many}`, {
      sid: sids.scoped,
    });
    expect(tooMany.statusCode).toBe(400);
  });

  it('delivers committed item changes to viewers who can see them', async () => {
    const item = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
    const member = await open('member');
    const scoped = await open('scoped');
    await follow('member', member);
    await follow('scoped', scoped);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/items/${item.id}/move`,
      headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE, [CLIENT_ID_HEADER]: 'tab-pm-0000' },
      cookies: { sid: sids.pm },
      payload: { bucketId: other },
    });
    expect(res.statusCode).toBe(200);
    await until(() => events(member, 'item-changed').length > 0);
    expect(events(member, 'item-changed')[0].data).toEqual({
      projectId,
      items: [{ id: item.id, actorId: ids.pm }],
    });
    await quiet();
    // The OWN-scoped Member never hears of the PM's item.
    expect(scoped.events.filter((e) => e.event.startsWith('item'))).toEqual([]);
  });

  it('announces trash as a removal and restore as a change, to viewers only (M12)', async () => {
    const item = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
    const member = await open('member');
    const scoped = await open('scoped');
    await follow('member', member);
    await follow('scoped', scoped);
    const send = (method: 'DELETE' | 'POST', url: string) =>
      app.inject({
        method,
        url,
        headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE, [CLIENT_ID_HEADER]: 'tab-pm-0000' },
        cookies: { sid: sids.pm },
      });
    const trashed = await send('DELETE', `/api/v1/projects/${projectId}/items/${item.id}`);
    expect(trashed.statusCode).toBe(200);
    await until(() => events(member, 'item-removed').length > 0);
    expect(events(member, 'item-removed')[0].data).toMatchObject({
      projectId,
      items: [{ id: item.id }],
    });
    const { batchId } = trashed.json<{ batchId: string }>();
    const restored = await send('POST', `/api/v1/projects/${projectId}/trash/${batchId}/restore`);
    expect(restored.statusCode).toBe(200);
    await until(() => events(member, 'item-changed').length > 0);
    expect(events(member, 'item-changed')[0].data).toMatchObject({
      projectId,
      items: [{ id: item.id, actorId: ids.pm }],
    });
    await quiet();
    // The OWN-scoped Member hears of neither.
    expect(scoped.events.filter((e) => e.event.startsWith('item'))).toEqual([]);
  });

  it('never announces refused or rolled-back changes', async () => {
    const item = await seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo });
    const member = await open('member');
    await follow('member', member);
    // A Member may not move the PM's card: 403, nothing sent.
    const refused = await call(app, 'POST', `/api/v1/projects/${projectId}/items/${item.id}/move`, {
      sid: sids.member,
      body: { bucketId: other },
    });
    expect(refused.statusCode).toBe(403);
    const audit = app.get(AuditService);
    await expect(
      prisma.$transaction(async (tx) => {
        await audit.record(
          {
            actorId: ids.pm,
            action: AuditAction.ITEM_UPDATED,
            entityType: 'WorkItem',
            entityId: item.id,
            projectId,
          },
          tx,
        );
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    await quiet();
    expect(events(member, 'item-changed')).toEqual([]);
  });

  it('coalesces the changes of one transaction into one event', async () => {
    const items = await Promise.all(
      [1, 2, 3].map(() => seedItem(prisma, projectId, { createdById: ids.pm, bucketId: todo })),
    );
    const member = await open('member');
    await follow('member', member);
    const audit = app.get(AuditService);
    await prisma.$transaction(async (tx) => {
      for (const item of items)
        await audit.record(
          {
            actorId: ids.pm,
            action: AuditAction.ITEM_UPDATED,
            entityType: 'WorkItem',
            entityId: item.id,
            projectId,
          },
          tx,
        );
    });
    await until(() => events(member, 'item-changed').length > 0);
    await quiet();
    expect(events(member, 'item-changed')).toHaveLength(1);
    expect((events(member, 'item-changed')[0].data['items'] as unknown[]).length).toBe(3);
  });

  it('tells a removed member their access changed and stops their events', async () => {
    const member = await open('member');
    await follow('member', member);
    const res = await call(app, 'DELETE', `/api/v1/projects/${projectId}/members/${ids.member}`, {
      sid: sids.pm,
    });
    expect(res.statusCode).toBe(204);
    await until(() => events(member, 'access-changed').length > 0);
    await seedItem(prisma, projectId, { createdById: ids.member, bucketId: todo });
    await call(app, 'POST', `/api/v1/projects/${projectId}/items`, {
      sid: sids.pm,
      body: { type: 'TASK', title: 'After removal', bucketId: todo },
    });
    await quiet();
    expect(events(member, 'item-changed')).toEqual([]);
  });

  it('never extends the session and closes at sign-out', async () => {
    const stale = new Date(Date.now() - 10 * 60_000);
    const session = await prisma.session.findFirstOrThrow({ where: { userId: ids.member } });
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: stale } });
    const member = await open('member');
    await follow('member', member);
    await call(app, 'PUT', `/api/v1/events/${member.id}/presence`, {
      sid: sids.member,
      body: { itemId: null, action: null, field: null },
    });
    const after = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(after.lastSeenAt.getTime()).toBe(stale.getTime());
    await call(app, 'POST', '/api/v1/auth/logout', { sid: sids.member });
    await until(() => member.ended);
  });

  it('sends notifications to the recipient only', async () => {
    const item = await seedItem(prisma, projectId, { createdById: ids.member, bucketId: todo });
    const member = await open('member');
    const scoped = await open('scoped');
    await call(app, 'PATCH', `/api/v1/projects/${projectId}/items/${item.id}`, {
      sid: sids.pm,
      body: { status: 'IN_PROGRESS' },
    });
    await until(() => events(member, 'notification').length > 0);
    expect(events(scoped, 'notification')).toEqual([]);
  });
});
