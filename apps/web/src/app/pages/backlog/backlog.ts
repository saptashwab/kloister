import { SnapshotAction } from '../../ui/snapshot-action';
import { Component, computed, inject, type OnInit, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { ActivatedRoute, Router, RouterOutlet } from '@angular/router';
import { ItemType, ProjectPermission, SprintState, type WorkItemDto } from '@kloister/shared';
import { errorMessage } from '../../core/api';
import {
  type BoardFilter,
  buildTree,
  EMPTY_FILTER,
  flattenTree,
  endOfWeek,
  isoDate,
  matchesFilter,
  NONE,
  pruneTree,
} from '../../core/board-logic';
import { type BulkField, planBulk, runBulk } from '../../core/bulk';
import { ItemsApiService } from '../../core/items-api.service';
import { TYPE_LABELS } from '../../core/labels';
import { EmptyState, Skeleton } from '../../ui/feedback';
import { Icon } from '../../ui/icon';
import { StatusPill, TypeIcon } from '../../ui/signals';
import { ProjectContext } from '../../core/project-context';
import { SessionStore } from '../../core/session.store';

/**
 * The backlog / hierarchy view (SPEC §6): the Epic → Feature → Story → Task
 * tree with expand/collapse, multi-select and bulk set sprint, bucket or
 * assignee.
 *
 * Ancestors outside the caller's scope appear as read-only title rows
 * (SPEC §3.3): they cannot be selected or opened. Bulk edits send one
 * ordinary PATCH or move per item, so the API applies the same rules as for a
 * single edit; items whose `can` capabilities rule the change out are skipped
 * and listed. Selection will also choose what to export (M8).
 */
@Component({
  selector: 'app-backlog',
  imports: [
    SnapshotAction,
    RouterOutlet,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    EmptyState,
    Icon,
    Skeleton,
    StatusPill,
    TypeIcon,
  ],
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--k-space-3);
      padding: var(--k-size-14px) var(--k-gutter) var(--k-space-8);
    }
    .filters mat-form-field {
      width: var(--k-size-170px);
    }
    .bulk {
      position: sticky;
      top: 0;
      z-index: 2;
      padding: var(--k-space-2) var(--k-size-14px);
      border: var(--k-line) solid var(--k-primary-line);
      border-radius: var(--k-radius-md);
      background: var(--k-primary-soft);
      color: var(--k-primary-ink);
    }
    .bulk mat-form-field {
      width: var(--k-size-170px);
    }
    .tree {
      border: var(--k-line) solid var(--k-border);
      border-radius: var(--k-radius-lg);
      background: var(--k-surface);
    }
    table.data td {
      padding: var(--k-space-1) var(--k-size-10px);
    }
    .item {
      display: flex;
      align-items: center;
      gap: var(--k-space-2);
      min-height: var(--k-control-height);
    }
    .item a {
      color: var(--k-text);
      text-decoration: none;
    }
    .item a:hover {
      text-decoration: underline;
    }
    .toggle {
      display: inline-grid;
      place-items: center;
      width: var(--k-space-6);
      height: var(--k-space-6);
      padding: 0;
      border: 0;
      border-radius: var(--k-radius-sm);
      background: transparent;
      color: var(--k-muted);
      cursor: pointer;
    }
    .toggle:hover {
      background: var(--k-sunken);
    }
    .toggle.open app-icon {
      transform: rotate(90deg);
    }
    .spacer-24 {
      display: inline-block;
      width: var(--k-space-6);
    }
    .ghost {
      color: var(--k-muted);
      font-style: italic;
    }
  `,
  template: `
    @if (error()) {
      <p class="k-alert" role="alert">{{ error() }}</p>
    }

    <app-snapshot-action [source]="ctx.project()?.id ?? ''" [filters]="snapshotFilters()" />
    <div class="row filters">
      <mat-form-field>
        <mat-label>Search</mat-label>
        <input
          matInput
          [value]="filter().text"
          (input)="setFilter({ text: $any($event.target).value })"
        />
      </mat-form-field>
      <mat-form-field>
        <mat-label>Type</mat-label>
        <mat-select [value]="filter().type" (valueChange)="setFilter({ type: $event })">
          <mat-option value="">Any type</mat-option>
          @for (t of types; track t) {
            <mat-option [value]="t">{{ typeLabels[t] }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field>
        <mat-label>Sprint</mat-label>
        <mat-select [value]="filter().sprintId" (valueChange)="setFilter({ sprintId: $event })">
          <mat-option value="">Any sprint</mat-option>
          <mat-option [value]="none">No sprint</mat-option>
          @for (s of ctx.sprints(); track s.id) {
            <mat-option [value]="s.id">{{ s.name }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      @if (ctx.project()?.ownerId === null) {
        <mat-form-field>
          <mat-label>Assignee</mat-label>
          <mat-select
            [value]="filter().assigneeId"
            (valueChange)="setFilter({ assigneeId: $event })"
          >
            <mat-option value="">Anyone</mat-option>
            <mat-option [value]="none">Unassigned</mat-option>
            @for (m of ctx.members(); track m.userId) {
              <mat-option [value]="m.userId">{{ m.displayName }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      }

      <button mat-button type="button" (click)="collapsed.set(allParents())">Collapse all</button>
      <button mat-button type="button" (click)="collapsed.set(emptySet)">Expand all</button>
    </div>

    @if (selected().size > 0) {
      <div class="row bulk" role="region" aria-label="Bulk edit">
        <span
          >{{ selected().size }} selected{{
            hiddenSelected() > 0 ? ' (' + hiddenSelected() + ' hidden by the filters)' : ''
          }}</span
        >
        <!-- Keyed by run, so the pickers are empty again after each bulk edit. -->
        @for (run of [bulkRuns()]; track run) {
          @if (ctx.writable()) {
            <mat-form-field>
              <mat-label>Set sprint</mat-label>
              <mat-select [disabled]="busy()" (valueChange)="bulk('sprint', $event)">
                <mat-option [value]="none">No sprint</mat-option>
                @for (s of openSprints(); track s.id) {
                  <mat-option [value]="s.id">{{ s.name }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <mat-form-field>
              <mat-label>Set bucket</mat-label>
              <mat-select [disabled]="busy()" (valueChange)="bulk('bucket', $event)">
                @for (b of ctx.buckets(); track b.id) {
                  <mat-option [value]="b.id">{{ b.name }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            @if (ctx.project()?.ownerId === null) {
              <mat-form-field>
                <mat-label>Set assignee</mat-label>
                <mat-select [disabled]="busy()" (valueChange)="bulk('assignee', $event)">
                  <mat-option [value]="none">Unassigned</mat-option>
                  @for (m of activeMembers(); track m.userId) {
                    <mat-option [value]="m.userId">{{ m.displayName }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
            }
          }
        }
        <button mat-button type="button" (click)="selected.set(emptySet)">Clear selection</button>
        @if (ctx.has(adoPermission) && ctx.project()?.ownerId === null) {
          <button mat-button type="button" (click)="transferSelection()">
            Transfer selected to ADO
          </button>
        }
      </div>
    }
    @if (report(); as r) {
      <div role="status">
        <p>{{ r.summary }}</p>
        @if (r.problems.length > 0) {
          <ul>
            @for (p of r.problems; track p) {
              <li>{{ p }}</li>
            }
          </ul>
        }
      </div>
    }

    @if (!ctx.loaded()) {
      <app-skeleton label="Loading the backlog" [rows]="8" />
    } @else if (ctx.items().length === 0) {
      <app-empty-state
        title="The backlog is empty"
        text="Items created on the board or with “New item” appear here as a tree of Epics, Features, Stories and Tasks."
      />
    } @else {
      <div class="tree k-table-scroll" tabindex="0" role="region" aria-label="Scrollable table">
        <table class="data">
          <thead>
            <tr>
              <th scope="col">
                <mat-checkbox
                  aria-label="Select all shown"
                  [checked]="allShownSelected()"
                  (change)="selectAllShown($event.checked)"
                />
              </th>
              <th scope="col">Item</th>
              <th scope="col">Status</th>
              <th scope="col">Sprint</th>
              <th scope="col">Bucket</th>
              <th scope="col">Assignees</th>
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track row.node.id) {
              @let item = row.node.item;
              <tr>
                <td>
                  @if (item) {
                    <mat-checkbox
                      [aria-label]="'Select ' + item.key"
                      [checked]="selected().has(item.id)"
                      (change)="toggle(item.id, $event.checked)"
                    />
                  }
                </td>
                <td [style.padding-left.px]="10 + row.depth * 24">
                  <span class="item">
                    @if (row.node.children.length > 0) {
                      <button
                        class="toggle"
                        type="button"
                        [class.open]="!collapsed().has(row.node.id)"
                        [attr.aria-expanded]="!collapsed().has(row.node.id)"
                        [attr.aria-label]="
                          (collapsed().has(row.node.id) ? 'Expand ' : 'Collapse ') +
                          row.node.ref.key
                        "
                        (click)="toggleCollapsed(row.node.id)"
                      >
                        <app-icon name="chevronRight" [size]="14" [stroke]="2.4" />
                      </button>
                    } @else {
                      <span class="spacer-24"></span>
                    }
                    <app-type-icon [type]="row.node.ref.type" />
                    <span class="k-key">{{ row.node.ref.key }}</span>
                    @if (item) {
                      <a href="" (click)="open($event, item)">{{ item.title }}</a>
                    } @else {
                      <span class="ghost" title="Outside your view: shown as a title only">{{
                        row.node.ref.title
                      }}</span>
                    }
                  </span>
                </td>
                <td>
                  @if (item) {
                    <app-status-pill [status]="item.status" />
                  }
                </td>
                <td>{{ item ? sprintName(item) : '' }}</td>
                <td>{{ item ? bucketName(item) : '' }}</td>
                <td>{{ item ? assigneeNames(item) : '' }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="6" class="muted">No items match the filters.</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }

    <router-outlet />
  `,
})
export class BacklogPage implements OnInit {
  /** Distinct transfer capability, never applied to snapshots. */
  protected readonly adoPermission = ProjectPermission.EXPORT_ADO;

  /** Carries exact backlog identities into the lazy transfer screen without expanding children. */
  protected transferSelection(): void {
    void this.router.navigate(['/p', this.ctx.project()?.key, 'ado'], {
      queryParams: { items: [...this.selected()].join(',') },
    });
  }
  /** Shared project state. */
  protected readonly ctx = inject(ProjectContext);
  private readonly api = inject(ItemsApiService);
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /** "None" value for the template. */
  protected readonly none = NONE;
  /** An empty set, for resetting selection and collapse state. */
  protected readonly emptySet: ReadonlySet<string> = new Set<string>();
  /** Item types. */
  protected readonly types = Object.values(ItemType);
  /** Type names. */
  protected readonly typeLabels = TYPE_LABELS;
  private readonly today = isoDate(new Date());

  /** Serializes every current screen filter for the server snapshot preview. */
  protected snapshotFilters(): Record<string, string | boolean> {
    const f = this.filter();
    return {
      today: this.today,
      boardOnly: false,
      ...Object.fromEntries(
        Object.entries({
          q: f.text,
          type: f.type,
          labelId: f.labelId,
          sprintId: f.sprintId,
          assigneeId: f.assigneeId === 'none' ? '' : f.assigneeId,
          dueGroup: f.due === 'overdue' ? 'Overdue' : '',
          unassigned: f.assigneeId === 'none',
          dueFrom: f.due === 'week' ? this.today : '',
          dueTo: f.due === 'week' ? endOfWeek(this.today) : '',
        }).filter(([, value]) => value !== ''),
      ),
    };
  }

  /** Current filters (the board's, minus label and due). */
  protected readonly filter = signal<BoardFilter>(EMPTY_FILTER);
  /** Ids of collapsed nodes. */
  protected readonly collapsed = signal<ReadonlySet<string>>(new Set());
  /** Ids of selected items. */
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  /** Outcome of the last bulk edit. */
  protected readonly report = signal<{ summary: string; problems: string[] } | null>(null);
  /** Last error, if any. */
  protected readonly error = signal('');
  /** True while a bulk edit runs; the pickers are disabled meanwhile. */
  protected readonly busy = signal(false);
  /** Number of bulk edits run, to reset the bulk pickers. */
  protected readonly bulkRuns = signal(0);

  /** The full tree. */
  private readonly tree = computed(() => buildTree(this.ctx.items()));

  /** Rows to show: the filtered tree, flattened, without collapsed subtrees. */
  protected readonly rows = computed(() => {
    const filter = this.filter();
    const pruned = pruneTree(this.tree(), (i) => matchesFilter(i, filter, this.today));
    return flattenTree(pruned, this.collapsed());
  });

  /** Members who can still be assigned. */
  protected readonly activeMembers = computed(() => this.ctx.members().filter((m) => m.isActive));

  /** Selected items the current filters hide; bulk edits include them. */
  protected readonly hiddenSelected = computed(() => {
    const shown = new Set(this.shownItemIds());
    return [...this.selected()].filter((id) => !shown.has(id)).length;
  });

  /** Sprints items can still join. */
  protected readonly openSprints = computed(() =>
    this.ctx.sprints().filter((s) => s.state !== SprintState.CLOSED),
  );

  /** True when every selectable row shown is selected. */
  protected readonly allShownSelected = computed(() => {
    const shown = this.shownItemIds();
    const selected = this.selected();
    return shown.length > 0 && shown.every((id) => selected.has(id));
  });

  /**
   * Loads fresh project data when the backlog opens.
   */
  ngOnInit(): void {
    void this.run(() => this.ctx.refresh());
  }

  /**
   * Changes some filters.
   *
   * @param change Filters to set.
   */
  protected setFilter(change: Partial<BoardFilter>): void {
    this.filter.update((f) => ({ ...f, ...change }));
  }

  /**
   * Ids of every node with children, for "Collapse all".
   *
   * @returns The ids.
   */
  protected allParents(): ReadonlySet<string> {
    const ids = new Set<string>();
    const walk = (nodes: ReturnType<typeof buildTree>) => {
      for (const n of nodes) {
        if (n.children.length > 0) ids.add(n.id);
        walk(n.children);
      }
    };
    walk(this.tree());
    return ids;
  }

  /**
   * Expands or collapses one node.
   *
   * @param id Node id.
   */
  protected toggleCollapsed(id: string): void {
    this.collapsed.update((set) => toggled(set, id, !set.has(id)));
  }

  /**
   * Selects or deselects one item.
   *
   * @param id Item id.
   * @param on Select it.
   */
  protected toggle(id: string, on: boolean): void {
    this.selected.update((set) => toggled(set, id, on));
  }

  /**
   * Selects or deselects every visible item shown.
   *
   * @param on Select them.
   */
  protected selectAllShown(on: boolean): void {
    const shown = this.shownItemIds();
    this.selected.update((set) => shown.reduce((acc, id) => toggled(acc, id, on), set));
  }

  /**
   * Names an item's sprint.
   *
   * @param item The item.
   * @returns Sprint name, or empty.
   */
  protected sprintName(item: WorkItemDto): string {
    return item.sprintId === null ? '' : (this.ctx.sprintsById().get(item.sprintId)?.name ?? '');
  }

  /**
   * Names an item's bucket.
   *
   * @param item The item.
   * @returns Bucket name, or "Off the board".
   */
  protected bucketName(item: WorkItemDto): string {
    if (item.bucketId === null) return 'Off the board';
    return this.ctx.bucketsById().get(item.bucketId)?.name ?? '';
  }

  /**
   * Lists assignee names.
   *
   * @param item The item.
   * @returns Comma-separated names.
   */
  protected assigneeNames(item: WorkItemDto): string {
    const byId = this.ctx.membersById();
    return item.assigneeIds.map((id) => byId.get(id)?.displayName ?? 'Former member').join(', ');
  }

  /**
   * Opens an item in the drawer beside the backlog.
   *
   * @param event The click, whose default navigation is cancelled.
   * @param item The item.
   */
  protected open(event: Event, item: WorkItemDto): void {
    event.preventDefault();
    void this.router.navigate(['items', item.number], { relativeTo: this.route });
  }

  /**
   * Sets a sprint, bucket or assignee on every selected item, one request
   * per item, and reports what changed, what was skipped and what the API
   * refused.
   *
   * @param field What to set.
   * @param value The value, or the "none" value.
   * @returns Resolves once every request is answered.
   */
  protected async bulk(field: BulkField, value: string): Promise<void> {
    const project = this.ctx.project();
    const userId = this.session.user()?.id;
    if (project === null || userId === undefined || this.busy()) return;
    this.busy.set(true);
    const byId = this.ctx.itemsById();
    const items = [...this.selected()].map((id) => byId.get(id)).filter((i) => i !== undefined);
    const plan = planBulk(items, field, value, {
      userId,
      canAssignOthers: (teamId) => this.ctx.canAssignOthers(teamId),
    });
    this.report.set({ summary: `Updating ${plan.steps.length} items…`, problems: [] });
    const result = await runBulk(plan.steps, (step) =>
      step.kind === 'move'
        ? this.api.move(project.id, step.item.id, step.request)
        : this.api.update(project.id, step.item.id, step.request),
    );
    this.busy.set(false);
    for (const item of result.updated) this.ctx.upsert(item);
    this.bulkRuns.update((n) => n + 1);
    this.report.set({
      summary:
        `${result.updated.length} updated, ${plan.unchanged.length} already set, ` +
        `${plan.skipped.length} skipped, ${result.failed.length} refused.`,
      problems: [
        ...plan.skipped.map((i) => `${i.key}: you cannot make this change`),
        ...result.failed.map((f) => `${f.item.key}: ${f.message}`),
      ],
    });
  }

  /**
   * Ids of the selectable (visible) items currently shown.
   *
   * @returns Item ids.
   */
  private shownItemIds(): string[] {
    return this.rows()
      .map((r) => r.node.item?.id)
      .filter((id) => id !== undefined);
  }

  /**
   * Runs an action, showing any error instead of throwing.
   *
   * @param action The work to do.
   * @returns Resolves when done.
   */
  private async run(action: () => Promise<void>): Promise<void> {
    this.error.set('');
    try {
      await action();
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }
}

/**
 * Returns a copy of a set with one id added or removed.
 *
 * @param set The set.
 * @param id The id.
 * @param on Add (true) or remove (false).
 * @returns The new set.
 */
function toggled(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}
