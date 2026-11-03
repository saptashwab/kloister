import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DestroyRef, Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LiveEvent, type WorkItemDto } from '@kloister/shared';
import { Subject } from 'rxjs';
import { makeItem, makeMember, makeProject } from '../../testing/fixtures';
import { ItemsApiService } from './items-api.service';
import {
  changedFields,
  drawerPath,
  headPeople,
  isStrong,
  leadPresence,
  personWithRole,
  presenceDoing,
  presenceLine,
  presenceSentence,
  tagName,
} from './live-logic';
import {
  type LiveMessageEvent,
  LiveService,
  OFFLINE_AFTER_MS,
  RECONNECTING_AFTER_MS,
} from './live.service';
import { NotificationsStore } from './notifications.store';
import { LIVE_BATCH_MS, ProjectContext } from './project-context';
import { ProjectsApiService } from './projects-api.service';

// Live updates in the web app (M10 plan section 12): the words people read,
// batching and refetching in the project store, busy-item deferral, and the
// connection status behind the header chip.

describe('live texts', () => {
  const members = new Map([
    ['u1', makeMember('u1', 'Ann Lee', { role: 'PM' })],
    ['u2', makeMember('u2', 'Bo')],
  ]);

  it('names what each person does', () => {
    expect(
      presenceSentence(
        { userId: 'u1', itemId: 'i1', action: 'editing', field: 'dueDate', view: null },
        'Ann',
      ),
    ).toBe('Ann is editing the due date');
    expect(
      presenceSentence(
        { userId: 'u1', itemId: 'i1', action: 'moving', field: null, view: null },
        'Ann',
        'this card',
      ),
    ).toBe('Ann is moving this card');
    expect(
      presenceSentence(
        { userId: 'u1', itemId: 'i1', action: 'noting', field: null, view: null },
        'Ann',
      ),
    ).toBe('Ann is writing a note');
    expect(
      presenceLine(
        [
          { userId: 'u1', itemId: 'i1', action: 'editing', field: 'dueDate', view: null },
          { userId: 'u2', itemId: 'i1', action: 'viewing', field: null, view: null },
        ],
        members,
      ),
    ).toBe('Ann Lee is editing the due date · Bo is viewing');
  });

  it('names the other person’s role in the conflict notice', () => {
    expect(personWithRole(members, 'u1')).toBe('Ann Lee (PM)');
    expect(personWithRole(members, 'gone')).toBe('Someone');
  });

  it('compares only the fields being changed', () => {
    const base = makeItem(1);
    expect(changedFields(base, { ...base, title: 'New' }, ['dueDate'])).toBe(false);
    expect(changedFields(base, { ...base, dueDate: '2026-11-03' }, ['dueDate'])).toBe(true);
  });

  it('picks the strongest presence for a field, card or row mark', () => {
    const viewing = {
      userId: 'u2',
      itemId: 'i1',
      action: 'viewing',
      field: null,
      view: null,
    } as const;
    const editing = {
      userId: 'u1',
      itemId: 'i1',
      action: 'editing',
      field: 'title',
      view: null,
    } as const;
    expect(isStrong('viewing')).toBe(false);
    expect(isStrong('moving')).toBe(true);
    expect(isStrong('noting')).toBe(true);
    expect(leadPresence([viewing, editing])).toBe(editing);
    expect(leadPresence([viewing])).toBe(viewing);
    expect(leadPresence([viewing, editing], (p) => p.field === 'dueDate')).toBeNull();
    expect(leadPresence(undefined)).toBeNull();
    expect(tagName('Ann Lee')).toBe('Ann');
  });

  it('says what a person is doing in their header hover card', () => {
    const item = { key: 'KLO-42', title: 'Fix login' };
    const entry = (action: 'viewing' | 'editing' | 'moving' | 'noting', field: 'dueDate' | null) =>
      ({ userId: 'u1', itemId: 'i1', action, field, view: 'board' }) as const;
    expect(presenceDoing(entry('editing', 'dueDate'), 'Ann', item)).toBe(
      'Ann is editing the due date of KLO-42 · Fix login',
    );
    expect(presenceDoing(entry('editing', null), 'Ann', item)).toBe(
      'Ann is editing KLO-42 · Fix login',
    );
    expect(presenceDoing(entry('viewing', null), 'Ann', item)).toBe(
      'Ann is viewing KLO-42 · Fix login',
    );
    expect(presenceDoing(entry('moving', null), 'Ann', item)).toBe(
      'Ann is moving KLO-42 · Fix login',
    );
    expect(presenceDoing(entry('noting', null), 'Ann', item)).toBe(
      'Ann is writing a note on KLO-42 · Fix login',
    );
    const away = { userId: 'u1', itemId: null, action: null, field: null } as const;
    expect(presenceDoing({ ...away, view: 'timeline' }, 'Ann', null)).toBe('Viewing the timeline');
    expect(presenceDoing({ ...away, view: null }, 'Ann', null)).toBe('On this project');
  });

  it('opens drawers beside tabs that have one, else beside the board', () => {
    expect(drawerPath('KLO', 'backlog', 4)).toEqual(['/p', 'KLO', 'backlog', 'items', 4]);
    expect(drawerPath('KLO', 'timeline', 4)).toEqual(['/p', 'KLO', 'timeline', 'items', 4]);
    expect(drawerPath('KLO', 'reports', 4)).toEqual(['/p', 'KLO', 'items', 4]);
    expect(drawerPath('KLO', '', 4)).toEqual(['/p', 'KLO', 'items', 4]);
  });

  it('shows at most four people, then a count', () => {
    expect(headPeople(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual({
      shown: ['a', 'b', 'c', 'd'],
      more: 2,
    });
  });
});

describe('ProjectContext live updates', () => {
  afterEach(() => vi.useRealTimers());

  function setup() {
    const events = new Subject<LiveMessageEvent>();
    const live = {
      events,
      connected: new Subject<{ again: boolean }>(),
      follow: vi.fn(),
      report: vi.fn(),
    };
    const itemsApi = {
      buckets: vi.fn().mockResolvedValue([]),
      labels: vi.fn().mockResolvedValue([]),
      sprints: vi.fn().mockResolvedValue([]),
      listAll: vi.fn<() => Promise<WorkItemDto[]>>().mockResolvedValue([makeItem(1), makeItem(2)]),
    };
    TestBed.configureTestingModule({
      providers: [
        ProjectContext,
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: LiveService, useValue: live },
        {
          provide: ProjectsApiService,
          useValue: {
            get: vi.fn().mockResolvedValue(makeProject()),
            members: vi.fn().mockResolvedValue({
              items: [makeMember('u9', 'Pat', { role: 'PM' })],
              nextCursor: null,
            }),
            teams: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
          },
        },
        { provide: ItemsApiService, useValue: itemsApi },
      ],
    });
    const ctx = TestBed.inject(ProjectContext);
    const http = TestBed.inject(HttpTestingController);
    return { ctx, live, http, events };
  }

  /**
   * Answers the batched refetch.
   *
   * @param http The testing controller.
   * @param items The visible items to return.
   * @returns The requested ids.
   */
  async function answer(http: HttpTestingController, items: WorkItemDto[]): Promise<string | null> {
    await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS);
    const request = http.expectOne((r) => r.url.endsWith('/items'));
    request.flush({ items, nextCursor: null });
    await vi.advanceTimersByTimeAsync(0);
    return request.request.params.get('ids');
  }

  it('follows the project, batches item events and refetches them once', async () => {
    vi.useFakeTimers();
    const { ctx, live, http, events } = setup();
    await ctx.open('KLO');
    await ctx.refresh();
    expect(live.follow).toHaveBeenCalledWith(makeProject().id);
    const projectId = makeProject().id;
    events.next({
      name: LiveEvent.ITEM_CHANGED,
      data: { projectId, items: [{ id: 'i1', actorId: 'u9' }] },
    });
    events.next({
      name: LiveEvent.ITEM_CHANGED,
      data: { projectId, items: [{ id: 'i2', actorId: 'u9' }] },
    });
    const ids = await answer(http, [{ ...makeItem(1), title: 'Renamed' }]);
    expect(ids).toBe('i1,i2');
    expect(ctx.itemsById().get('i1')?.title).toBe('Renamed');
    // Not returned any more: deleted or out of scope.
    expect(ctx.itemsById().has('i2')).toBe(false);
    expect(ctx.flashing().has('i1')).toBe(true);
    expect(ctx.changedBy('i1')).toBe('Changed by Pat just now');
    http.verify();
  });

  it('does not follow or reload during an administrator’s cross-project visit', async () => {
    vi.useFakeTimers();
    const { ctx, live, events } = setup();
    const projects = TestBed.inject(ProjectsApiService) as unknown as {
      get: ReturnType<typeof vi.fn>;
    };
    projects.get.mockResolvedValue(makeProject({ myRole: null }));
    await ctx.open('KLO');
    await ctx.refresh();
    expect(live.follow).toHaveBeenLastCalledWith(null);
    const refresh = vi.spyOn(ctx, 'refresh');
    events.next({ name: LiveEvent.RESYNC, data: {} });
    await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('ignores other projects’ events', async () => {
    vi.useFakeTimers();
    const { ctx, http, events } = setup();
    await ctx.open('KLO');
    await ctx.refresh();
    events.next({
      name: LiveEvent.ITEM_CHANGED,
      data: { projectId: 'other', items: [{ id: 'i1', actorId: 'u9' }] },
    });
    await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS);
    http.expectNone((r) => r.url.endsWith('/items'));
  });

  it('keeps a held item still until it is released, then hands over the change', async () => {
    vi.useFakeTimers();
    const { ctx, http, events, live } = setup();
    await ctx.open('KLO');
    await ctx.refresh();
    const hold = ctx.hold('i1', 'moving');
    expect(live.report).toHaveBeenLastCalledWith({
      itemId: 'i1',
      action: 'moving',
      field: null,
      view: null,
    });
    events.next({
      name: LiveEvent.ITEM_CHANGED,
      data: { projectId: makeProject().id, items: [{ id: 'i1', actorId: 'u9' }] },
    });
    await answer(http, [{ ...makeItem(1), bucketId: 'b2' }]);
    // Nothing moves under the pointer.
    expect(ctx.itemsById().get('i1')?.bucketId).toBe(makeItem(1).bucketId);
    const missed = await hold.release(false);
    expect(missed?.item?.bucketId).toBe('b2');
    expect(missed?.actorId).toBe('u9');
    expect(ctx.itemsById().get('i1')?.bucketId).toBe(makeItem(1).bucketId);
    ctx.applyRemote(missed!);
    expect(ctx.itemsById().get('i1')?.bucketId).toBe('b2');
    expect(ctx.changedBy('i1')).toBe('Moved by Pat just now');
  });

  it('forgets removed items and tells the drawer', async () => {
    vi.useFakeTimers();
    const { ctx, events } = setup();
    await ctx.open('KLO');
    await ctx.refresh();
    const seen: unknown[] = [];
    ctx.remote.subscribe((c) => seen.push(c));
    events.next({
      name: LiveEvent.ITEM_REMOVED,
      data: { projectId: makeProject().id, items: [{ id: 'i2', actorId: 'u9', deleted: true }] },
    });
    expect(ctx.itemsById().has('i2')).toBe(false);
    expect(seen).toEqual([{ id: 'i2', actorId: 'u9', item: null, deleted: true }]);
  });

  it('reloads everything on store-wide events', async () => {
    vi.useFakeTimers();
    const { ctx, events } = setup();
    await ctx.open('KLO');
    await ctx.refresh();
    const refresh = vi.spyOn(ctx, 'refresh');
    events.next({ name: LiveEvent.ACCESS_CHANGED, data: { projectId: makeProject().id } });
    events.next({ name: LiveEvent.BOARD_CHANGED, data: { projectId: makeProject().id } });
    await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('reports the page with presence and lets the open page show items', async () => {
    const { ctx, live } = setup();
    // The shell reports its page before the project has loaded; following
    // the project resets the stream's report, so the page is sent again.
    ctx.setPage('timeline');
    await ctx.open('KLO');
    expect(live.follow).toHaveBeenCalled();
    expect(live.report).toHaveBeenLastCalledWith({
      itemId: null,
      action: null,
      field: null,
      view: 'timeline',
    });
    ctx.view('i1');
    expect(live.report).toHaveBeenLastCalledWith({
      itemId: 'i1',
      action: 'viewing',
      field: null,
      view: 'timeline',
    });
    // Without a page that can show items, "Go to" opens the drawer.
    expect(ctx.locate('i1')).toBe('open');
    const page = TestBed.inject(Injector).get(DestroyRef);
    const locator = vi.fn().mockReturnValue('done');
    const unregister = ctx.registerLocator(locator, page);
    expect(ctx.locate('i1')).toBe('done');
    expect(locator).toHaveBeenCalledWith('i1');
    unregister();
    expect(ctx.locate('i1')).toBe('open');
  });

  it('keeps presence and reports the open item', async () => {
    const { ctx, events, live } = setup();
    await ctx.open('KLO');
    ctx.view('i1');
    expect(live.report).toHaveBeenLastCalledWith({
      itemId: 'i1',
      action: 'viewing',
      field: null,
      view: null,
    });
    events.next({
      name: LiveEvent.PRESENCE,
      data: {
        projectId: makeProject().id,
        people: [{ userId: 'u9', itemId: 'i1', action: 'editing', field: 'title', view: null }],
      },
    });
    expect(ctx.presenceByItem().get('i1')).toHaveLength(1);
    ctx.view(null);
    expect(live.report).toHaveBeenLastCalledWith({
      itemId: null,
      action: null,
      field: null,
      view: null,
    });
  });
});

describe('LiveService', () => {
  /** A stand-in for the browser's EventSource. */
  class FakeSource {
    static last: FakeSource | null = null;
    static readonly CLOSED = 2;
    readyState = 0;
    onerror: (() => void) | null = null;
    readonly listeners = new Map<string, (e: MessageEvent) => void>();
    /**
     * Records the new source.
     *
     * @param url Its URL.
     */
    constructor(readonly url: string) {
      FakeSource.last = this;
    }
    /**
     * Registers a listener.
     *
     * @param name Event name.
     * @param fn Listener.
     */
    addEventListener(name: string, fn: (e: MessageEvent) => void): void {
      this.listeners.set(name, fn);
    }
    /**
     * Sends an event.
     *
     * @param name Event name.
     * @param data Its data.
     */
    emit(name: string, data: object): void {
      this.listeners.get(name)?.({ data: JSON.stringify(data) } as MessageEvent);
    }
    /** Closes it. */
    close(): void {
      this.readyState = FakeSource.CLOSED;
    }
  }

  beforeEach(() => vi.stubGlobal('EventSource', FakeSource));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function setup() {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    return {
      live: TestBed.inject(LiveService),
      http: TestBed.inject(HttpTestingController),
      notifications: TestBed.inject(NotificationsStore),
    };
  }

  it('stays off when an admin switched live updates off', async () => {
    const { live, http } = setup();
    live.start();
    http.expectOne('api/v1/events/status').flush({ enabled: false });
    await Promise.resolve();
    expect(live.status()).toBe('off');
    expect(FakeSource.last).toBeNull();
  });

  it('goes live on hello, follows the project, then shows reconnecting and offline', async () => {
    vi.useFakeTimers();
    FakeSource.last = null;
    const { live, http, notifications } = setup();
    live.follow('p1');
    live.start();
    http.expectOne('api/v1/events/status').flush({ enabled: true });
    await vi.advanceTimersByTimeAsync(0);
    const source = FakeSource.last!;
    expect(source.url).toContain('api/v1/events?client=');
    source.emit(LiveEvent.HELLO, { streamId: 's1' });
    expect(live.status()).toBe('live');
    expect(notifications.live).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne('api/v1/events/s1/project').flush(null);
    // Lost: the browser retries by itself.
    source.onerror?.();
    expect(notifications.live).toBe(false);
    await vi.advanceTimersByTimeAsync(RECONNECTING_AFTER_MS);
    expect(live.status()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(OFFLINE_AFTER_MS);
    expect(live.status()).toBe('offline');
    source.emit(LiveEvent.HELLO, { streamId: 's2' });
    expect(live.status()).toBe('live');
    live.stop();
  });

  it('reports presence only once the API confirmed the followed project', async () => {
    vi.useFakeTimers();
    const { live, http } = setup();
    live.start();
    http.expectOne('api/v1/events/status').flush({ enabled: true });
    await vi.advanceTimersByTimeAsync(0);
    FakeSource.last!.emit(LiveEvent.HELLO, { streamId: 's1' });
    live.follow('p1');
    live.report({ itemId: 'i1', action: 'viewing', field: null });
    await vi.advanceTimersByTimeAsync(2_000);
    // Only the subscription so far; presence would be refused before it.
    http.expectNone('api/v1/events/s1/presence');
    // Follow requests go one at a time (hello's, then the project's).
    for (let n = 0; n < 3; n++) {
      for (const f of http.match('api/v1/events/s1/project')) f.flush(null);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(http.expectOne('api/v1/events/s1/presence').request.body).toEqual({
      itemId: 'i1',
      action: 'viewing',
      field: null,
    });
    live.stop();
  });

  it('sends follow requests one after another, the last one with the open project', async () => {
    vi.useFakeTimers();
    const { live, http } = setup();
    live.start();
    http.expectOne('api/v1/events/status').flush({ enabled: true });
    await vi.advanceTimersByTimeAsync(0);
    FakeSource.last!.emit(LiveEvent.HELLO, { streamId: 's1' });
    await vi.advanceTimersByTimeAsync(0);
    live.follow('p1');
    await vi.advanceTimersByTimeAsync(0);
    // Only the first request is out; the project's waits for its answer.
    const first = http.match('api/v1/events/s1/project');
    expect(first).toHaveLength(1);
    expect(first[0].request.body).toEqual({ projectId: null });
    first[0].flush(null);
    await vi.advanceTimersByTimeAsync(0);
    const second = http.expectOne('api/v1/events/s1/project');
    expect(second.request.body).toEqual({ projectId: 'p1' });
    second.flush(null);
    live.stop();
  });

  it('follows another person’s work and again after reconnecting (v1.4.0)', async () => {
    vi.useFakeTimers();
    const { live, http } = setup();
    live.followWork('u2');
    live.start();
    http.expectOne('api/v1/events/status').flush({ enabled: true });
    await vi.advanceTimersByTimeAsync(0);
    FakeSource.last!.emit(LiveEvent.HELLO, { streamId: 's1' });
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne('api/v1/events/s1/project').flush(null);
    await vi.advanceTimersByTimeAsync(0);
    const first = http.expectOne('api/v1/events/s1/work');
    expect(first.request.method).toBe('PUT');
    expect(first.request.body).toEqual({ userId: 'u2' });
    first.flush(null);
    // A new stream follows the same person again.
    FakeSource.last!.emit(LiveEvent.HELLO, { streamId: 's2' });
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne('api/v1/events/s2/project').flush(null);
    await vi.advanceTimersByTimeAsync(0);
    const again = http.expectOne('api/v1/events/s2/work');
    expect(again.request.body).toEqual({ userId: 'u2' });
    again.flush(null);
    // Leaving the page stops it.
    live.followWork(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(http.expectOne('api/v1/events/s2/work').request.body).toEqual({ userId: null });
    live.stop();
  });

  it('shows reconnecting when the browser goes offline and reconnects when it is back', async () => {
    vi.useFakeTimers();
    const { live, http } = setup();
    live.start();
    http.expectOne('api/v1/events/status').flush({ enabled: true });
    await vi.advanceTimersByTimeAsync(0);
    const first = FakeSource.last!;
    first.emit(LiveEvent.HELLO, { streamId: 's1' });
    window.dispatchEvent(new Event('offline'));
    expect(first.readyState).toBe(FakeSource.CLOSED);
    await vi.advanceTimersByTimeAsync(RECONNECTING_AFTER_MS);
    expect(live.status()).toBe('reconnecting');
    window.dispatchEvent(new Event('online'));
    http.expectOne('api/v1/events/status').flush({ enabled: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSource.last).not.toBe(first);
    FakeSource.last!.emit(LiveEvent.HELLO, { streamId: 's2' });
    expect(live.status()).toBe('live');
    live.stop();
  });

  it('ends for good when the server says live updates were switched off', async () => {
    vi.useFakeTimers();
    const { live, http } = setup();
    live.start();
    http.expectOne('api/v1/events/status').flush({ enabled: true });
    await vi.advanceTimersByTimeAsync(0);
    const source = FakeSource.last!;
    source.emit(LiveEvent.HELLO, { streamId: 's1' });
    source.emit(LiveEvent.DISABLED, {});
    expect(live.status()).toBe('off');
    expect(source.readyState).toBe(FakeSource.CLOSED);
  });
});
