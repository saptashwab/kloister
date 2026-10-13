import { CdkDrag, type CdkDragDrop, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import {
  Component,
  computed,
  effect,
  inject,
  input,
  type OnInit,
  signal,
  untracked,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { ActivatedRoute, Router, RouterOutlet } from '@angular/router';
import {
  type CreateItemRequest,
  ItemType,
  ITEM_TITLE_MAX,
  ProjectPermission,
  requiresBucket,
  SprintState,
  Visibility,
  type WorkItemDto,
} from '@kloister/shared';
import { errorMessage } from '../../core/api';
import {
  type BoardColumn,
  type BoardFilter,
  buildColumns,
  dropRequest,
  EMPTY_FILTER,
  type GroupBy,
  isoDate,
  matchesFilter,
  NONE,
} from '../../core/board-logic';
import { ItemsApiService } from '../../core/items-api.service';
import { TYPE_LABELS } from '../../core/labels';
import { ProjectContext } from '../../core/project-context';
import { SessionStore } from '../../core/session.store';
import { ItemCard } from './item-card';

/**
 * The board (SPEC §6), the project's main view: columns by bucket (default),
 * status, assignee or sprint; filters; drag-drop; quick-add.
 *
 * Dragging in the bucket view calls `POST …/items/:item/move` with the card
 * it now follows, and shows the bucket and status the server returns (the
 * bucket's entry rule may change the status). In the other views a drop sets
 * the status, the assignees or the sprint through `PATCH`. Cards can only be
 * dragged when the item's `can` capabilities allow it; the API checks again
 * and the board shows its refusal. With `?sprint=<id>` it is the sprint
 * board. The item drawer opens beside it at `items/:number`.
 */
@Component({
  selector: 'app-board',
  imports: [
    CdkDropListGroup,
    CdkDropList,
    CdkDrag,
    RouterOutlet,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    ItemCard,
  ],
  styles: `
    .filters {
      margin-top: 12px;
    }
    .filters mat-form-field {
      width: 170px;
    }
    .columns {
      display: flex;
      gap: 12px;
      overflow-x: auto;
      align-items: flex-start;
      padding-bottom: 8px;
    }
    .column {
      flex: 0 0 272px;
      padding: 8px;
      border-radius: 12px;
      background: var(--mat-sys-surface-container);
    }
    .column h3 {
      display: flex;
      justify-content: space-between;
      margin: 4px 4px 8px;
      font-size: 0.95rem;
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 48px;
    }
    a.open {
      color: inherit;
      text-decoration: none;
      cursor: pointer;
    }
    .cdk-drag-placeholder {
      opacity: 0.4;
    }
  `,
  template: `
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
    @if (sprintName(); as name) {
      <p role="status">Sprint board: {{ name }}</p>
    }

    <div class="row filters">
      <mat-form-field>
        <mat-label>Group by</mat-label>
        <mat-select [value]="groupBy()" (valueChange)="groupBy.set($event)">
          <mat-option value="bucket">Bucket</mat-option>
          <mat-option value="status">Status</mat-option>
          <mat-option value="assignee">Assignee</mat-option>
          <mat-option value="sprint">Sprint</mat-option>
        </mat-select>
      </mat-form-field>
      <mat-form-field>
        <mat-label>Assignee</mat-label>
        <mat-select [value]="filter().assigneeId" (valueChange)="setFilter({ assigneeId: $event })">
          <mat-option value="">Anyone</mat-option>
          <mat-option [value]="none">Unassigned</mat-option>
          @for (m of ctx.members(); track m.userId) {
            <mat-option [value]="m.userId">{{ m.displayName }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field>
        <mat-label>Label</mat-label>
        <mat-select [value]="filter().labelId" (valueChange)="setFilter({ labelId: $event })">
          <mat-option value="">Any label</mat-option>
          @for (l of ctx.labels(); track l.id) {
            <mat-option [value]="l.id">{{ l.name }}</mat-option>
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
        <mat-label>Due</mat-label>
        <mat-select [value]="filter().due" (valueChange)="setFilter({ due: $event })">
          <mat-option value="">Any time</mat-option>
          <mat-option value="overdue">Overdue</mat-option>
          <mat-option value="week">Due this week</mat-option>
        </mat-select>
      </mat-form-field>
      <mat-form-field>
        <mat-label>Search</mat-label>
        <input
          matInput
          [value]="filter().text"
          (input)="setFilter({ text: $any($event.target).value })"
        />
      </mat-form-field>
      <button mat-button type="button" (click)="clearFilters()">Clear filters</button>
      @if (canCreate()) {
        <mat-form-field>
          <mat-label>Quick-add type</mat-label>
          <mat-select [value]="quickType()" (valueChange)="quickType.set($event)">
            @for (t of types; track t) {
              <mat-option [value]="t">{{ typeLabels[t] }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      }
    </div>

    @if (!ctx.loaded()) {
      <p>Loading…</p>
    } @else if (ctx.buckets().length === 0) {
      <p>This project has no buckets yet.</p>
    } @else {
      <div class="columns" cdkDropListGroup>
        @for (column of columns(); track column.id) {
          <section class="column" [attr.aria-label]="column.title">
            <h3>
              <span>{{ column.title }}</span
              ><span>{{ column.items.length }}</span>
            </h3>
            @if (canQuickAdd(column)) {
              <input
                class="quick-add"
                [attr.aria-label]="'Add a card to ' + column.title"
                placeholder="+ Add a card"
                [attr.maxlength]="titleMax"
                (keyup.enter)="quickAdd(column, $any($event.target))"
              />
            }
            <div
              class="list"
              cdkDropList
              [cdkDropListData]="column"
              [cdkDropListEnterPredicate]="acceptsDrop"
              [cdkDropListSortingDisabled]="groupBy() !== 'bucket'"
              (cdkDropListDropped)="drop($event)"
            >
              @for (item of column.items; track item.id) {
                <a
                  class="open"
                  cdkDrag
                  [cdkDragData]="item"
                  [cdkDragDisabled]="!canDrag(item)"
                  (click)="open(item)"
                  (keyup.enter)="open(item)"
                  tabindex="0"
                  [attr.aria-label]="item.key + ' ' + item.title"
                >
                  <app-item-card [item]="item" [today]="today" />
                </a>
              }
            </div>
          </section>
        }
      </div>
    }

    <router-outlet />
  `,
})
export class BoardPage implements OnInit {
  /** Shared project state. */
  protected readonly ctx = inject(ProjectContext);
  private readonly api = inject(ItemsApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(SessionStore);

  /** `?sprint=<id>`: show the sprint board (the board filtered to one sprint). */
  readonly sprint = input<string>();

  /** "None" column/filter value for the template. */
  protected readonly none = NONE;
  /** Item types for the template. */
  protected readonly types = Object.values(ItemType);
  /** Type names for the template. */
  protected readonly typeLabels = TYPE_LABELS;
  /** Longest title accepted. */
  protected readonly titleMax = ITEM_TITLE_MAX;
  /** Today as `YYYY-MM-DD`, for the due filters and overdue cards. */
  protected readonly today = isoDate(new Date());

  /** What the columns are. */
  protected readonly groupBy = signal<GroupBy>('bucket');
  /** Current filters. */
  protected readonly filter = signal<BoardFilter>(EMPTY_FILTER);
  /** Type of cards created by quick-add. */
  protected readonly quickType = signal<ItemType>(ItemType.TASK);
  /** Last error, if any. */
  protected readonly error = signal('');

  /**
   * Drop predicate: closed sprints take no cards, but cards can still be
   * dragged out of them.
   *
   * @param _drag The dragged card.
   * @param drop The target list.
   * @returns True if the column accepts cards.
   */
  protected readonly acceptsDrop = (_drag: CdkDrag, drop: CdkDropList<BoardColumn>): boolean =>
    drop.data.accepts;

  /** True when quick-add is offered: `CREATE_ITEMS` on an unarchived project. */
  protected readonly canCreate = computed(
    () => this.ctx.writable() && this.ctx.has(ProjectPermission.CREATE_ITEMS),
  );

  /** Name of the sprint the board is filtered to, for the heading. */
  protected readonly sprintName = computed(() => {
    const id = this.filter().sprintId;
    return id && id !== NONE ? (this.ctx.sprintsById().get(id)?.name ?? null) : null;
  });

  /** Columns with their filtered cards. */
  protected readonly columns = computed(() => {
    const filter = this.filter();
    const items = this.ctx.items().filter((i) => matchesFilter(i, filter, this.today));
    return buildColumns(items, this.groupBy(), {
      buckets: this.ctx.buckets(),
      members: this.ctx.members(),
      sprints: this.ctx.sprints(),
    });
  });

  /**
   * Applies `?sprint=` to the sprint filter whenever it changes.
   */
  constructor() {
    effect(() => {
      // Leaving the sprint board (no `?sprint=`) clears the sprint filter too.
      const sprint = this.sprint() ?? '';
      untracked(() => this.filter.update((f) => ({ ...f, sprintId: sprint })));
    });
  }

  /**
   * Loads fresh project data when the board opens.
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
   * Clears every filter, including the sprint board's.
   */
  protected clearFilters(): void {
    this.filter.set(EMPTY_FILTER);
    if (this.sprint() !== undefined) {
      void this.router.navigate([], { relativeTo: this.route, queryParams: {} });
    }
  }

  /**
   * Reports whether a column offers quick-add. Hidden where the API would
   * always refuse the new card: closed sprints (also on a closed sprint's
   * board), other people's columns without `ASSIGN_OTHERS`, and, for callers
   * with the `BUCKETS` scope, views where the card would go to the first
   * bucket, which may be outside their scope.
   *
   * @param column The column.
   * @returns True if quick-add is shown.
   */
  protected canQuickAdd(column: BoardColumn): boolean {
    if (!this.canCreate() || !column.accepts) return false;
    const sprintId = this.filter().sprintId;
    const sprint = sprintId && sprintId !== NONE ? this.ctx.sprintsById().get(sprintId) : undefined;
    if (sprint?.state === SprintState.CLOSED) return false;
    const groupBy = this.groupBy();
    if (groupBy === 'assignee' && column.id !== NONE) {
      const me = this.session.user()?.id;
      if (column.id !== me && !this.ctx.canAssignOthers(null)) return false;
    }
    return groupBy === 'bucket' || this.ctx.project()?.myVisibility !== Visibility.BUCKETS;
  }

  /**
   * Reports whether a card can be dragged in the current view: moving
   * between buckets needs `can.move`; the other views change fields and need
   * `can.edit`.
   *
   * @param item The card.
   * @returns True if dragging is offered.
   */
  protected canDrag(item: WorkItemDto): boolean {
    return this.groupBy() === 'bucket' ? this.ctx.canMove(item) : this.ctx.canEdit(item);
  }

  /**
   * Opens the item drawer for a card.
   *
   * @param item The card.
   */
  protected open(item: WorkItemDto): void {
    void this.router.navigate(['items', item.number], {
      relativeTo: this.route,
      queryParamsHandling: 'preserve',
    });
  }

  /**
   * Sends a drop to the API and shows the item the server returns. The card
   * is placed at once and put back if the API refuses.
   *
   * @param event The CDK drop event.
   * @returns Resolves once the server answered.
   */
  protected async drop(event: CdkDragDrop<BoardColumn, BoardColumn, WorkItemDto>): Promise<void> {
    const item = event.item.data;
    const from = event.previousContainer.data;
    const to = event.container.data;
    const change = dropRequest(this.groupBy(), item, from.id, to.id, to.items, event.currentIndex);
    const project = this.ctx.project();
    if (change === null || project === null) return;
    if (change.kind === 'move') {
      // Show the card in its new place until the server's answer arrives.
      const others = to.items.filter((i) => i.id !== item.id);
      const before = others[event.currentIndex - 1]?.position ?? (others[0]?.position ?? 1) - 1;
      const after = others[event.currentIndex]?.position ?? before + 2;
      this.ctx.upsert({ ...item, bucketId: to.id, position: (before + after) / 2 });
    }
    const ok = await this.run(async () => {
      const updated =
        change.kind === 'move'
          ? await this.api.move(project.id, item.id, change.request)
          : await this.api.update(project.id, item.id, change.request);
      this.ctx.upsert(updated);
    });
    if (!ok) this.ctx.upsert(item);
  }

  /**
   * Creates a card from a column's quick-add field, at the top of the
   * column. The column decides the bucket, status, assignee or sprint; on the
   * sprint board the card joins that sprint.
   *
   * @param column The column.
   * @param input The text field.
   * @returns Resolves once created.
   */
  protected async quickAdd(column: BoardColumn, input: HTMLInputElement): Promise<void> {
    const project = this.ctx.project();
    const title = input.value.trim();
    if (project === null || title === '') return;
    const type = this.quickType();
    const request: CreateItemRequest = { type, title };
    const firstBucket = this.ctx.buckets()[0]?.id ?? null;
    const filterSprint = this.filter().sprintId;
    if (filterSprint && filterSprint !== NONE) request.sprintId = filterSprint;
    switch (this.groupBy()) {
      case 'bucket':
        request.bucketId = column.id;
        break;
      case 'status':
        request.status = column.id as CreateItemRequest['status'];
        break;
      case 'assignee':
        if (column.id !== NONE) request.assigneeIds = [column.id];
        break;
      case 'sprint':
        request.sprintId = column.id === NONE ? null : column.id;
        break;
    }
    // Cards are items on the board: they need a bucket (always for Stories,
    // Tasks and Bugs; Epics and Features would otherwise stay off the board).
    if (request.bucketId === undefined) request.bucketId = firstBucket;
    if (request.bucketId === null && requiresBucket(type)) return;
    const ok = await this.run(async () => {
      this.ctx.upsert(await this.api.create(project.id, request));
    });
    if (ok) input.value = '';
  }

  /**
   * Runs an action, showing any error instead of throwing.
   *
   * @param action The work to do.
   * @returns True if the action succeeded.
   */
  private async run(action: () => Promise<void>): Promise<boolean> {
    this.error.set('');
    try {
      await action();
      return true;
    } catch (error) {
      this.error.set(errorMessage(error));
      return false;
    }
  }
}
