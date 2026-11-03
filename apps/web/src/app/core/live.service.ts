import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable, NgZone, signal } from '@angular/core';
import {
  LiveEvent,
  type LiveHelloDto,
  type LivePresenceRequest,
  type LiveStatusDto,
  PRESENCE_THROTTLE_MS,
} from '@kloister/shared';
import { firstValueFrom, Subject } from 'rxjs';
import { apiUrl, CLIENT_ID } from './api';
import { NotificationsStore } from './notifications.store';

/**
 * Connection state of live updates (M10 plan section 4.4): `off` when
 * switched off by an admin (or before sign-in), `connecting` at first,
 * `live` while the stream is open, `reconnecting` after a few seconds
 * without it and `offline` after a minute.
 */
export type LiveStatus = 'off' | 'connecting' | 'live' | 'reconnecting' | 'offline';

/** One event from the stream. */
export interface LiveMessageEvent {
  /** Event name. */
  name: LiveEvent;
  /** Its data. */
  data: Record<string, unknown>;
}

/** Events forwarded to listeners; hello and disabled are handled here. */
const FORWARDED: readonly LiveEvent[] = [
  LiveEvent.ITEM_CHANGED,
  LiveEvent.ITEM_REMOVED,
  LiveEvent.LINKS_CHANGED,
  LiveEvent.BOARD_CHANGED,
  LiveEvent.ACCESS_CHANGED,
  LiveEvent.PRESENCE,
  LiveEvent.PROJECT_RESYNC,
  LiveEvent.RESYNC,
];

/** Waits before opening a new stream after one failed, by attempt. */
const RETRY_MS = [2_000, 5_000, 10_000, 30_000];

/** How long without a stream before "Reconnecting…" shows. */
export const RECONNECTING_AFTER_MS = 4_000;

/** How long without a stream before "Offline" shows. */
export const OFFLINE_AFTER_MS = 60_000;

/** The report of a tab on no item. */
const SAME_PRESENCE = JSON.stringify({ itemId: null, action: null, field: null });

/**
 * The tab's live updates stream (M10 plan section 5.4): one `EventSource`
 * per tab, opened after sign-in when an admin has not switched live updates
 * off. It follows the open project, reports presence, keeps the connection
 * status for the header chip and hands events to the project store and the
 * notification count. Loaded lazily after sign-in, so the first page stays
 * small.
 *
 * Nothing here decides access: the API filters every event by the viewer's
 * visibility, and changed items are refetched through the scoped API.
 */
@Injectable({ providedIn: 'root' })
export class LiveService {
  private readonly http = inject(HttpClient);
  private readonly zone = inject(NgZone);
  private readonly notifications = inject(NotificationsStore);

  /** The connection status. */
  readonly status = signal<LiveStatus>('off');
  /** Events for listeners (project store, My work). */
  readonly events = new Subject<LiveMessageEvent>();
  /** Bumped when a notification arrives, for the open Notifications list. */
  readonly notificationArrived = signal(0);
  /** A stream opened; `again` is true when an earlier one was lost, so data may be stale. */
  readonly connected = new Subject<{ again: boolean }>();

  private source: EventSource | null = null;
  private streamId: string | null = null;
  private started = false;
  private everConnected = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectingTimer: ReturnType<typeof setTimeout> | undefined;
  private offlineTimer: ReturnType<typeof setTimeout> | undefined;
  private projectId: string | null = null;
  /** The project the API confirmed this stream follows; presence waits for it. */
  private followed: string | null = null;
  private presence: LivePresenceRequest = { itemId: null, action: null, field: null };
  private presenceSent = SAME_PRESENCE;
  private presenceAt = 0;
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;
  /** The follow requests in flight, answered one after another. */
  private following: Promise<void> = Promise.resolve();
  /** The person whose work this tab lists ("all their work", v1.4.0), or null. */
  private workUserId: string | null = null;

  /**
   * Notices the browser going offline at once (an open stream may not fail
   * by itself), and reconnects when it is back.
   */
  constructor() {
    window.addEventListener('offline', () =>
      this.zone.run(() => {
        if (!this.started || this.status() === 'off') return;
        this.close();
        clearTimeout(this.retryTimer);
        this.down();
      }),
    );
    window.addEventListener('online', () =>
      this.zone.run(() => {
        if (!this.started || this.status() === 'off' || this.source !== null) return;
        this.attempt = 0;
        void this.connect();
      }),
    );
  }

  /** Opens the stream after sign-in; calling it again does nothing. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.everConnected = false;
    this.status.set('connecting');
    void this.connect();
  }

  /** Closes the stream, e.g. at sign-out. */
  stop(): void {
    this.started = false;
    this.close();
    clearTimeout(this.retryTimer);
    this.clearDownTimers();
    this.status.set('off');
    this.notifications.live = false;
  }

  /**
   * Follows a project, or none; the API checks membership.
   *
   * @param projectId Project id, or null.
   */
  follow(projectId: string | null): void {
    if (this.projectId === projectId) return;
    this.projectId = projectId;
    this.followed = null;
    this.presence = { itemId: null, action: null, field: null };
    this.presenceSent = SAME_PRESENCE;
    void this.sendFollow();
  }

  /**
   * Follows another person's work (v1.4.0), so "all their work" refreshes
   * like My work, or none (null). The API checks the caller may look them
   * up and still filters every event by the caller's own visibility.
   *
   * @param userId The person, or null.
   */
  followWork(userId: string | null): void {
    if (this.workUserId === userId) return;
    this.workUserId = userId;
    void this.sendWork();
  }

  /**
   * Reports what this tab is doing on the followed project, at most once a
   * second (the latest report wins).
   *
   * @param state Item, action and field.
   */
  report(state: LivePresenceRequest): void {
    this.presence = state;
    const wait = this.presenceAt + PRESENCE_THROTTLE_MS - Date.now();
    clearTimeout(this.presenceTimer);
    if (wait <= 0) void this.sendPresence();
    else this.presenceTimer = setTimeout(() => void this.sendPresence(), wait);
  }

  /**
   * Asks whether live updates are on, then opens the stream.
   *
   * @returns Resolves once the stream is opening, or once it is known to be off.
   */
  private async connect(): Promise<void> {
    if (!this.started) return;
    try {
      const status = await firstValueFrom(this.http.get<LiveStatusDto>(apiUrl('events/status')));
      if (!this.started) return;
      if (!status.enabled) {
        this.clearDownTimers();
        this.status.set('off');
        return;
      }
    } catch (error) {
      // Signed out: the interceptor returns to the login page.
      if (error instanceof HttpErrorResponse && error.status === 401) return;
      this.down();
      this.retry();
      return;
    }
    this.open();
  }

  /** Opens the `EventSource` outside Angular's zone; events re-enter it. */
  private open(): void {
    this.close();
    this.zone.runOutsideAngular(() => {
      const source = new EventSource(apiUrl(`events?client=${encodeURIComponent(CLIENT_ID)}`));
      this.source = source;
      source.addEventListener(LiveEvent.HELLO, (e) =>
        this.zone.run(() => this.hello(parse<LiveHelloDto>(e))),
      );
      source.addEventListener(LiveEvent.DISABLED, () =>
        this.zone.run(() => {
          this.close();
          this.clearDownTimers();
          this.status.set('off');
          this.notifications.live = false;
        }),
      );
      source.addEventListener(LiveEvent.NOTIFICATION, () =>
        this.zone.run(() => {
          this.notificationArrived.update((n) => n + 1);
          void this.notifications.refresh();
        }),
      );
      for (const name of FORWARDED)
        source.addEventListener(name, (e) =>
          this.zone.run(() => {
            // Notifications may have been missed as well.
            if (name === LiveEvent.RESYNC) void this.notifications.refresh();
            this.events.next({ name, data: parse(e) });
          }),
        );
      source.onerror = () =>
        this.zone.run(() => {
          if (this.source !== source) return;
          this.streamId = null;
          this.down();
          // A closed source (refused, 204, proxy error) is not retried by the browser.
          if (source.readyState === EventSource.CLOSED) {
            this.close();
            this.retry();
          }
        });
    });
  }

  /**
   * The stream is open: follow the project again and report presence.
   *
   * @param hello The stream id.
   */
  private hello(hello: LiveHelloDto): void {
    this.streamId = hello.streamId;
    this.attempt = 0;
    this.clearDownTimers();
    this.status.set('live');
    this.notifications.live = true;
    const again = this.everConnected;
    this.everConnected = true;
    this.presenceSent = SAME_PRESENCE;
    void this.sendFollow();
    if (this.workUserId !== null) void this.sendWork();
    this.connected.next({ again });
    if (again) void this.notifications.refresh();
  }

  /** Starts the "Reconnecting…" and "Offline" timers once the stream is lost. */
  private down(): void {
    this.notifications.live = false;
    if (this.reconnectingTimer !== undefined || this.status() === 'off') return;
    this.reconnectingTimer = setTimeout(() => {
      if (this.status() !== 'off' && this.status() !== 'offline') this.status.set('reconnecting');
    }, RECONNECTING_AFTER_MS);
    this.offlineTimer = setTimeout(() => {
      if (this.status() !== 'off') this.status.set('offline');
    }, OFFLINE_AFTER_MS);
  }

  /** Stops the down timers. */
  private clearDownTimers(): void {
    clearTimeout(this.reconnectingTimer);
    clearTimeout(this.offlineTimer);
    this.reconnectingTimer = undefined;
    this.offlineTimer = undefined;
  }

  /** Schedules another attempt with backoff. */
  private retry(): void {
    if (!this.started) return;
    const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)] ?? 30_000;
    this.attempt += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  /** Closes the current source. */
  private close(): void {
    this.source?.close();
    this.source = null;
    this.streamId = null;
    this.followed = null;
  }

  /**
   * Tells the API which project this stream follows, then reports presence.
   * Requests go one after another, each with the project open when it is
   * sent: answered out of order, an earlier "no project" could otherwise
   * land last and leave the API following nothing while this tab thinks it
   * follows the project.
   *
   * @returns Resolves once this and earlier requests are answered.
   */
  private sendFollow(): Promise<void> {
    this.following = this.following.then(() => this.followNow());
    return this.following;
  }

  /**
   * Sends one follow request (see {@link sendFollow}).
   *
   * @returns Resolves once answered.
   */
  private async followNow(): Promise<void> {
    const streamId = this.streamId;
    if (streamId === null) return;
    const projectId = this.projectId;
    try {
      await firstValueFrom(
        this.http.put<void>(apiUrl(`events/${streamId}/project`), { projectId }),
      );
      if (this.projectId !== projectId || this.streamId !== streamId) return;
      this.followed = projectId;
      if (projectId !== null) void this.sendPresence();
    } catch (error) {
      this.lost(error);
    }
  }

  /**
   * Tells the API whose work this stream follows, in turn with the project
   * follow requests, so an earlier answer never lands last.
   *
   * @returns Resolves once this and earlier requests are answered.
   */
  private sendWork(): Promise<void> {
    this.following = this.following.then(async () => {
      const streamId = this.streamId;
      if (streamId === null) return;
      try {
        await firstValueFrom(
          this.http.put<void>(apiUrl(`events/${streamId}/work`), { userId: this.workUserId }),
        );
      } catch (error) {
        // A person the caller may not look up gets no live updates; a lost
        // stream is reopened.
        this.lost(error);
      }
    });
    return this.following;
  }

  /**
   * Sends the latest presence report, unless it is unchanged.
   *
   * @returns Resolves once sent.
   */
  private async sendPresence(): Promise<void> {
    const streamId = this.streamId;
    const text = JSON.stringify(this.presence);
    // Before the API confirmed the subscription, a report would be refused.
    if (
      streamId === null ||
      this.projectId === null ||
      this.followed !== this.projectId ||
      text === this.presenceSent
    )
      return;
    this.presenceSent = text;
    this.presenceAt = Date.now();
    try {
      await firstValueFrom(
        this.http.put<void>(apiUrl(`events/${streamId}/presence`), this.presence),
      );
    } catch (error) {
      // The item may be gone; a lost stream is reopened.
      this.presenceSent = SAME_PRESENCE;
      this.lost(error);
    }
  }

  /**
   * Reopens the stream when the API no longer knows it (it restarted).
   *
   * @param error The failed control request.
   */
  private lost(error: unknown): void {
    if (
      error instanceof HttpErrorResponse &&
      error.status === 404 &&
      (error.error as { message?: string } | null)?.message?.startsWith('Stream') === true
    ) {
      this.close();
      void this.connect();
    }
  }
}

/**
 * Reads an event's JSON data.
 *
 * @param event The message event.
 * @returns Its data, or an empty object.
 */
function parse<T = Record<string, unknown>>(event: Event): T {
  try {
    return JSON.parse((event as MessageEvent<string>).data) as T;
  } catch {
    return {} as T;
  }
}
