import { jest } from '@jest/globals';
import {
  LIVE_MAX_STREAMS_PER_USER,
  LIVE_RESYNC_THRESHOLD,
  permissionsFor,
  PRESENCE_DELAY_MS,
  ProjectRole,
  TeamRole,
  Visibility,
} from '@kloister/shared';
import { makeProject, makeUser } from '../../test/support/fakes.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { SessionService } from '../auth/session.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { type ProjectAccess, ProjectAccessService } from '../projects/project-access.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { LiveMessage, WireFacts } from './live-events.js';
import { LiveHub, type StreamSink } from './live-hub.js';
import type { PgListener } from './pg-listener.js';

// Fan-out and presence of the live hub (M10 plan sections 5.3, 5.5, 12),
// without a database: channel messages are fed in directly and the
// published presence messages loop back as the listener would deliver them.

const PROJECT = '33333333-3333-4333-8333-333333333333';
const PERSONAL = '34333333-3333-4333-8333-333333333333';
const BUCKET_A = '44444444-4444-4444-8444-444444444444';
const BUCKET_B = '55555555-5555-4555-8555-555555555555';
const TEAM = '66666666-6666-4666-8666-666666666666';
const ITEM = '77777777-7777-4777-8777-777777777777';
const ITEM_2 = '78777777-7777-4777-8777-777777777777';
const ITEM_3 = '79777777-7777-4777-8777-777777777777';

const PM = '11111111-1111-4111-8111-111111111111';
const OWN = '12111111-1111-4111-8111-111111111111';
const BUCKETS = '13111111-1111-4111-8111-111111111111';
const TEAMS = '14111111-1111-4111-8111-111111111111';
const LEAD = '15111111-1111-4111-8111-111111111111';
const VIEWER = '16111111-1111-4111-8111-111111111111';
const ADMIN = '17111111-1111-4111-8111-111111111111';
/** A user who shares no project with anyone above. */
const STRANGER = '18111111-1111-4111-8111-111111111111';

const project = makeProject({ id: PROJECT });

/**
 * Builds a member's access as the access service would.
 *
 * @param userId The member.
 * @param role Project role.
 * @param visibility Scope for Members and Viewers.
 * @param teams Team places.
 * @returns The access.
 */
function memberAccess(
  userId: string,
  role: ProjectRole,
  visibility: Visibility = Visibility.ALL,
  teams: { teamId: string; role: TeamRole }[] = [],
): ProjectAccess {
  const scoped = role === ProjectRole.MEMBER || role === ProjectRole.VIEWER;
  return {
    project,
    settings: { membersCanAssignOthers: false, planLeadsOnly: true } as ProjectAccess['settings'],
    userId,
    role,
    isSystemAdmin: false,
    visibility: scoped ? visibility : Visibility.ALL,
    allowedBucketIds: visibility === Visibility.BUCKETS ? [BUCKET_A] : [],
    teams,
    permissions: new Set(permissionsFor(role, { membersCanAssignOthers: false })),
  };
}

/** Facts of an item in bucket A, team TEAM, created by the PM, no assignees. */
const facts = (overrides: Partial<WireFacts> = {}): WireFacts => ({
  c: PM,
  a: [],
  b: BUCKET_A,
  t: null,
  ...overrides,
});

/** What one fake stream received. */
interface Received {
  events: { event: string; data: unknown }[];
  ended: boolean;
}

/**
 * Builds a hub with fake collaborators.
 *
 * @param accesses Each user's access to {@link PROJECT}.
 * @returns The hub and its fakes.
 */
function build(accesses: Map<string, ProjectAccess>) {
  const sent: LiveMessage[] = [];
  const live = { enabled: true };
  const liveSessions = new Set<string>();
  const itemFacts = new Map<string, WireFacts>([
    [ITEM, facts()],
    [ITEM_2, facts({ b: BUCKET_B })],
    [ITEM_3, facts()],
  ]);
  // Set below; the fake database delivers published messages to it.
  const loop: { hub: LiveHub | null } = { hub: null };
  const row = (id: string) => {
    const f = itemFacts.get(id);
    return f === undefined
      ? null
      : {
          createdById: f.c,
          bucketId: f.b,
          teamId: f.t,
          assignees: f.a.map((userId) => ({ userId })),
        };
  };
  const prisma = {
    project: {
      findUnique: ({ where }: { where: { id?: string } }) =>
        Promise.resolve(where.id === PROJECT || where.id === PERSONAL ? { id: where.id } : null),
    },
    workItem: {
      findFirst: ({ where }: { where: { id: string } }) => Promise.resolve(row(where.id)),
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.flatMap((id) => {
            const found = row(id);
            return found === null ? [] : [{ id, ...found }];
          }),
        ),
    },
    user: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(
          accesses.has(where.id) || where.id === ADMIN || where.id === STRANGER
            ? { id: where.id }
            : null,
        ),
    },
    // Members of PROJECT share it; the stranger shares nothing.
    projectMember: {
      count: ({ where }: { where: { userId: string; projectId: { in: string[] } } }) =>
        Promise.resolve(accesses.has(where.userId) && where.projectId.in.includes(PROJECT) ? 1 : 0),
    },
    // Loops published messages back, as the listener would.
    $executeRaw: (_sql: TemplateStringsArray, _channel: string, payload: string) => {
      const message = JSON.parse(payload) as LiveMessage;
      sent.push(message);
      loop.hub?.receive(message);
      return Promise.resolve(1);
    },
  } as unknown as PrismaService;
  const access = new ProjectAccessService(prisma, null as never);
  jest
    .spyOn(access, 'accessesOf')
    .mockImplementation((_db, projectId, userIds) =>
      Promise.resolve<Map<string, ProjectAccess>>(
        projectId === PROJECT
          ? new Map(userIds.flatMap((id) => (accesses.has(id) ? [[id, accesses.get(id)!]] : [])))
          : projectId === PERSONAL && userIds.includes(PM)
            ? new Map([[PM, access.personalAccess(makeProject({ id: PERSONAL, ownerId: PM }), PM)]])
            : new Map<string, ProjectAccess>(),
      ),
    );
  jest
    .spyOn(access, 'memberAccesses')
    .mockImplementation((auth) =>
      Promise.resolve(accesses.has(auth.user.id) ? [accesses.get(auth.user.id)!] : []),
    );
  const sessions = {
    liveSessionIds: (ids: string[]) =>
      Promise.resolve(new Set(ids.filter((id) => liveSessions.has(id)))),
  } as unknown as SessionService;
  const settings = { getLive: () => Promise.resolve({ ...live }) } as unknown as SettingsService;
  const listener = { start: jest.fn(), stop: jest.fn(() => Promise.resolve()) };
  const hub = new LiveHub(prisma, access, sessions, settings, listener as unknown as PgListener);
  loop.hub = hub;

  /**
   * Opens a stream for a user.
   *
   * @param userId The user.
   * @param clientId The tab's client id.
   * @returns The stream id and what it receives.
   */
  const open = (userId: string, clientId: string | null = null) => {
    const received: Received = { events: [], ended: false };
    const sink: StreamSink = {
      write: (chunk) => {
        const event = /^event: (.+)\ndata: (.+)\n\n$/.exec(chunk);
        if (event) received.events.push({ event: event[1], data: JSON.parse(event[2]) });
      },
      end: () => {
        received.ended = true;
      },
    };
    const sessionId = `session-${userId}-${hub.size}`;
    liveSessions.add(sessionId);
    const auth: AuthContext = { user: makeUser({ id: userId }), sessionId };
    const id = hub.open(auth, clientId, sink);
    return { id, auth, received, sessionId };
  };
  return { hub, open, sent, live, liveSessions, itemFacts, listener };
}

/**
 * Names of the events a stream got, without hello and presence.
 *
 * @param received The stream's events.
 * @returns Event names with data.
 */
const changes = (received: Received) =>
  received.events.filter((e) => e.event !== 'hello' && e.event !== 'presence');

/** Everyone of the fan-out matrix, with their access. */
const everyone = new Map<string, ProjectAccess>([
  [PM, memberAccess(PM, ProjectRole.PM)],
  [OWN, memberAccess(OWN, ProjectRole.MEMBER, Visibility.OWN)],
  [BUCKETS, memberAccess(BUCKETS, ProjectRole.MEMBER, Visibility.BUCKETS)],
  [
    TEAMS,
    memberAccess(TEAMS, ProjectRole.MEMBER, Visibility.TEAMS, [
      { teamId: TEAM, role: TeamRole.MEMBER },
    ]),
  ],
  [
    LEAD,
    memberAccess(LEAD, ProjectRole.MEMBER, Visibility.OWN, [{ teamId: TEAM, role: TeamRole.LEAD }]),
  ],
  [VIEWER, memberAccess(VIEWER, ProjectRole.VIEWER, Visibility.BUCKETS)],
]);

describe('LiveHub fan-out', () => {
  afterEach(() => jest.useRealTimers());

  it('sends hello with the stream id first', () => {
    const { open } = build(everyone);
    const { id, received } = open(PM);
    expect(received.events[0]).toEqual({ event: 'hello', data: { streamId: id } });
  });

  it('sends an item change only to followers who can see the item', async () => {
    const { hub, open } = build(everyone);
    const streams = new Map(
      [PM, OWN, BUCKETS, TEAMS, LEAD, VIEWER].map((user) => [user, open(user)]),
    );
    for (const [user, s] of streams) await hub.subscribe(s.auth, s.id, PROJECT).then(() => user);
    // Bucket B, team TEAM, created by OWN.
    hub.receive({
      k: 'item',
      p: PROJECT,
      u: PM,
      c: null,
      i: [{ id: ITEM, f: facts({ b: BUCKET_B, t: TEAM, c: OWN }) }],
    });
    await hub.settle();
    const got = (user: string) =>
      changes(streams.get(user)!.received).some((e) => e.event === 'item-changed');
    expect(got(PM)).toBe(true); // ALL
    expect(got(OWN)).toBe(true); // created it
    expect(got(BUCKETS)).toBe(false); // bucket B is outside the scope
    expect(got(TEAMS)).toBe(true); // team member with TEAMS scope
    expect(got(LEAD)).toBe(true); // leads the item's team
    expect(got(VIEWER)).toBe(false); // bucket B is outside the scope
    expect(changes(streams.get(PM)!.received)[0]).toEqual({
      event: 'item-changed',
      data: { projectId: PROJECT, items: [{ id: ITEM, actorId: PM }] },
    });
  });

  it('never sends a hidden item, not even as a removal', async () => {
    const { hub, open } = build(everyone);
    const viewer = open(BUCKETS);
    await hub.subscribe(viewer.auth, viewer.id, PROJECT);
    hub.receive({
      k: 'item',
      p: PROJECT,
      u: PM,
      c: null,
      i: [{ id: ITEM, f: null, b: facts({ b: BUCKET_B }) }],
    });
    await hub.settle();
    expect(changes(viewer.received)).toEqual([]);
  });

  it('tells a viewer an item left their scope or was deleted', async () => {
    const { hub, open } = build(everyone);
    const viewer = open(BUCKETS);
    await hub.subscribe(viewer.auth, viewer.id, PROJECT);
    hub.receive({
      k: 'item',
      p: PROJECT,
      u: PM,
      c: null,
      i: [{ id: ITEM, f: facts({ b: BUCKET_B }), b: facts() }],
    });
    await hub.settle();
    hub.receive({
      k: 'item',
      p: PROJECT,
      u: PM,
      c: null,
      i: [{ id: ITEM_2, f: null, b: facts() }],
    });
    await hub.settle();
    expect(changes(viewer.received)).toEqual([
      {
        event: 'item-removed',
        data: { projectId: PROJECT, items: [{ id: ITEM, actorId: PM, deleted: false }] },
      },
      {
        event: 'item-removed',
        data: { projectId: PROJECT, items: [{ id: ITEM_2, actorId: PM, deleted: true }] },
      },
    ]);
  });

  it('skips the echo for the tab that made the change, not for the same user elsewhere', async () => {
    const { hub, open } = build(everyone);
    const tab = open(PM, 'tab-aaaaaaaa');
    const other = open(PM, 'tab-bbbbbbbb');
    await hub.subscribe(tab.auth, tab.id, PROJECT);
    await hub.subscribe(other.auth, other.id, PROJECT);
    hub.receive({ k: 'item', p: PROJECT, u: PM, c: 'tab-aaaaaaaa', i: [{ id: ITEM, f: facts() }] });
    hub.receive({ k: 'board', p: PROJECT, u: PM, c: 'tab-aaaaaaaa' });
    await hub.settle();
    expect(changes(tab.received)).toEqual([]);
    expect(changes(other.received).map((e) => e.event)).toEqual(['board-changed', 'item-changed']);
  });

  it('coalesces a burst into one event and resyncs above the threshold', async () => {
    const { hub, open } = build(everyone);
    const pm = open(PM);
    await hub.subscribe(pm.auth, pm.id, PROJECT);
    hub.receive({ k: 'item', p: PROJECT, u: PM, c: null, i: [{ id: ITEM, f: facts() }] });
    hub.receive({ k: 'item', p: PROJECT, u: PM, c: null, i: [{ id: ITEM_2, f: facts() }] });
    await hub.settle();
    expect(changes(pm.received)).toHaveLength(1);
    expect(changes(pm.received)[0]?.data).toEqual({
      projectId: PROJECT,
      items: [
        { id: ITEM, actorId: PM },
        { id: ITEM_2, actorId: PM },
      ],
    });
    pm.received.events.length = 0;
    for (let n = 0; n <= LIVE_RESYNC_THRESHOLD; n++)
      hub.receive({
        k: 'item',
        p: PROJECT,
        u: PM,
        c: null,
        i: [{ id: `item-${n}`, f: facts() }],
      });
    await hub.settle();
    expect(changes(pm.received)).toEqual([
      { event: 'project-resync', data: { projectId: PROJECT } },
    ]);
  });

  it('sends links only when both ends are visible', async () => {
    const { hub, open } = build(everyone);
    const pm = open(PM);
    const viewer = open(BUCKETS);
    await hub.subscribe(pm.auth, pm.id, PROJECT);
    await hub.subscribe(viewer.auth, viewer.id, PROJECT);
    hub.receive({
      k: 'links',
      p: PROJECT,
      u: PM,
      c: null,
      i: [
        { id: ITEM, f: facts() },
        { id: ITEM_2, f: facts({ b: BUCKET_B }) },
      ],
    });
    await hub.settle();
    expect(changes(pm.received)).toEqual([
      { event: 'links-changed', data: { projectId: PROJECT, ids: [ITEM, ITEM_2] } },
    ]);
    expect(changes(viewer.received)).toEqual([]);
  });

  it('refreshes access on member changes and drops removed members', async () => {
    const accesses = new Map(everyone);
    const { hub, open } = build(accesses);
    const own = open(OWN);
    await hub.subscribe(own.auth, own.id, PROJECT);
    accesses.delete(OWN);
    hub.receive({ k: 'access', p: PROJECT });
    await hub.settle();
    hub.receive({ k: 'item', p: PROJECT, u: PM, c: null, i: [{ id: ITEM, f: facts({ c: OWN }) }] });
    await hub.settle();
    expect(changes(own.received)).toEqual([
      { event: 'access-changed', data: { projectId: PROJECT } },
    ]);
  });

  it('tells My work streams about their own items in other projects, if visible', async () => {
    const { hub, open } = build(everyone);
    const own = open(OWN);
    const buckets = open(BUCKETS);
    hub.receive({
      k: 'item',
      p: PROJECT,
      u: PM,
      c: null,
      i: [
        { id: ITEM, f: facts({ a: [OWN, BUCKETS], b: BUCKET_B }) },
        { id: ITEM_2, f: facts() },
      ],
    });
    await hub.settle();
    expect(changes(own.received)).toEqual([
      { event: 'item-changed', data: { projectId: PROJECT, items: [{ id: ITEM, actorId: PM }] } },
    ]);
    // Assigned, but bucket B is outside the BUCKETS scope.
    expect(changes(buckets.received)).toEqual([]);
  });

  it("follows another person's work, filtered by the viewer's own visibility (v1.4.0)", async () => {
    const { hub, open } = build(everyone);
    const viewer = open(BUCKETS);
    await hub.followWork(viewer.auth, viewer.id, TEAMS);
    hub.receive({
      k: 'item',
      p: PROJECT,
      u: PM,
      c: null,
      i: [
        // Theirs and in bucket A, which the viewer can see.
        { id: ITEM, f: facts({ a: [TEAMS] }) },
        // Theirs, but in bucket B, outside the viewer's scope.
        { id: ITEM_2, f: facts({ a: [TEAMS], b: BUCKET_B }) },
      ],
    });
    await hub.settle();
    expect(changes(viewer.received)).toEqual([
      { event: 'item-changed', data: { projectId: PROJECT, items: [{ id: ITEM, actorId: PM }] } },
    ]);
    // Following their own work again stops it.
    await hub.followWork(viewer.auth, viewer.id, null);
    hub.receive({
      k: 'item',
      p: PROJECT,
      u: PM,
      c: null,
      i: [{ id: ITEM, f: facts({ a: [TEAMS] }) }],
    });
    await hub.settle();
    expect(changes(viewer.received)).toHaveLength(1);
  });

  it('follows only people the caller may look up, and never their personal space (v1.4.0)', async () => {
    const { hub, open } = build(everyone);
    const own = open(OWN);
    const admin = open(ADMIN);
    await expect(hub.followWork(own.auth, own.id, STRANGER)).rejects.toMatchObject({ status: 404 });
    await expect(
      hub.followWork(own.auth, own.id, '19111111-1111-4111-8111-111111111111'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(hub.followWork(admin.auth, own.id, PM)).rejects.toMatchObject({ status: 404 });
    // Administrators may look anyone up, but get only their own projects' events.
    const adminAuth = { ...admin.auth, user: makeUser({ id: ADMIN, systemRole: 'ADMIN' }) };
    await expect(hub.followWork(adminAuth, admin.id, STRANGER)).resolves.toBeUndefined();
    await hub.followWork(adminAuth, admin.id, PM);
    await hub.followWork(own.auth, own.id, PM);
    hub.receive({ k: 'item', p: PERSONAL, u: PM, c: null, i: [{ id: ITEM, f: facts() }] });
    hub.receive({ k: 'item', p: PROJECT, u: PM, c: null, i: [{ id: ITEM, f: facts() }] });
    await hub.settle();
    // OWN sees only their own items; the PM's item and personal task stay out.
    expect(changes(own.received)).toEqual([]);
    expect(changes(admin.received)).toEqual([]);
  });

  it('sends notifications only to the recipient', async () => {
    const { hub, open } = build(everyone);
    const pm = open(PM);
    const own = open(OWN);
    hub.receive({ k: 'notify', users: [OWN] });
    await hub.settle();
    expect(changes(pm.received)).toEqual([]);
    expect(changes(own.received)).toEqual([{ event: 'notification', data: {} }]);
  });

  it('refuses projects the caller is not a member of, and other users’ streams', async () => {
    const { hub, open } = build(everyone);
    const admin = open(ADMIN);
    const pm = open(PM);
    await expect(hub.subscribe(admin.auth, admin.id, PROJECT)).rejects.toMatchObject({
      status: 404,
    });
    await expect(hub.subscribe(admin.auth, pm.id, null)).rejects.toMatchObject({ status: 404 });
    await expect(hub.subscribe(admin.auth, admin.id, PERSONAL)).rejects.toMatchObject({
      status: 404,
    });
    await expect(hub.subscribe(pm.auth, pm.id, PERSONAL)).resolves.toBeUndefined();
  });

  it('delivers personal-space events only to the owner', async () => {
    const { hub, open } = build(everyone);
    const pm = open(PM);
    await hub.subscribe(pm.auth, pm.id, PERSONAL);
    const other = open(OWN);
    hub.receive({ k: 'item', p: PERSONAL, u: PM, c: null, i: [{ id: ITEM, f: facts() }] });
    await hub.settle();
    expect(changes(pm.received).map((e) => e.event)).toEqual(['item-changed']);
    expect(changes(other.received)).toEqual([]);
  });

  it('closes the oldest stream beyond the per-user limit', () => {
    const { open } = build(everyone);
    const first = open(PM);
    for (let n = 1; n < LIVE_MAX_STREAMS_PER_USER; n++) open(PM);
    expect(first.received.ended).toBe(false);
    open(PM);
    expect(first.received.ended).toBe(true);
  });

  it('closes streams whose session ended, without touching it', async () => {
    const { hub, open, liveSessions } = build(everyone);
    const pm = open(PM);
    const own = open(OWN);
    liveSessions.delete(pm.sessionId);
    await hub.beat();
    expect(pm.received.ended).toBe(true);
    expect(own.received.ended).toBe(false);
    liveSessions.delete(own.sessionId);
    hub.receive({ k: 'session', users: [OWN] });
    await hub.settle();
    expect(own.received.ended).toBe(true);
  });

  it('ends every stream when an admin switches live updates off', async () => {
    const { hub, open, live } = build(everyone);
    const pm = open(PM);
    live.enabled = false;
    hub.receive({ k: 'setting' });
    await hub.settle();
    expect(changes(pm.received)).toEqual([{ event: 'disabled', data: {} }]);
    expect(pm.received.ended).toBe(true);
  });
});

describe('LiveHub presence', () => {
  afterEach(() => jest.useRealTimers());

  /**
   * Presence events a stream got.
   *
   * @param received The stream's events.
   * @returns The people lists, in order.
   */
  const presence = (received: Received) =>
    received.events
      .filter((e) => e.event === 'presence')
      .map((e) => (e.data as { people: unknown }).people);

  /**
   * Lets published presence loop back and timers run.
   *
   * @param ms Fake time to pass.
   */
  const pass = async (ms: number): Promise<void> => {
    for (let n = 0; n < 5; n++) await Promise.resolve();
    jest.advanceTimersByTime(ms);
    for (let n = 0; n < 5; n++) await Promise.resolve();
  };

  it('shows others after the delay, with the action, and filters items by visibility', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { hub, open } = build(everyone);
    const pm = open(PM);
    const viewer = open(BUCKETS);
    const own = open(OWN);
    await hub.subscribe(pm.auth, pm.id, PROJECT);
    await hub.subscribe(viewer.auth, viewer.id, PROJECT);
    await hub.subscribe(own.auth, own.id, PROJECT);
    await pass(PRESENCE_DELAY_MS + 100);
    // The PM edits the due date of an item in bucket B.
    await hub.reportPresence(pm.auth, pm.id, {
      itemId: ITEM_2,
      action: 'editing',
      field: 'dueDate',
    });
    await pass(100);
    expect(presence(own.received).at(-1)).toEqual(
      expect.arrayContaining([{ userId: PM, itemId: null, action: null, field: null, view: null }]),
    );
    await pass(PRESENCE_DELAY_MS + 100);
    // Bucket B: the BUCKETS viewer sees the PM only as on the project.
    expect(presence(viewer.received).at(-1)).toEqual([
      { userId: PM, itemId: null, action: null, field: null, view: null },
      { userId: OWN, itemId: null, action: null, field: null, view: null },
    ]);
    // OWN scope: the PM's item is not theirs, so it is hidden from them too.
    expect(presence(own.received).at(-1)).toEqual([
      { userId: PM, itemId: null, action: null, field: null, view: null },
      { userId: BUCKETS, itemId: null, action: null, field: null, view: null },
    ]);
    // The PM never sees themselves.
    expect(JSON.stringify(presence(pm.received))).not.toContain(PM);
  });

  it('names the item and field to viewers who can see it', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { hub, open } = build(everyone);
    const pm = open(PM);
    const viewer = open(BUCKETS);
    await hub.subscribe(pm.auth, pm.id, PROJECT);
    await hub.subscribe(viewer.auth, viewer.id, PROJECT);
    await hub.reportPresence(pm.auth, pm.id, { itemId: ITEM, action: 'editing', field: 'dueDate' });
    // Throttled behind the report made on subscribing, then delayed.
    await pass(1_000);
    await pass(PRESENCE_DELAY_MS + 100);
    expect(presence(viewer.received).at(-1)).toEqual([
      { userId: PM, itemId: ITEM, action: 'editing', field: 'dueDate', view: null },
    ]);
  });

  it('passes the page on, also to viewers who cannot see the item', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { hub, open } = build(everyone);
    const pm = open(PM);
    const viewer = open(BUCKETS);
    await hub.subscribe(pm.auth, pm.id, PROJECT);
    await hub.subscribe(viewer.auth, viewer.id, PROJECT);
    await hub.reportPresence(pm.auth, pm.id, {
      itemId: ITEM_2,
      action: 'viewing',
      field: null,
      view: 'timeline',
    });
    await pass(1_000);
    await pass(PRESENCE_DELAY_MS + 100);
    // Bucket B is hidden from this viewer: the page shows, the item does not.
    expect(presence(viewer.received).at(-1)).toEqual([
      { userId: PM, itemId: null, action: null, field: null, view: 'timeline' },
    ]);
  });

  it('removes presence when the stream closes', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { hub, open } = build(everyone);
    const pm = open(PM);
    const viewer = open(BUCKETS);
    await hub.subscribe(pm.auth, pm.id, PROJECT);
    await hub.subscribe(viewer.auth, viewer.id, PROJECT);
    await pass(PRESENCE_DELAY_MS + 100);
    expect(presence(viewer.received).at(-1)).toHaveLength(1);
    hub.close(pm.id);
    await pass(100);
    expect(presence(viewer.received).at(-1)).toEqual([]);
  });

  it('expires entries of other processes that stop confirming them', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { hub, open } = build(everyone);
    const viewer = open(BUCKETS);
    await hub.subscribe(viewer.auth, viewer.id, PROJECT);
    hub.receive({
      k: 'presence',
      s: 'remote',
      u: PM,
      p: PROJECT,
      i: null,
      f: null,
      a: null,
      fl: null,
    });
    await pass(PRESENCE_DELAY_MS + 100);
    expect(presence(viewer.received).at(-1)).toHaveLength(1);
    jest.setSystemTime(Date.now() + 61_000);
    await hub.beat();
    await pass(100);
    expect(presence(viewer.received).at(-1)).toEqual([]);
  });

  it('ignores a late join for a project the stream has left', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { hub, open } = build(everyone);
    const viewer = open(BUCKETS);
    const pm = open(PM);
    await hub.subscribe(viewer.auth, viewer.id, PROJECT);
    await hub.subscribe(pm.auth, pm.id, PERSONAL);
    // A join of the PM's stream for PROJECT arrives after it moved on.
    hub.receive({
      k: 'presence',
      s: pm.id,
      u: PM,
      p: PROJECT,
      i: null,
      f: null,
      a: null,
      fl: null,
    });
    await pass(PRESENCE_DELAY_MS + 100);
    expect(JSON.stringify(presence(viewer.received))).not.toContain(PM);
  });

  it('refuses presence on items the caller cannot see', async () => {
    const { hub, open } = build(everyone);
    const viewer = open(BUCKETS);
    await hub.subscribe(viewer.auth, viewer.id, PROJECT);
    await expect(
      hub.reportPresence(viewer.auth, viewer.id, {
        itemId: ITEM_2,
        action: 'viewing',
        field: null,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("lists rows moved together, each filtered by the viewer's visibility (v1.4.1)", async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { hub, open, sent } = build(everyone);
    const pm = open(PM);
    const buckets = open(BUCKETS);
    const own = open(OWN);
    await hub.subscribe(pm.auth, pm.id, PROJECT);
    await hub.subscribe(buckets.auth, buckets.id, PROJECT);
    await hub.subscribe(own.auth, own.id, PROJECT);
    // The PM drags three rows; the first is in bucket B.
    await hub.reportPresence(pm.auth, pm.id, {
      itemId: ITEM_2,
      action: 'moving',
      field: null,
      itemIds: [ITEM_2, ITEM, ITEM_3, ITEM],
      view: 'timeline',
    });
    await pass(1_000);
    await hub.settle();
    await pass(PRESENCE_DELAY_MS + 100);
    // Only ids travel on the channel; repeats and the first item are not listed again.
    const moving = sent.filter((m) => m.k === 'presence' && m.a === 'moving');
    expect(moving.at(-1)).toMatchObject({ i: ITEM_2, is: [ITEM, ITEM_3] });
    expect(JSON.stringify(moving.at(-1))).not.toContain('"fs"');
    // Bucket B is hidden: the first row they may see leads the list.
    expect(presence(buckets.received).at(-1)).toEqual([
      {
        userId: PM,
        itemId: ITEM,
        action: 'moving',
        field: null,
        view: 'timeline',
        itemIds: [ITEM, ITEM_3],
      },
      { userId: OWN, itemId: null, action: null, field: null, view: null },
    ]);
    expect(JSON.stringify(presence(buckets.received))).not.toContain(ITEM_2);
    // None of the rows is theirs: the PM shows as on the timeline only.
    expect(presence(own.received).at(-1)).toEqual(
      expect.arrayContaining([
        { userId: PM, itemId: null, action: null, field: null, view: 'timeline' },
      ]),
    );
    expect(JSON.stringify(presence(own.received))).not.toContain(ITEM);
  });

  it("hides a moved row once it leaves the viewer's scope (v1.4.1)", async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { hub, open, itemFacts } = build(everyone);
    const pm = open(PM);
    const buckets = open(BUCKETS);
    await hub.subscribe(pm.auth, pm.id, PROJECT);
    await hub.subscribe(buckets.auth, buckets.id, PROJECT);
    await hub.reportPresence(pm.auth, pm.id, {
      itemId: ITEM,
      action: 'moving',
      field: null,
      itemIds: [ITEM, ITEM_3],
    });
    await pass(1_000);
    await hub.settle();
    await pass(PRESENCE_DELAY_MS + 100);
    expect(presence(buckets.received).at(-1)).toEqual([
      expect.objectContaining({ itemId: ITEM, itemIds: [ITEM, ITEM_3] }),
    ]);
    // ITEM_3 moves to bucket B, out of this viewer's scope.
    itemFacts.set(ITEM_3, facts({ b: BUCKET_B }));
    hub.receive({
      k: 'item',
      p: PROJECT,
      u: PM,
      c: null,
      i: [{ id: ITEM_3, f: facts({ b: BUCKET_B }), b: facts() }],
    });
    await pass(100);
    await hub.settle();
    expect(presence(buckets.received).at(-1)).toEqual([
      expect.objectContaining({ itemId: ITEM, itemIds: [ITEM] }),
    ]);
  });

  it('refuses a moved list with an item the caller cannot see (v1.4.1)', async () => {
    const { hub, open, sent } = build(everyone);
    const viewer = open(BUCKETS);
    await hub.subscribe(viewer.auth, viewer.id, PROJECT);
    const before = sent.length;
    await expect(
      hub.reportPresence(viewer.auth, viewer.id, {
        itemId: ITEM,
        action: 'moving',
        field: null,
        itemIds: [ITEM, ITEM_2],
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(sent.slice(before).filter((m) => m.k === 'presence' && m.i !== null)).toEqual([]);
  });

  it('keeps no presence in personal spaces', async () => {
    const { hub, open, sent } = build(everyone);
    const pm = open(PM);
    await hub.subscribe(pm.auth, pm.id, PERSONAL);
    await hub.reportPresence(pm.auth, pm.id, {
      itemId: null,
      action: null,
      field: null,
      view: null,
    });
    expect(sent.filter((m) => m.k === 'presence')).toEqual([]);
  });
});
