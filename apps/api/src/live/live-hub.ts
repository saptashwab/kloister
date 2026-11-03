import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  LIVE_HEARTBEAT_MS,
  LIVE_MAX_STREAMS_PER_USER,
  LIVE_RESYNC_THRESHOLD,
  LiveEvent,
  type LiveItemDto,
  type LivePresenceRequest,
  type PresenceEntryDto,
  PRESENCE_DELAY_MS,
  PRESENCE_THROTTLE_MS,
  SystemRole,
} from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { SessionService } from '../auth/session.service.js';
import { notFound } from '../common/api-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type ProjectAccess,
  ProjectAccessService,
  parseProjectRef,
} from '../projects/project-access.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  fromWire,
  type LiveMessage,
  type PresenceMessage,
  sendLive,
  type WireFacts,
} from './live-events.js';
import { PgListener } from './pg-listener.js';

/** Where a stream writes; the controller wraps the HTTP response. */
export interface StreamSink {
  /**
   * Writes raw event-stream text.
   *
   * @param chunk The text.
   */
  write(chunk: string): void;
  /** Ends the response. */
  end(): void;
}

/** One open event stream (one browser tab). */
interface LiveStream {
  /** Stream id, sent in `hello`. */
  id: string;
  /** Owner. */
  userId: string;
  /** The session that opened it; checked at every heartbeat. */
  sessionId: string;
  /** The tab's client id, for skipping echoes. */
  clientId: string | null;
  /** Where events go. */
  sink: StreamSink;
  /** The followed project, or null. */
  projectId: string | null;
  /** The owner's access to that project, refreshed on access changes. */
  access: ProjectAccess | null;
  /** The last presence data sent, to send only changes. */
  lastPresence: string | null;
  /** When the last presence report was published, for throttling. */
  presenceAt: number;
  /** A throttled presence report waiting to be published. */
  presenceTimer?: ReturnType<typeof setTimeout>;
  /** Counts subscriptions, so only the latest one takes effect. */
  subscribeRun: number;
  /** The owner's access to other projects, for My work events; null for none. */
  workAccess: Map<string, ProjectAccess | null>;
  /** Another person whose work the tab lists ("all their work"), or null. */
  workUserId: string | null;
}

/** One person's presence through one stream, as known to this process. */
interface PresenceEntry {
  /** The message as last received. */
  message: PresenceMessage & { p: string };
  /** When the stream joined the project. */
  projectSince: number;
  /** When it opened the current item. */
  itemSince: number;
  /** When it last changed, to pick each person's most recent action. */
  updatedAt: number;
  /** When it was last confirmed, for expiry. */
  seenAt: number;
}

/** One change of an item: facts after and before, actor and acting tab. */
interface ItemChange {
  /** Facts after; null when gone. */
  f: WireFacts | null;
  /** Facts before, when given. */
  b?: WireFacts;
  /** Actor. */
  u: string | null;
  /** Acting tab. */
  c: string | null;
}

/** What one delivery burst changed in one project. */
interface ProjectBurst {
  /** Items, with every change in arrival order. */
  items: Map<string, ItemChange[]>;
  /** Changed links, each with its two ends. */
  links: { ends: { id: string; f: WireFacts | null }[]; c: string | null }[];
  /** Client ids behind board changes. */
  board: (string | null)[];
  /** Whether access may have changed. */
  access: boolean;
  /** Whether the whole project must be reloaded. */
  resync: boolean;
}

/** Presence entries not confirmed for this long are dropped (crashed API processes). */
const PRESENCE_TTL_MS = 60_000;

/** Delivery bursts are gathered for this long, so one transaction becomes one event. */
const BURST_MS = 50;

/** The listener closes this long after the last stream. */
const IDLE_LISTENER_MS = 30_000;

/**
 * The live update hub of one API process (M10 plan sections 5.1 to 5.6):
 * the registry of open streams, the fan-out of channel messages filtered
 * by each viewer's access, presence, heartbeats and session checks.
 *
 * Non-disclosure: an item event reaches a stream only when
 * `ProjectAccessService.canViewItem` passes for the item's facts with the
 * stream owner's current access; a link only when both ends pass. Streams
 * follow only projects their owner is a member of (personal spaces: the
 * owner), so administrators get nothing for projects they only visit.
 */
@Injectable()
export class LiveHub implements OnModuleDestroy {
  private readonly streams = new Map<string, LiveStream>();
  private readonly presence = new Map<string, PresenceEntry>();
  private queue: LiveMessage[] = [];
  private burstTimer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> = Promise.resolve();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly presenceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param access Visibility rules.
   * @param sessions Session checks.
   * @param settings The live switch.
   * @param listener The channel listener.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly sessions: SessionService,
    private readonly settings: SettingsService,
    private readonly listener: PgListener,
  ) {}

  /**
   * Number of open streams, for tests and diagnostics.
   *
   * @returns The count.
   */
  get size(): number {
    return this.streams.size;
  }

  /**
   * Registers a new stream and sends `hello`. Opening an eleventh stream for
   * one user closes their oldest.
   *
   * @param auth The signed-in caller.
   * @param clientId The tab's client id, if valid.
   * @param sink Where events go.
   * @returns The stream id.
   */
  open(auth: AuthContext, clientId: string | null, sink: StreamSink): string {
    const own = [...this.streams.values()].filter((s) => s.userId === auth.user.id);
    for (const old of own.slice(0, Math.max(0, own.length - LIVE_MAX_STREAMS_PER_USER + 1)))
      this.close(old.id);
    const stream: LiveStream = {
      id: randomUUID(),
      userId: auth.user.id,
      sessionId: auth.sessionId,
      clientId,
      sink,
      projectId: null,
      access: null,
      lastPresence: null,
      presenceAt: 0,
      workAccess: new Map(),
      workUserId: null,
      subscribeRun: 0,
    };
    this.streams.set(stream.id, stream);
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.listener.start({
      message: (message) => this.receive(message),
      ready: (after) => {
        if (after) for (const s of this.streams.values()) this.send(s, LiveEvent.RESYNC, {});
      },
    });
    this.startHeartbeat();
    sink.write(`retry: 5000\n\n`);
    this.send(stream, LiveEvent.HELLO, { streamId: stream.id });
    return stream.id;
  }

  /**
   * Forgets a stream and ends its response; its presence is withdrawn.
   *
   * @param streamId The stream.
   */
  close(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (stream === undefined) return;
    this.streams.delete(streamId);
    clearTimeout(stream.presenceTimer);
    if (stream.projectId !== null) this.publishPresence(stream, null);
    try {
      stream.sink.end();
    } catch {
      // Already closed by the client.
    }
    if (this.streams.size === 0) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (this.streams.size === 0) void this.listener.stop();
      }, IDLE_LISTENER_MS);
      this.idleTimer.unref?.();
    }
  }

  /**
   * Follows a project with a stream, or none (M10 plan section 5.1).
   *
   * Permissions: the stream must be the caller's own, and the caller must be
   * a member of the project (personal spaces: its owner); otherwise 404, as
   * for an unknown project. Administrators who are not members get 404 too,
   * so a cross-project visit is never live and writes no audit entry.
   *
   * @param auth The caller.
   * @param streamId The stream.
   * @param ref Project id or key, or null.
   * @returns Resolves once followed.
   */
  async subscribe(auth: AuthContext, streamId: string, ref: string | null): Promise<void> {
    const stream = this.ownStream(auth, streamId);
    const run = ++stream.subscribeRun;
    clearTimeout(stream.presenceTimer);
    let access: ProjectAccess | null = null;
    if (ref !== null) {
      const lookup = parseProjectRef(ref);
      const project =
        lookup === null
          ? null
          : await this.prisma.project.findUnique({ where: lookup, select: { id: true } });
      access = project === null ? null : await this.accessOf(auth.user.id, project.id);
      if (access === null) throw notFound('Project');
    }
    // A newer subscription of the same stream answered first and wins.
    if (!this.streams.has(stream.id) || run !== stream.subscribeRun) return;
    const previous = stream.projectId;
    if (previous !== null && previous !== access?.project.id) this.publishPresence(stream, null);
    stream.projectId = access?.project.id ?? null;
    stream.access = access;
    stream.lastPresence = null;
    if (access !== null && previous !== access.project.id) {
      this.publishPresence(stream, { itemId: null, action: null, field: null });
      this.schedulePresence(access.project.id);
    }
  }

  /**
   * Follows another person's work with a stream (v1.4.0): changes to items
   * they created or are assigned to reach it as for the owner's own work,
   * still filtered by the owner's member access and visibility, so nothing
   * arrives that the owner could not read. Null (or the owner) stops it.
   *
   * Permissions: the stream must be the caller's own; the person must be
   * one the caller may look up for "all their work": administrators anyone,
   * other users only people sharing an unarchived project with them (404
   * otherwise, as for an unknown person).
   *
   * @param auth The caller.
   * @param streamId The stream.
   * @param userId The person, or null.
   * @returns Resolves once followed.
   */
  async followWork(auth: AuthContext, streamId: string, userId: string | null): Promise<void> {
    const stream = this.ownStream(auth, streamId);
    // A refused request leaves the stream following nobody else.
    stream.workUserId = null;
    if (userId === null || userId === auth.user.id) return;
    const person = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (person === null) throw notFound('User');
    if (auth.user.systemRole !== SystemRole.ADMIN) {
      const projects = (await this.access.memberAccesses(auth)).map((a) => a.project.id);
      const shared = await this.prisma.projectMember.count({
        where: { userId, projectId: { in: projects } },
      });
      if (shared === 0) throw notFound('User');
    }
    // The stream may have closed while the person was looked up.
    if (this.streams.has(stream.id)) stream.workUserId = person.id;
  }

  /**
   * Reports what the caller's tab is doing on the followed project (M10 plan
   * section 5.5). Kept in memory only; throttled to once a second.
   *
   * Permissions: own stream only, following a project; the item must be
   * visible to the caller (404 otherwise). Personal spaces have no presence.
   *
   * @param auth The caller.
   * @param streamId The stream.
   * @param body Item, action and field.
   * @returns Resolves once accepted.
   */
  async reportPresence(
    auth: AuthContext,
    streamId: string,
    body: LivePresenceRequest,
  ): Promise<void> {
    const stream = this.ownStream(auth, streamId);
    const access = stream.access;
    if (access === null) throw notFound('Item');
    if (body.itemId !== null) {
      const row = await this.prisma.workItem.findFirst({
        where: { id: body.itemId, projectId: access.project.id, deletedAt: null },
        select: {
          createdById: true,
          bucketId: true,
          teamId: true,
          assignees: { select: { userId: true } },
        },
      });
      const facts =
        row === null
          ? null
          : {
              createdById: row.createdById,
              assigneeIds: row.assignees.map((a) => a.userId),
              bucketId: row.bucketId,
              teamId: row.teamId,
              hasChildren: false,
            };
      if (facts === null || !this.access.canViewItem(access, facts)) throw notFound('Item');
    }
    if (access.project.ownerId !== null || stream.access !== access) return;
    const wait = stream.presenceAt + PRESENCE_THROTTLE_MS - Date.now();
    clearTimeout(stream.presenceTimer);
    if (wait <= 0) this.publishPresence(stream, body);
    else {
      stream.presenceTimer = setTimeout(() => this.publishPresence(stream, body), wait);
      stream.presenceTimer.unref?.();
    }
  }

  /**
   * Handles a channel message; bursts are gathered briefly so one
   * transaction's messages become one event per stream.
   *
   * @param message The message.
   */
  receive(message: LiveMessage): void {
    if (message.k === 'presence') {
      this.receivePresence(message);
      return;
    }
    this.queue.push(message);
    if (this.burstTimer !== undefined) return;
    this.burstTimer = setTimeout(() => {
      this.burstTimer = undefined;
      const batch = this.queue;
      this.queue = [];
      this.flushing = this.flushing.then(() => this.deliver(batch)).catch(() => undefined);
    }, BURST_MS);
  }

  /**
   * Waits until every received message is delivered (tests).
   *
   * @returns Resolves once idle.
   */
  async settle(): Promise<void> {
    while (this.burstTimer !== undefined || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, BURST_MS));
    }
    await this.flushing;
  }

  /**
   * Sends heartbeats, checks sessions and refreshes presence (M10 plan
   * sections 5.1, 5.6). The stream never touches the session, so it never
   * extends it; an ended session closes its streams.
   *
   * @returns Resolves once checked.
   */
  async beat(): Promise<void> {
    for (const stream of this.streams.values()) this.write(stream, `: heartbeat\n\n`);
    await this.checkSessions([...this.streams.values()]);
    const now = Date.now();
    for (const [id, entry] of this.presence) {
      const local = this.streams.get(id);
      if (local !== undefined && local.projectId !== entry.message.p) {
        // A late join for a project the stream has left.
        this.presence.delete(id);
        this.schedulePresence(entry.message.p);
      } else if (local !== undefined) {
        entry.seenAt = now;
        // Other API processes keep entries of this one alive.
        void sendLive(this.prisma, entry.message).catch(() => undefined);
      } else if (now - entry.seenAt > PRESENCE_TTL_MS) {
        this.presence.delete(id);
        this.schedulePresence(entry.message.p);
      }
    }
  }

  /** Stops timers and ends every stream on shutdown. */
  onModuleDestroy(): void {
    for (const id of [...this.streams.keys()]) this.close(id);
    clearInterval(this.heartbeat);
    clearTimeout(this.burstTimer);
    clearTimeout(this.idleTimer);
    for (const timer of this.presenceTimers.values()) clearTimeout(timer);
  }

  /**
   * Finds the caller's own stream.
   *
   * @param auth The caller.
   * @param streamId The stream.
   * @returns The stream; 404 for unknown streams and other users' streams.
   */
  private ownStream(auth: AuthContext, streamId: string): LiveStream {
    const stream = this.streams.get(streamId);
    if (stream === undefined || stream.userId !== auth.user.id) throw notFound('Stream');
    return stream;
  }

  /**
   * The member access a stream owner has to a project, without the admin
   * exception (no audit entry, no cross-project access).
   *
   * @param userId The owner.
   * @param projectId The project.
   * @returns The access, or null for non-members and inactive accounts.
   */
  private async accessOf(userId: string, projectId: string): Promise<ProjectAccess | null> {
    const accesses = await this.access.accessesOf(this.prisma, projectId, [userId]);
    return accesses.get(userId) ?? null;
  }

  /** Starts the heartbeat while streams are open. */
  private startHeartbeat(): void {
    if (this.heartbeat !== undefined) return;
    this.heartbeat = setInterval(() => void this.beat().catch(() => undefined), LIVE_HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  /**
   * Closes streams whose sessions ended or expired, without touching them.
   *
   * @param streams Streams to check.
   * @returns Resolves once checked.
   */
  private async checkSessions(streams: LiveStream[]): Promise<void> {
    if (streams.length === 0) return;
    const live = await this.sessions.liveSessionIds([...new Set(streams.map((s) => s.sessionId))]);
    for (const stream of streams) if (!live.has(stream.sessionId)) this.close(stream.id);
  }

  /**
   * Writes text to a stream, closing it when the connection is gone.
   *
   * @param stream The stream.
   * @param chunk The text.
   */
  private write(stream: LiveStream, chunk: string): void {
    try {
      stream.sink.write(chunk);
    } catch {
      this.close(stream.id);
    }
  }

  /**
   * Sends one event.
   *
   * @param stream The stream.
   * @param event Event name.
   * @param data Event data.
   */
  private send(stream: LiveStream, event: LiveEvent, data: object): void {
    this.write(stream, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /**
   * Delivers one burst of channel messages.
   *
   * @param batch The messages, in commit order.
   * @returns Resolves once delivered.
   */
  private async deliver(batch: LiveMessage[]): Promise<void> {
    const projects = new Map<string, ProjectBurst>();
    const burst = (projectId: string): ProjectBurst => {
      let entry = projects.get(projectId);
      if (entry === undefined) {
        entry = { items: new Map(), links: [], board: [], access: false, resync: false };
        projects.set(projectId, entry);
      }
      return entry;
    };
    const instanceBoard: (string | null)[] = [];
    const sessionUsers = new Set<string>();
    let setting = false;
    for (const message of batch) {
      switch (message.k) {
        case 'item':
          for (const item of message.i) {
            const changes = burst(message.p).items.get(item.id) ?? [];
            changes.push({ f: item.f, b: item.b, u: message.u, c: message.c });
            burst(message.p).items.set(item.id, changes);
          }
          break;
        case 'links':
          burst(message.p).links.push({ ends: message.i, c: message.c });
          break;
        case 'board':
          if (message.p === null) instanceBoard.push(message.c);
          else burst(message.p).board.push(message.c);
          break;
        case 'access':
          burst(message.p).access = true;
          break;
        case 'resync':
          burst(message.p).resync = true;
          break;
        case 'notify':
          for (const stream of this.streams.values())
            if (message.users.includes(stream.userId))
              this.send(stream, LiveEvent.NOTIFICATION, {});
          break;
        case 'session':
          for (const user of message.users) sessionUsers.add(user);
          break;
        case 'setting':
          setting = true;
          break;
        case 'presence':
          break;
      }
    }
    if (setting && !(await this.settings.getLive()).enabled) {
      for (const stream of [...this.streams.values()]) {
        this.send(stream, LiveEvent.DISABLED, {});
        this.close(stream.id);
      }
      return;
    }
    for (const [projectId, changes] of projects) await this.deliverProject(projectId, changes);
    if (instanceBoard.length > 0)
      for (const stream of this.streams.values())
        if (
          stream.projectId !== null &&
          instanceBoard.some((c) => c === null || c !== stream.clientId)
        )
          this.send(stream, LiveEvent.BOARD_CHANGED, { projectId: stream.projectId });
    if (sessionUsers.size > 0)
      await this.checkSessions(
        [...this.streams.values()].filter((s) => sessionUsers.has(s.userId)),
      );
  }

  /**
   * Delivers one project's changes to the streams following it.
   *
   * @param projectId The project.
   * @param changes What changed.
   * @returns Resolves once delivered.
   */
  private async deliverProject(projectId: string, changes: ProjectBurst): Promise<void> {
    const followers = () => [...this.streams.values()].filter((s) => s.projectId === projectId);
    if (changes.access) {
      for (const stream of this.streams.values()) stream.workAccess.delete(projectId);
      await this.refreshAccess(projectId, followers());
    }
    await this.deliverWork(projectId, changes);
    this.updatePresenceFacts(projectId, changes);
    const resync = changes.resync || changes.items.size > LIVE_RESYNC_THRESHOLD;
    for (const stream of followers()) {
      const access = stream.access;
      if (access === null) continue;
      if (resync) {
        this.send(stream, LiveEvent.PROJECT_RESYNC, { projectId });
        continue;
      }
      if (changes.access) this.send(stream, LiveEvent.ACCESS_CHANGED, { projectId });
      else if (changes.board.some((c) => c === null || c !== stream.clientId))
        this.send(stream, LiveEvent.BOARD_CHANGED, { projectId });
      const { changed, removed } = this.itemsFor(stream, access, changes);
      if (changed.length > 0)
        this.send(stream, LiveEvent.ITEM_CHANGED, { projectId, items: changed });
      if (removed.length > 0)
        this.send(stream, LiveEvent.ITEM_REMOVED, { projectId, items: removed });
      const ids = new Set<string>();
      for (const link of changes.links) {
        if (link.c !== null && link.c === stream.clientId) continue;
        const visible = link.ends.every(
          (end) => end.f !== null && this.access.canViewItem(access, fromWire(end.f)),
        );
        if (visible) for (const end of link.ends) ids.add(end.id);
      }
      if (ids.size > 0) this.send(stream, LiveEvent.LINKS_CHANGED, { projectId, ids: [...ids] });
    }
  }

  /**
   * Tells streams that follow another project (My work, all their work)
   * about changes to items their owner, or the person whose work they follow
   * (v1.4.0), created or is assigned to, with the same visibility check as
   * for followers, using the owner's access (M10 plan section 3).
   *
   * @param projectId The project.
   * @param changes Its changes.
   * @returns Resolves once delivered.
   */
  private async deliverWork(projectId: string, changes: ProjectBurst): Promise<void> {
    if (changes.items.size === 0) return;
    const involves = (list: ItemChange[], user: string): boolean =>
      list.some((change) =>
        [change.f, change.b].some((f) => !!f && (f.c === user || f.a.includes(user))),
      );
    for (const stream of this.streams.values()) {
      if (stream.projectId === projectId) continue;
      const person = stream.workUserId;
      const own = new Map(
        [...changes.items].filter(
          ([, list]) =>
            involves(list, stream.userId) || (person !== null && involves(list, person)),
        ),
      );
      if (own.size === 0) continue;
      if (!stream.workAccess.has(projectId))
        stream.workAccess.set(projectId, await this.accessOf(stream.userId, projectId));
      const access = stream.workAccess.get(projectId) ?? null;
      if (access === null || !this.streams.has(stream.id)) continue;
      const { changed, removed } = this.itemsFor(stream, access, { ...changes, items: own });
      if (changed.length > 0)
        this.send(stream, LiveEvent.ITEM_CHANGED, { projectId, items: changed });
      if (removed.length > 0)
        this.send(stream, LiveEvent.ITEM_REMOVED, { projectId, items: removed });
    }
  }

  /**
   * Decides which changed items one stream hears about, and how.
   *
   * @param stream The stream.
   * @param access Its owner's access.
   * @param changes The project's changes.
   * @returns Visible changes, and items that were visible and no longer are.
   */
  private itemsFor(
    stream: LiveStream,
    access: ProjectAccess,
    changes: ProjectBurst,
  ): { changed: LiveItemDto[]; removed: LiveItemDto[] } {
    const changed: LiveItemDto[] = [];
    const removed: LiveItemDto[] = [];
    const sees = (facts: WireFacts | null | undefined): boolean =>
      facts !== null && facts !== undefined && this.access.canViewItem(access, fromWire(facts));
    for (const [id, list] of changes.items) {
      const others = list.filter((c) => c.c === null || c.c !== stream.clientId);
      if (others.length === 0) continue;
      const first = list[0];
      const last = list[list.length - 1];
      const actorId = others[others.length - 1].u;
      const after = last.f;
      const before = list.find((c) => c.b !== undefined)?.b ?? first.f;
      if (sees(after)) changed.push({ id, actorId });
      else if (sees(before)) removed.push({ id, actorId, deleted: after === null });
    }
    return { changed, removed };
  }

  /**
   * Re-resolves the access of a project's followers; those who lost it stop
   * following and are told to reload (they see "project not found").
   *
   * @param projectId The project.
   * @param followers Its followers.
   * @returns Resolves once refreshed.
   */
  private async refreshAccess(projectId: string, followers: LiveStream[]): Promise<void> {
    if (followers.length === 0) return;
    const users = [...new Set(followers.map((s) => s.userId))];
    const accesses = await this.access.accessesOf(this.prisma, projectId, users);
    for (const stream of followers) {
      const access = accesses.get(stream.userId) ?? null;
      stream.access = access;
      stream.lastPresence = null;
      if (access === null) {
        this.send(stream, LiveEvent.ACCESS_CHANGED, { projectId });
        this.publishPresence(stream, null);
        stream.projectId = null;
      }
    }
    this.schedulePresence(projectId);
  }

  /**
   * Publishes a stream's presence on the channel, so every API process
   * (this one included) updates its map.
   *
   * @param stream The stream.
   * @param body What it does, or null when it left the project.
   */
  private publishPresence(stream: LiveStream, body: LivePresenceRequest | null): void {
    stream.presenceAt = Date.now();
    const projectId = stream.projectId;
    if (projectId === null) return;
    const base = { k: 'presence', s: stream.id, u: stream.userId } as const;
    if (body === null) {
      this.dropPresence(stream.id);
      const leave: PresenceMessage = { ...base, p: null, i: null, f: null, a: null, fl: null };
      void sendLive(this.prisma, leave).catch(() => undefined);
      return;
    }
    // Personal spaces have no presence; neither has a stream without access.
    if (stream.access === null || stream.access.project.ownerId !== null) return;
    const message: PresenceMessage = {
      ...base,
      p: projectId,
      i: body.itemId,
      f: null,
      a: body.itemId === null ? null : body.action,
      fl: body.itemId === null || body.action !== 'editing' ? null : body.field,
    };
    void this.withFacts(message)
      .then((m) => sendLive(this.prisma, m))
      .catch(() => undefined);
  }

  /**
   * Adds the item's facts to a presence message.
   *
   * @param message The message.
   * @returns The message with facts, or without an item when it is gone.
   */
  private async withFacts(message: PresenceMessage): Promise<PresenceMessage> {
    if (message.i === null) return message;
    const row = await this.prisma.workItem.findFirst({
      where: { id: message.i, projectId: message.p ?? undefined, deletedAt: null },
      select: {
        createdById: true,
        bucketId: true,
        teamId: true,
        assignees: { select: { userId: true } },
      },
    });
    return row === null
      ? { ...message, i: null, a: null, fl: null }
      : {
          ...message,
          f: {
            c: row.createdById,
            a: row.assignees.map((a) => a.userId),
            b: row.bucketId,
            t: row.teamId,
          },
        };
  }

  /**
   * Removes a stream's presence entry at once (a local leave).
   *
   * @param streamId The stream.
   */
  private dropPresence(streamId: string): void {
    const entry = this.presence.get(streamId);
    if (entry === undefined) return;
    this.presence.delete(streamId);
    this.schedulePresence(entry.message.p);
  }

  /**
   * Updates the presence map from a channel message.
   *
   * @param message The message.
   */
  private receivePresence(message: PresenceMessage): void {
    // Joins and leaves of one stream may arrive out of order; a local stream
    // knows which project it follows now.
    const local = this.streams.get(message.s);
    if (local !== undefined && message.p !== null && local.projectId !== message.p) return;
    if (local !== undefined && message.p === null && local.projectId !== null) {
      const known = this.presence.get(message.s);
      if (known !== undefined && known.message.p === local.projectId) return;
    }
    const existing = this.presence.get(message.s);
    if (message.p === null) {
      this.presence.delete(message.s);
      if (existing !== undefined) this.schedulePresence(existing.message.p);
      return;
    }
    const now = Date.now();
    const sameProject = existing?.message.p === message.p;
    const sameItem = sameProject && existing?.message.i === message.i;
    const changed =
      !sameItem || existing?.message.a !== message.a || existing.message.fl !== message.fl;
    this.presence.set(message.s, {
      message: { ...message, p: message.p },
      projectSince: sameProject ? existing.projectSince : now,
      itemSince: sameItem ? existing.itemSince : now,
      updatedAt: changed || existing === undefined ? now : existing.updatedAt,
      seenAt: now,
    });
    if (existing !== undefined && !sameProject) this.schedulePresence(existing.message.p);
    if (changed) this.schedulePresence(message.p);
  }

  /**
   * Keeps presence entries in step with item changes, so presence never
   * names an item to someone who can no longer see it.
   *
   * @param projectId The project.
   * @param changes Its changes.
   */
  private updatePresenceFacts(projectId: string, changes: ProjectBurst): void {
    let touched = false;
    for (const entry of this.presence.values()) {
      const id = entry.message.i;
      if (entry.message.p !== projectId || id === null) continue;
      const list = changes.items.get(id);
      if (list === undefined) continue;
      const after = list[list.length - 1].f;
      entry.message =
        after === null
          ? { ...entry.message, i: null, f: null, a: null, fl: null }
          : { ...entry.message, f: after };
      touched = true;
    }
    if (touched) this.schedulePresence(projectId);
  }

  /**
   * Sends presence for a project now and again once the newest entries are
   * past the two-second delay.
   *
   * @param projectId The project.
   */
  private schedulePresence(projectId: string): void {
    this.sendPresence(projectId);
    clearTimeout(this.presenceTimers.get(projectId));
    const timer = setTimeout(() => {
      this.presenceTimers.delete(projectId);
      this.sendPresence(projectId);
    }, PRESENCE_DELAY_MS + 50);
    timer.unref?.();
    this.presenceTimers.set(projectId, timer);
  }

  /**
   * Sends each follower of a project everyone else on it, as that follower
   * may see them: items they cannot see are left out (the person shows as
   * on the project only). Only changes are sent.
   *
   * @param projectId The project.
   */
  private sendPresence(projectId: string): void {
    const now = Date.now();
    const entries = [...this.presence.values()].filter(
      (e) => e.message.p === projectId && now - e.projectSince >= PRESENCE_DELAY_MS,
    );
    for (const stream of this.streams.values()) {
      const access = stream.access;
      if (stream.projectId !== projectId || access === null || access.project.ownerId !== null)
        continue;
      const latest = new Map<string, PresenceEntry>();
      for (const entry of entries) {
        if (entry.message.u === stream.userId) continue;
        const known = latest.get(entry.message.u);
        if (known === undefined || entry.updatedAt > known.updatedAt)
          latest.set(entry.message.u, entry);
      }
      const people: PresenceEntryDto[] = [...latest.values()]
        .map((entry) => {
          const m = entry.message;
          const visible =
            m.i !== null &&
            m.f !== null &&
            now - entry.itemSince >= PRESENCE_DELAY_MS &&
            this.access.canViewItem(access, fromWire(m.f));
          return visible
            ? { userId: m.u, itemId: m.i, action: m.a, field: m.fl }
            : { userId: m.u, itemId: null, action: null, field: null };
        })
        .sort((a, b) => a.userId.localeCompare(b.userId));
      const text = JSON.stringify(people);
      if (text === stream.lastPresence) continue;
      stream.lastPresence = text;
      this.send(stream, LiveEvent.PRESENCE, { projectId, people });
    }
  }
}
