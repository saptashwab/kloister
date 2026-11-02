import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { AppConfig } from '../config/app-config.js';
import { LIVE_CHANNEL, type LiveMessage } from './live-events.js';

/** The part of a `pg` client the listener uses. */
export interface ListenClient {
  /** Opens the connection. */
  connect(): Promise<unknown>;
  /** Runs a statement. */
  query(sql: string): Promise<unknown>;
  /** Closes the connection. */
  end(): Promise<void>;
  /** Registers notification, error and end handlers. */
  on(
    event: 'notification',
    listener: (message: { channel: string; payload?: string }) => void,
  ): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
}

/** Creates listen connections; replaced in tests. */
export abstract class ListenClientFactory {
  /**
   * Creates an unconnected client.
   *
   * @returns The client.
   */
  abstract create(): ListenClient;
}

/** Creates real `pg` clients for the configured database. */
@Injectable()
export class PgListenClientFactory extends ListenClientFactory {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param config Supplies the connection string.
   */
  constructor(private readonly config: AppConfig) {
    super();
  }

  /**
   * Creates an unconnected client.
   *
   * @returns The client.
   */
  create(): ListenClient {
    return new pg.Client({ connectionString: this.config.databaseUrl });
  }
}

/** Waits before reconnecting, in milliseconds, by attempt. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** What the listener reports to its owner. */
export interface ListenerHandlers {
  /** A message arrived. */
  message(message: LiveMessage): void;
  /** Listening (again); `after` is true after an interruption, when events may be missed. */
  ready(after: boolean): void;
}

/**
 * One dedicated PostgreSQL connection per API process running
 * `LISTEN kloister_events` (M10 plan section 5.2). It connects only while
 * live streams are open, so the app and its tests run without it, and it
 * reconnects with backoff after a failure.
 */
@Injectable()
export class PgListener implements OnModuleDestroy {
  private readonly logger = new Logger(PgListener.name);
  private client: ListenClient | null = null;
  private wanted = false;
  private attempt = 0;
  private interrupted = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private handlers: ListenerHandlers | null = null;
  /** Bumped by {@link stop}, so a connection that finishes afterwards is closed. */
  private generation = 0;

  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param factory Creates connections.
   */
  constructor(private readonly factory: ListenClientFactory) {}

  /**
   * Whether the connection is listening.
   *
   * @returns True while listening.
   */
  get listening(): boolean {
    return this.client !== null;
  }

  /**
   * Starts listening, if not already.
   *
   * @param handlers Receives messages and readiness.
   */
  start(handlers: ListenerHandlers): void {
    this.handlers = handlers;
    if (this.wanted) return;
    this.wanted = true;
    this.interrupted = false;
    void this.connect();
  }

  /**
   * Stops listening and closes the connection.
   *
   * @returns Resolves once closed.
   */
  async stop(): Promise<void> {
    this.wanted = false;
    this.generation += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
    const client = this.client;
    this.client = null;
    if (client !== null) await client.end().catch(() => undefined);
  }

  /**
   * Closes the connection on shutdown.
   *
   * @returns Resolves once closed.
   */
  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  /**
   * Opens a connection and listens; schedules a retry on failure.
   *
   * @returns Resolves once listening or once a retry is scheduled.
   */
  private async connect(): Promise<void> {
    const generation = this.generation;
    const client = this.factory.create();
    let failed = false;
    const fail = (error?: Error): void => {
      if (failed) return;
      failed = true;
      if (error !== undefined) this.logger.warn(`Live updates connection failed: ${error.message}`);
      if (this.client === client) this.client = null;
      void client.end().catch(() => undefined);
      this.retry();
    };
    client.on('error', fail);
    client.on('end', () => fail());
    client.on('notification', (n) => {
      if (n.channel !== LIVE_CHANNEL || n.payload === undefined) return;
      try {
        this.handlers?.message(JSON.parse(n.payload) as LiveMessage);
      } catch {
        this.logger.warn('Ignored a malformed live update message');
      }
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${LIVE_CHANNEL}`);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!this.wanted || failed || generation !== this.generation || this.client !== null) {
      await client.end().catch(() => undefined);
      return;
    }
    this.client = client;
    this.attempt = 0;
    const after = this.interrupted;
    this.interrupted = false;
    this.handlers?.ready(after);
  }

  /** Schedules the next connection attempt while listening is wanted. */
  private retry(): void {
    if (!this.wanted) return;
    this.interrupted = true;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] ?? 30_000;
    this.attempt += 1;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(), delay);
    this.timer.unref?.();
  }
}
