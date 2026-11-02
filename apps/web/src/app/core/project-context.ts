import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  type BucketDto,
  ITEM_IDS_FILTER_MAX,
  type LabelDto,
  LiveEvent,
  MAX_PAGE_LIMIT,
  type Page,
  type LiveItemDto,
  type LiveItemsDto,
  type LivePresenceDto,
  type LivePresenceRequest,
  type PresenceAction,
  type PresenceEntryDto,
  type PresenceField,
  type ProjectDto,
  type ProjectMemberDto,
  ProjectPermission,
  ProjectRole,
  type SprintDto,
  type TeamDto,
  TeamRole,
  type WorkItemDto,
} from '@kloister/shared';
import { firstValueFrom, Subject } from 'rxjs';
import type { ActivityNames } from './activity';
import { apiUrl, errorMessage } from './api';
import { fetchAll, ItemsApiService } from './items-api.service';
import { CHANGED_TEXT_MS, changedText, HIGHLIGHT_MS, personName } from './live-logic';
import { LiveService } from './live.service';
import { ProjectsApiService } from './projects-api.service';

/** How long item events are gathered before the changed items are refetched (M10). */
export const LIVE_BATCH_MS = 300;

/** A change from someone else, applied to the store (M10). */
export interface RemoteChange {
  /** Item id. */
  id: string;
  /** Who made it; null for the system. */
  actorId: string | null;
  /** The item now, or null when it is gone for the viewer. */
  item: WorkItemDto | null;
  /** When gone: true if deleted, false if it left the viewer's scope. */
  deleted: boolean;
}

/** A busy item's hold (drag, cell edit, M10 plan section 4.3). */
export interface ItemHold {
  /**
   * Ends the hold. Changes that arrived meanwhile are applied when `apply`
   * is true; otherwise the caller decides (Keep mine / Use theirs) and
   * applies them with {@link ProjectContext.applyRemote}.
   *
   * @param apply Whether to apply waiting changes now.
   * @returns The waiting change, if any.
   */
  release(apply?: boolean): Promise<RemoteChange | null>;
}

/**
 * State of the project being viewed, shared by the project's pages (board,
 * item drawer, backlog, sprints). Provided by the project shell, so it lives
 * as long as the user stays inside one project.
 *
 * It holds the project with the caller's `myPermissions`, its buckets,
 * labels, sprints, members and teams, and every item visible to the caller.
 * The capability helpers here only decide which controls to show; the API
 * checks every request again (SPEC §3.4).
 *
 * Live updates (M10): the store follows its project on the tab's live
 * stream, gathers item events for 300 ms, refetches the changed items
 * through the scoped API and upserts or forgets them; store-wide events
 * reload everything. Items held by a drag or an edit keep their copy until
 * released, so nothing moves under the pointer. It also keeps the
 * highlights ("Changed by Ann just now") and the project's presence.
 */
@Injectable()
export class ProjectContext {
  private readonly projectsApi = inject(ProjectsApiService);
  private readonly itemsApi = inject(ItemsApiService);
  private readonly http = inject(HttpClient);
  /** The tab's live stream. */
  readonly live = inject(LiveService);

  /** The project, or null until loaded. */
  readonly project = signal<ProjectDto | null>(null);
  /** Buckets in column order. */
  readonly buckets = signal<BucketDto[]>([]);
  /** Labels. */
  readonly labels = signal<LabelDto[]>([]);
  /** Sprints. */
  readonly sprints = signal<SprintDto[]>([]);
  /** Project members. */
  readonly members = signal<ProjectMemberDto[]>([]);
  /** Teams. */
  readonly teams = signal<TeamDto[]>([]);
  /** Every item visible to the caller, in board order. */
  readonly items = signal<WorkItemDto[]>([]);
  /** True once the lists have been loaded at least once. */
  readonly loaded = signal(false);
  /** Set when a live reload found the project gone for the caller (removed, M10). */
  readonly lost = signal('');

  /** Changes from others applied to the store (the drawer refreshes its item). */
  readonly remote = new Subject<RemoteChange>();
  /** Bumped when dependency links between visible items changed. */
  readonly linksVersion = signal(0);
  /** Items highlighted after a change from someone else. */
  readonly flashing = signal<ReadonlySet<string>>(new Set());
  /** Recent changes from others, for "Changed by … just now". */
  readonly recent = signal<ReadonlyMap<string, { text: string; at: number }>>(new Map());
  /** Everyone else on the project, as the API lets the caller see them. */
  readonly presence = signal<readonly PresenceEntryDto[]>([]);
  /** Presence by item id. */
  readonly presenceByItem = computed(() => {
    const map = new Map<string, PresenceEntryDto[]>();
    for (const entry of this.presence())
      if (entry.itemId !== null) map.set(entry.itemId, [...(map.get(entry.itemId) ?? []), entry]);
    return map;
  });

  /** Items by id. */
  readonly itemsById = computed(() => new Map(this.items().map((i) => [i.id, i])));
  /** Members by user id. */
  readonly membersById = computed(() => new Map(this.members().map((m) => [m.userId, m])));
  /** Buckets by id. */
  readonly bucketsById = computed(() => new Map(this.buckets().map((b) => [b.id, b])));
  /** Labels by id. */
  readonly labelsById = computed(() => new Map(this.labels().map((l) => [l.id, l])));
  /** Sprints by id. */
  readonly sprintsById = computed(() => new Map(this.sprints().map((s) => [s.id, s])));

  /** False on archived projects, which are read-only for everyone. */
  readonly writable = computed(() => {
    const project = this.project();
    return project !== null && project.archivedAt === null;
  });

  /** Id lookups for the activity history. */
  readonly names: ActivityNames = {
    bucket: (id) => this.bucketsById().get(id)?.name ?? null,
    sprint: (id) => this.sprintsById().get(id)?.name ?? null,
    member: (id) => this.membersById().get(id)?.displayName ?? null,
    label: (id) => this.labelsById().get(id)?.name ?? null,
    team: (id) => this.teams().find((t) => t.id === id)?.name ?? null,
    item: (id) => this.itemsById().get(id)?.key ?? null,
  };

  private loadingKey: string | null = null;
  private projectLoad: Promise<ProjectDto> | null = null;
  /** Set by {@link open}, so the first refresh does not load the project twice. */
  private projectIsFresh = false;
  /** Counts refreshes, so only the latest one stores its answers. */
  private refreshRun = 0;
  /** Item events waiting for the batch, by id. */
  private readonly queued = new Map<string, LiveItemDto>();
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  /** Hold counts of busy items. */
  private readonly busy = new Map<string, number>();
  /** Changes waiting for busy items; `pending` while the refetch has not answered. */
  private readonly held = new Map<string, RemoteChange & { pending: boolean }>();
  /** False on an administrator's cross-project visit, which is not live. */
  private following = false;
  /** Counts holds, for unique presence sources. */
  private holds = 0;
  /** Presence by source: the open item, then edits and holds; the newest wins. */
  private readonly presenceSources = new Map<string, LivePresenceRequest>();

  /**
   * Follows the project on the live stream and handles its events.
   */
  constructor() {
    const destroy = inject(DestroyRef);
    this.live.events.pipe(takeUntilDestroyed(destroy)).subscribe((event) => {
      const project = this.project();
      // An administrator's cross-project visit is not live (M10 plan section 5.3).
      if (project === null || !this.following) return;
      if (event.name === LiveEvent.RESYNC) {
        this.scheduleReload();
        return;
      }
      if (event.data['projectId'] !== project.id) return;
      switch (event.name) {
        case LiveEvent.ITEM_CHANGED:
          this.receive((event.data as unknown as LiveItemsDto).items, false);
          break;
        case LiveEvent.ITEM_REMOVED:
          this.receive((event.data as unknown as LiveItemsDto).items, true);
          break;
        case LiveEvent.LINKS_CHANGED:
          this.linksVersion.update((v) => v + 1);
          this.receive(
            ((event.data['ids'] as string[] | undefined) ?? []).map((id) => ({
              id,
              actorId: null,
            })),
            false,
          );
          break;
        case LiveEvent.PRESENCE:
          this.presence.set((event.data as unknown as LivePresenceDto).people);
          break;
        default:
          this.scheduleReload();
      }
    });
    this.live.connected.pipe(takeUntilDestroyed(destroy)).subscribe(() => {
      // Changes made while the stream was down (or before it opened) are fetched once.
      if (this.loaded() && this.following) this.scheduleReload();
    });
    destroy.onDestroy(() => {
      clearTimeout(this.batchTimer);
      clearTimeout(this.reloadTimer);
      clearTimeout(this.flashTimer);
      this.live.follow(null);
    });
  }

  /**
   * Loads a project by key; does nothing if it is already the current one.
   * A 404 (not a member, or no such project) rejects.
   *
   * @param key Project key from the URL.
   * @returns The project.
   */
  open(key: string): Promise<ProjectDto> {
    if (this.loadingKey === key && this.projectLoad !== null) return this.projectLoad;
    this.loadingKey = key;
    this.loaded.set(false);
    // Another project's data must never show under this key.
    this.project.set(null);
    this.items.set([]);
    this.projectIsFresh = true;
    this.lost.set('');
    this.presence.set([]);
    this.projectLoad = this.projectsApi.get(key).then((project) => {
      this.project.set(project);
      this.following = project.myRole !== null || project.ownerId !== null;
      this.live.follow(this.following ? project.id : null);
      return project;
    });
    return this.projectLoad;
  }

  /**
   * Reloads the project (the caller's permissions may have changed) and every
   * list. Pages call this when they open, so each view starts from fresh data.
   *
   * @returns Resolves once everything is loaded.
   */
  async refresh(): Promise<void> {
    if (this.loadingKey === null) throw new Error('No project opened');
    // Only the latest refresh may store its answers; older ones finishing
    // later would overwrite newer state.
    const run = ++this.refreshRun;
    const current = await (this.projectLoad ?? this.projectsApi.get(this.loadingKey));
    // Each request for a project an admin is not a member of is audited
    // (SPEC §3.1), so the project is not fetched twice in a row.
    const project = this.projectIsFresh ? current : await this.projectsApi.get(current.id);
    this.projectIsFresh = false;
    if (run !== this.refreshRun) return;
    this.project.set(project);
    const [buckets, labels, sprints, members, teams, items] = await Promise.all([
      this.itemsApi.buckets(project.id),
      this.itemsApi.labels(project.id),
      this.itemsApi.sprints(project.id),
      project.ownerId !== null
        ? Promise.resolve([])
        : fetchAll((cursor) => this.projectsApi.members(project.id, cursor)),
      project.ownerId !== null
        ? Promise.resolve([])
        : fetchAll((cursor) => this.projectsApi.teams(project.id, cursor)),
      this.itemsApi.listAll(project.id),
    ]);
    if (run !== this.refreshRun) return;
    this.buckets.set(buckets);
    this.labels.set(labels);
    this.sprints.set(sprints);
    this.members.set(members);
    this.teams.set(teams);
    this.items.set(this.keepBusy(items));
    this.loaded.set(true);
  }

  /**
   * Holds an item while it is dragged or edited: changes from others wait
   * until the hold ends (M10 plan section 4.3), and presence shows what the
   * caller does.
   *
   * @param id Item id.
   * @param action Moving or editing.
   * @param field The field being edited.
   * @returns The hold.
   */
  hold(id: string, action: PresenceAction, field: PresenceField | null = null): ItemHold {
    this.busy.set(id, (this.busy.get(id) ?? 0) + 1);
    const source = `hold:${id}:${++this.holds}`;
    this.setPresence(source, { itemId: id, action, field: action === 'editing' ? field : null });
    let released = false;
    return {
      release: async (apply = true) => {
        if (released) return null;
        released = true;
        this.setPresence(source, null);
        const count = (this.busy.get(id) ?? 1) - 1;
        if (count > 0) {
          this.busy.set(id, count);
          return null;
        }
        this.busy.delete(id);
        let change = this.held.get(id) ?? null;
        this.held.delete(id);
        // Still waiting for the batch: fetch it now.
        if (change?.pending === true) change = { ...change, item: await this.fetchOne(id) };
        if (change === null) return null;
        const done: RemoteChange = {
          id,
          actorId: change.actorId,
          item: change.item,
          deleted: change.deleted,
        };
        if (apply) this.applyRemote(done);
        return done;
      },
    };
  }

  /**
   * Shows a change from someone else: upserts or forgets the item,
   * highlights it and tells the drawer.
   *
   * @param change The change.
   */
  applyRemote(change: RemoteChange): void {
    const old = this.itemsById().get(change.id);
    if (change.item === null) this.forget([change.id]);
    else {
      this.upsert(change.item);
      const moved = old !== undefined && old.bucketId !== change.item.bucketId;
      this.highlight(change.id, changedText(personName(this.membersById(), change.actorId), moved));
    }
    this.remote.next(change);
  }

  /**
   * The tooltip of a recently changed item.
   *
   * @param id Item id.
   * @returns "Changed by … just now", or null.
   */
  changedBy(id: string): string | null {
    const entry = this.recent().get(id);
    return entry !== undefined && Date.now() - entry.at < CHANGED_TEXT_MS ? entry.text : null;
  }

  /**
   * Reports the item the caller has open (the drawer), or none.
   *
   * @param itemId Item id, or null.
   */
  view(itemId: string | null): void {
    this.setPresence('view', itemId === null ? null : { itemId, action: 'viewing', field: null });
  }

  /**
   * Reports an activity on an item that does not hold it (a focused drawer
   * field, a note being written), or ends it. The newest activity shows.
   *
   * @param source A name for the activity.
   * @param state What the caller does, or null when done.
   */
  setPresence(source: string, state: LivePresenceRequest | null): void {
    this.presenceSources.delete(source);
    if (state !== null) this.presenceSources.set(source, state);
    const latest = [...this.presenceSources.values()].at(-1);
    this.live.report(latest ?? { itemId: null, action: null, field: null });
  }

  /**
   * Keeps busy items' current copies through a reload; their new copies wait
   * as changes from someone else until the hold ends.
   *
   * @param items The reloaded items.
   * @returns The items to store.
   */
  private keepBusy(items: WorkItemDto[]): WorkItemDto[] {
    if (this.busy.size === 0) return items;
    const current = this.itemsById();
    const fresh = new Map(items.map((i) => [i.id, i]));
    for (const id of this.busy.keys()) {
      const old = current.get(id);
      const item = fresh.get(id) ?? null;
      if (old !== undefined && JSON.stringify(old) !== JSON.stringify(item))
        this.held.set(id, {
          id,
          actorId: this.held.get(id)?.actorId ?? null,
          item,
          deleted: false,
          pending: false,
        });
    }
    const kept = items.map((i) => (this.busy.has(i.id) ? (current.get(i.id) ?? i) : i));
    for (const id of this.busy.keys()) {
      const old = current.get(id);
      if (!fresh.has(id) && old !== undefined) kept.push(old);
    }
    return kept;
  }

  /**
   * Gathers item events for the batch; changes of busy items wait.
   *
   * @param items The items.
   * @param removed True for `item-removed`.
   */
  private receive(items: readonly LiveItemDto[], removed: boolean): void {
    for (const item of items) {
      if (!removed) {
        this.queued.set(item.id, item);
        continue;
      }
      this.queued.delete(item.id);
      const change = {
        id: item.id,
        actorId: item.actorId,
        item: null,
        deleted: item.deleted ?? true,
      };
      if (this.busy.has(item.id)) this.held.set(item.id, { ...change, pending: false });
      else if (this.itemsById().has(item.id)) this.applyRemote(change);
      else this.remote.next(change);
    }
    if (this.queued.size > 0 && this.batchTimer === undefined)
      this.batchTimer = setTimeout(() => void this.flush(), LIVE_BATCH_MS);
  }

  /**
   * Refetches the gathered items through the scoped list and applies them;
   * items no longer returned are gone for the caller.
   *
   * @returns Resolves once applied.
   */
  private async flush(): Promise<void> {
    this.batchTimer = undefined;
    const project = this.project();
    const batch = [...this.queued.values()];
    this.queued.clear();
    if (project === null || batch.length === 0) return;
    for (const item of batch)
      if (this.busy.has(item.id))
        this.held.set(item.id, {
          id: item.id,
          actorId: item.actorId,
          item: null,
          deleted: false,
          pending: true,
        });
    try {
      for (let start = 0; start < batch.length; start += ITEM_IDS_FILTER_MAX) {
        const part = batch.slice(start, start + ITEM_IDS_FILTER_MAX);
        const found = await this.byIds(
          project.id,
          part.map((i) => i.id),
        );
        if (this.project()?.id !== project.id) return;
        const byId = new Map(found.map((i) => [i.id, i]));
        for (const item of part) {
          const change = {
            id: item.id,
            actorId: item.actorId,
            item: byId.get(item.id) ?? null,
            deleted: false,
          };
          if (this.busy.has(item.id)) this.held.set(item.id, { ...change, pending: false });
          else if (change.item !== null || this.itemsById().has(item.id)) this.applyRemote(change);
          else this.remote.next(change);
        }
      }
    } catch {
      // Reload everything instead.
      this.scheduleReload();
    }
  }

  /**
   * Fetches one item's current copy.
   *
   * @param id Item id.
   * @returns The item, or null when gone.
   */
  private async fetchOne(id: string): Promise<WorkItemDto | null> {
    const project = this.project();
    if (project === null) return null;
    try {
      return (await this.byIds(project.id, [id]))[0] ?? null;
    } catch {
      return this.itemsById().get(id) ?? null;
    }
  }

  /**
   * Loads the given items if they are still visible to the caller, through
   * the scoped item list (`ids` filter). Deleted items and items that left
   * the caller's scope are simply missing.
   *
   * @param projectId Project id.
   * @param ids Item ids, at most `ITEM_IDS_FILTER_MAX`.
   * @returns The visible ones.
   */
  private async byIds(projectId: string, ids: readonly string[]): Promise<WorkItemDto[]> {
    const params = new HttpParams().set('ids', ids.join(',')).set('limit', MAX_PAGE_LIMIT);
    const page = await firstValueFrom(
      this.http.get<Page<WorkItemDto>>(apiUrl(`projects/${projectId}/items`), { params }),
    );
    return page.items;
  }

  /** Reloads the whole store soon (store-wide events, reconnects). */
  private scheduleReload(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      if (this.loadingKey === null) return;
      this.refresh()
        // The timeline reloads its links and holidays with the store.
        .then(() => this.linksVersion.update((v) => v + 1))
        .catch((error: unknown) => {
          // Removed from the project: show "project not found".
          if (error instanceof HttpErrorResponse && error.status === 404) {
            this.lost.set(errorMessage(error));
            this.project.set(null);
          }
        });
    }, LIVE_BATCH_MS);
  }

  /**
   * Highlights a changed item for a moment and remembers who changed it.
   *
   * @param id Item id.
   * @param text The tooltip.
   */
  private highlight(id: string, text: string): void {
    const now = Date.now();
    this.recent.update((recent) => {
      const next = new Map([...recent].filter(([, e]) => now - e.at < CHANGED_TEXT_MS));
      next.set(id, { text, at: now });
      return next;
    });
    this.flashing.update((ids) => new Set([...ids, id]));
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.flashing.set(new Set()), HIGHLIGHT_MS);
  }

  /**
   * Stores an item returned by the API, replacing the old copy. The server's
   * copy is the truth: after a move it carries the final bucket and status.
   *
   * @param item The item from the API.
   */
  upsert(item: WorkItemDto): void {
    this.items.update((items) => {
      const index = items.findIndex((i) => i.id === item.id);
      if (index === -1) return [...items, item];
      const next = [...items];
      next[index] = item;
      return next;
    });
  }

  /**
   * Forgets items, e.g. after a delete (with its subtree for cascades).
   *
   * @param ids Item ids.
   */
  forget(ids: Iterable<string>): void {
    const gone = new Set(ids);
    this.items.update((items) => items.filter((i) => !gone.has(i.id)));
  }

  /**
   * Reports whether the caller holds a project permission.
   *
   * @param permission The permission.
   * @returns True if granted.
   */
  has(permission: ProjectPermission): boolean {
    return this.project()?.myPermissions.includes(permission) ?? false;
  }

  /**
   * Reports whether the caller may assign people other than themselves to an
   * item: `ASSIGN_OTHERS`, or leading the item's team (SPEC §3.5).
   *
   * @param teamId The item's team.
   * @returns True if others may be assigned.
   */
  canAssignOthers(teamId: string | null): boolean {
    if (this.has(ProjectPermission.ASSIGN_OTHERS)) return true;
    return (
      teamId !== null &&
      (this.project()?.myTeams.some((t) => t.teamId === teamId && t.role === TeamRole.LEAD) ??
        false)
    );
  }

  /**
   * Reports whether the caller may put an item into a team (DECISIONS M3):
   * project PMs and Leads any team; others only "no team" or a team they
   * lead.
   *
   * @param teamId The team, or null for none.
   * @returns True if the choice is offered.
   */
  canPickTeam(teamId: string | null): boolean {
    const project = this.project();
    if (project === null) return false;
    if (teamId === null || project.myRole === ProjectRole.PM || project.myRole === ProjectRole.LEAD)
      return true;
    return project.myTeams.some((t) => t.teamId === teamId && t.role === TeamRole.LEAD);
  }

  /**
   * Reports whether the item's controls for editing should be shown.
   *
   * @param item The item.
   * @returns True when the API reported `can.edit` and the project is not archived.
   */
  canEdit(item: WorkItemDto): boolean {
    return this.writable() && item.can.edit;
  }

  /**
   * Reports whether the item's title, dates, half days, pin and dependencies
   * may be changed (M9.2).
   *
   * @param item The item.
   * @returns True when the API reported `can.plan` and the project is not archived.
   */
  canPlan(item: WorkItemDto): boolean {
    return this.writable() && item.can.plan;
  }

  /**
   * Reports whether the card may be dragged between buckets.
   *
   * @param item The item.
   * @returns True when the API reported `can.move` and the project is not archived.
   */
  canMove(item: WorkItemDto): boolean {
    return this.writable() && item.can.move;
  }
}
