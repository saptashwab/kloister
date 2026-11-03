import { jest } from '@jest/globals';
import { AuditAction } from '@kloister/shared';
import type { DbClient } from '../audit/audit.service.js';
import {
  AUDIT_LIVE_KIND,
  auditMessage,
  LIVE_CHANNEL,
  type LiveMessage,
  fitPresence,
  payloadOf,
  publishNotifications,
} from './live-events.js';
import { type ListenClient, ListenClientFactory, PgListener } from './pg-listener.js';

const PROJECT = '33333333-3333-4333-8333-333333333333';
const ITEM = '77777777-7777-4777-8777-777777777777';
const OTHER = '78777777-7777-4777-8777-777777777777';
const USER = '11111111-1111-4111-8111-111111111111';

/**
 * A client whose item lookups answer from a table.
 *
 * @param rows Items by id.
 * @returns The client and what it sent.
 */
function db(
  rows: Record<string, { createdById: string; bucketId: string | null; teamId: string | null }>,
) {
  const sent: string[] = [];
  const client = {
    workItem: {
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.flatMap((id) =>
            rows[id] ? [{ id, ...rows[id], deletedAt: null, assignees: [{ userId: USER }] }] : [],
          ),
        ),
    },
    $executeRaw: (_sql: TemplateStringsArray, channel: string, payload: string) => {
      expect(channel).toBe(LIVE_CHANNEL);
      sent.push(payload);
      return Promise.resolve(1);
    },
  } as unknown as DbClient;
  return { client, sent };
}

describe('live event mapping', () => {
  it('maps every audited action or marks it as not live', () => {
    for (const action of Object.values(AuditAction)) expect(AUDIT_LIVE_KIND).toHaveProperty(action);
    // Sign-in, admin, backups, visits and exports are never live.
    for (const action of [
      AuditAction.LOGIN_SUCCEEDED,
      AuditAction.ADMIN_CROSS_PROJECT_ACCESS,
      AuditAction.BACKUP_SUCCEEDED,
      AuditAction.BRANDING_FILE_UPLOADED,
      AuditAction.ADO_PREPARED,
    ])
      expect(AUDIT_LIVE_KIND[action]).toBeNull();
  });

  it('carries ids and visibility facts only, before and after a move', async () => {
    const { client } = db({ [ITEM]: { createdById: USER, bucketId: 'b2', teamId: null } });
    const message = await auditMessage(
      client,
      {
        actorId: USER,
        action: AuditAction.ITEM_MOVED,
        entityType: 'WorkItem',
        entityId: ITEM,
        projectId: PROJECT,
        meta: { number: 4, from: 'b1', to: 'b2' },
        live: {
          before: {
            createdById: USER,
            assigneeIds: [],
            bucketId: 'b1',
            teamId: null,
            hasChildren: false,
          },
        },
      },
      'tab-aaaaaaaa',
    );
    expect(message).toEqual({
      k: 'item',
      p: PROJECT,
      u: USER,
      c: 'tab-aaaaaaaa',
      i: [
        {
          id: ITEM,
          f: { c: USER, a: [USER], b: 'b2', t: null },
          b: { c: USER, a: [], b: 'b1', t: null },
        },
      ],
    });
    expect(JSON.stringify(message)).not.toContain('number');
  });

  it('marks deleted items with null facts and resyncs cascades', async () => {
    const { client } = db({});
    const deleted = await auditMessage(
      client,
      {
        actorId: USER,
        action: AuditAction.ITEM_DELETED,
        entityType: 'WorkItem',
        entityId: ITEM,
        projectId: PROJECT,
      },
      null,
    );
    expect(deleted).toMatchObject({ k: 'item', i: [{ id: ITEM, f: null }] });
    const cascade = await auditMessage(
      client,
      {
        actorId: USER,
        action: AuditAction.ITEM_DELETED,
        entityType: 'WorkItem',
        entityId: ITEM,
        projectId: PROJECT,
        meta: { cascade: true, descendants: 3 },
      },
      null,
    );
    expect(cascade).toEqual({ k: 'resync', p: PROJECT });
  });

  it('names both ends of a dependency', async () => {
    const row = { createdById: USER, bucketId: null, teamId: null };
    const { client } = db({ [ITEM]: row, [OTHER]: row });
    const message = await auditMessage(
      client,
      {
        actorId: USER,
        action: AuditAction.DEPENDENCY_ADDED,
        entityType: 'WorkItem',
        entityId: ITEM,
        projectId: PROJECT,
        meta: { blockingItemId: OTHER },
      },
      null,
    );
    expect(message).toMatchObject({ k: 'links', i: [{ id: ITEM }, { id: OTHER }] });
  });

  it('announces only the live switch among settings, and session ends by user', async () => {
    const { client } = db({});
    const base = { actorId: USER, action: AuditAction.SETTINGS_UPDATED, entityType: 'AppSetting' };
    expect(await auditMessage(client, { ...base, meta: { key: 'theme' } }, null)).toBeNull();
    expect(await auditMessage(client, { ...base, meta: { key: 'live' } }, null)).toEqual({
      k: 'setting',
    });
    expect(
      await auditMessage(
        client,
        {
          actorId: 'admin',
          action: AuditAction.PASSWORD_RESET,
          entityType: 'User',
          entityId: USER,
        },
        null,
      ),
    ).toEqual({ k: 'session', users: ['admin', USER] });
  });

  it('falls back to a project resync for oversized payloads', () => {
    const big: LiveMessage = {
      k: 'item',
      p: PROJECT,
      u: USER,
      c: null,
      i: Array.from({ length: 200 }, (_, n) => ({ id: `${ITEM}-${n}`, f: null })),
    };
    expect(payloadOf(big)).toBe(JSON.stringify({ k: 'resync', p: PROJECT }));
  });

  it('sends notification recipients in small chunks', async () => {
    const { client, sent } = db({});
    await publishNotifications(
      client,
      Array.from({ length: 250 }, (_, n) => `user-${n}`),
    );
    expect(sent).toHaveLength(3);
    expect((JSON.parse(sent[0]) as { users: string[] }).users).toHaveLength(100);
  });
});

describe('PgListener', () => {
  afterEach(() => jest.useRealTimers());

  /**
   * A fake connection that can fail on connect.
   *
   * @param fail Whether connecting fails.
   * @returns The fake and its handlers.
   */
  function client(fail: boolean) {
    const handlers: Record<string, (arg?: unknown) => void> = {};
    const queries: string[] = [];
    const fake: ListenClient = {
      connect: () => (fail ? Promise.reject(new Error('refused')) : Promise.resolve()),
      query: (sql: string) => {
        queries.push(sql);
        return Promise.resolve();
      },
      end: () => Promise.resolve(),
      on: ((event: string, listener: (arg?: unknown) => void) => {
        handlers[event] = listener;
      }) as ListenClient['on'],
    };
    return { fake, handlers, queries };
  }

  it('listens, delivers messages and reports a reconnect after a failure', async () => {
    jest.useFakeTimers();
    const clients = [client(true), client(false)];
    let next = 0;
    const factory: ListenClientFactory = { create: () => clients[next++].fake };
    const listener = new PgListener(factory);
    const ready: boolean[] = [];
    const messages: LiveMessage[] = [];
    listener.start({ message: (m) => messages.push(m), ready: (after) => ready.push(after) });
    for (let n = 0; n < 5; n++) await Promise.resolve();
    expect(listener.listening).toBe(false);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(listener.listening).toBe(true);
    expect(clients[1].queries).toEqual([`LISTEN ${LIVE_CHANNEL}`]);
    expect(ready).toEqual([true]);
    clients[1].handlers['notification']({ channel: LIVE_CHANNEL, payload: '{"k":"setting"}' });
    clients[1].handlers['notification']({ channel: LIVE_CHANNEL, payload: 'not json' });
    expect(messages).toEqual([{ k: 'setting' }]);
    await listener.stop();
    expect(listener.listening).toBe(false);
  });
});

describe('presence payloads (v1.4.1)', () => {
  const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const message = (assignees: number, moved: number) => ({
    k: 'presence' as const,
    s: 'stream',
    u: uuid(0),
    p: uuid(1),
    i: uuid(2),
    f: {
      c: uuid(3),
      a: Array.from({ length: assignees }, (_v, n) => uuid(100 + n)),
      b: null,
      t: null,
    },
    a: 'moving' as const,
    fl: null,
    v: 'timeline' as const,
    is: Array.from({ length: moved }, (_v, n) => uuid(1000 + n)),
  });

  it('keeps a full list of moved rows within the limit', () => {
    const full = message(3, 99);
    expect(fitPresence(full)).toBe(full);
    expect(payloadOf(full)).not.toBeNull();
  });

  it('trims the moved rows to fit, and never turns presence into a resync', () => {
    const big = message(120, 99);
    const fitted = fitPresence(big);
    expect(fitted.i).toBe(big.i);
    expect(fitted.is!.length).toBeLessThan(99);
    expect(payloadOf(fitted)).not.toBeNull();
    const huge = { ...message(300, 0), is: undefined };
    expect(payloadOf(huge)).toBeNull();
  });
});
