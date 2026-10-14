import { computed, inject, Injectable, signal } from '@angular/core';
import {
  type BucketDto,
  type LabelDto,
  type ProjectDto,
  type ProjectMemberDto,
  ProjectPermission,
  ProjectRole,
  type SprintDto,
  type TeamDto,
  TeamRole,
  type WorkItemDto,
} from '@kloister/shared';
import type { ActivityNames } from './activity';
import { fetchAll, ItemsApiService } from './items-api.service';
import { ProjectsApiService } from './projects-api.service';

/**
 * State of the project being viewed, shared by the project's pages (board,
 * item drawer, backlog, sprints). Provided by the project shell, so it lives
 * as long as the user stays inside one project.
 *
 * It holds the project with the caller's `myPermissions`, its buckets,
 * labels, sprints, members and teams, and every item visible to the caller.
 * The capability helpers here only decide which controls to show; the API
 * checks every request again (SPEC §3.4).
 */
@Injectable()
export class ProjectContext {
  private readonly projectsApi = inject(ProjectsApiService);
  private readonly itemsApi = inject(ItemsApiService);

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
    this.projectLoad = this.projectsApi.get(key).then((project) => {
      this.project.set(project);
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
    this.items.set(items);
    this.loaded.set(true);
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
   * Reports whether the card may be dragged between buckets.
   *
   * @param item The item.
   * @returns True when the API reported `can.move` and the project is not archived.
   */
  canMove(item: WorkItemDto): boolean {
    return this.writable() && item.can.move;
  }
}
