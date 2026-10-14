import { CdkDrag, type CdkDragDrop, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  forwardRef,
  inject,
  input,
  type OnInit,
  signal,
  untracked,
} from '@angular/core';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatMenuModule } from '@angular/material/menu';
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
import { revertFields, revertMove, undoFields } from '../../core/item-changes';
import { ItemsApiService } from '../../core/items-api.service';
import { STATUS_LABELS, TYPE_LABELS } from '../../core/labels';
import { ProjectContext } from '../../core/project-context';
import { SessionStore } from '../../core/session.store';
import { Shortcuts } from '../../core/shortcuts';
import { Avatar, PERSON_FILTER, type PersonFilter } from '../../ui/avatar';
import { EmptyState, Skeleton } from '../../ui/feedback';
import { Icon } from '../../ui/icon';
import { ToastService } from '../../ui/toast.service';
import { ItemCard } from './item-card';

/** How many member avatars the quick person filter shows. */
const QUICK_PEOPLE = 6;

/**
 * The board (SPEC §6, DESIGN §7–§9), the project's main view: columns by
 * bucket (default), status, assignee or sprint; filter chips and the quick
 * person filter; drag-drop; quick-add.
 *
 * Dragging in the bucket view calls `POST …/items/:item/move` with the card
 * it now follows, and shows the bucket and status the server returns (the
 * bucket's entry rule may change the status). In the other views a drop sets
 * the status, the assignees or the sprint through `PATCH`. Every drop is
 * confirmed by a toast with Undo, which sends the reverse change. Cards can
 * only be dragged when the item's `can` capabilities allow it; the API checks
 * again and the board shows its refusal. With `?sprint=<id>` it is the sprint
 * board. The item drawer opens beside it at `items/:number`.
 *
 * The board is the {@link PersonFilter} for avatars on it: clicking an
 * avatar, or "Filter board to this person" in its hover card, sets the
 * assignee filter.
 */
@Component({
  selector: 'app-board',
  imports: [
    CdkDropListGroup,
    CdkDropList,
    CdkDrag,
    RouterOutlet,
    MatButtonToggleModule,
    MatMenuModule,
    Avatar,
    EmptyState,
    Icon,
    ItemCard,
    Skeleton,
  ],
  providers: [{ provide: PERSON_FILTER, useExisting: forwardRef(() => BoardPage) }],
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--k-size-14px);
      padding: var(--k-size-14px) var(--k-gutter) 0;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--k-space-2);
    }
    .search {
      display: flex;
      align-items: center;
      gap: var(--k-space-2);
      height: var(--k-space-8);
      padding: 0 var(--k-size-10px);
      border: var(--k-line) solid var(--k-border);
      border-radius: var(--k-radius-control);
      background: var(--k-surface);
      color: var(--k-muted);
    }
    .search input {
      width: var(--k-size-170px);
      border: 0;
      background: transparent;
      color: var(--k-text);
      font: inherit;
      font-size: var(--k-body-sm);
    }
    .search:focus-within {
      border-color: var(--k-primary);
    }
    .columns {
      display: flex;
      gap: var(--k-space-4);
      align-items: flex-start;
      overflow-x: auto;
      padding-bottom: var(--k-space-8);
    }
    .column {
      flex: 0 0 var(--k-size-288px);
      display: flex;
      flex-direction: column;
      gap: var(--k-size-10px);
      box-sizing: border-box;
      padding: var(--k-size-10px);
      border-radius: var(--k-radius-lg);
      background: var(--k-sunken);
    }
    .column h2 {
      display: flex;
      align-items: center;
      gap: var(--k-space-2);
      padding: var(--k-focus-width) var(--k-space-1);
      font-size: var(--k-body-sm);
      font-weight: 700;
    }
    .count {
      background: var(--k-surface);
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: var(--k-size-10px);
      min-height: var(--k-size-48px);
    }
    .cdk-drag-preview {
      box-shadow: var(--k-lift);
      rotate: var(--k-drag-tilt);
    }
    .cdk-drag-placeholder {
      opacity: 1;
      border: var(--k-focus-width) dashed var(--k-primary-line);
      background: var(--k-primary-soft);
      box-shadow: none;
    }
    .cdk-drag-placeholder > * {
      visibility: hidden;
    }
    .cdk-drag-animating,
    .list.cdk-drop-list-dragging .cdk-drag:not(.cdk-drag-placeholder) {
      transition: transform var(--k-motion) ease;
    }
    .list.cdk-drop-list-dragging app-item-card {
      content-visibility: visible;
    }
    .check {
      display: inline-block;
      width: var(--k-size-20px);
      color: var(--k-primary);
    }
  `,
  template: `
    @if (sprintName(); as name) {
      <p class="k-alert info" role="status">Sprint board: {{ name }}</p>
    }

    <div class="toolbar" role="toolbar" aria-label="Board filters">
      <label class="search">
        <app-icon name="search" />
        <input
          type="search"
          placeholder="Search cards"
          aria-label="Search cards"
          [value]="filter().text"
          (input)="setFilter({ text: $any($event.target).value })"
        />
      </label>

      @if (ctx.project()?.ownerId === null) {
        <button
          type="button"
          class="k-chip"
          [class.on]="!!filter().assigneeId"
          [matMenuTriggerFor]="assigneeMenu"
        >
          <app-icon name="users" [size]="14" />{{ chipText('Assignee', assigneeName()) }}
        </button>
        <mat-menu #assigneeMenu="matMenu">
          <button
            mat-menu-item
            role="menuitemradio"
            [attr.aria-checked]="filter().assigneeId === ''"
            (click)="setFilter({ assigneeId: '' })"
          >
            <span class="check" aria-hidden="true">{{ mark(filter().assigneeId === '') }}</span
            >Anyone
          </button>
          <button
            mat-menu-item
            role="menuitemradio"
            [attr.aria-checked]="filter().assigneeId === none"
            (click)="setFilter({ assigneeId: none })"
          >
            <span class="check" aria-hidden="true">{{ mark(filter().assigneeId === none) }}</span
            >Unassigned
          </button>
          @for (m of ctx.members(); track m.userId) {
            <button
              mat-menu-item
              role="menuitemradio"
              [attr.aria-checked]="filter().assigneeId === m.userId"
              (click)="setFilter({ assigneeId: m.userId })"
            >
              <span class="check" aria-hidden="true">{{
                mark(filter().assigneeId === m.userId)
              }}</span
              >{{ m.displayName }}
            </button>
          }
        </mat-menu>
      }

      <button
        type="button"
        class="k-chip"
        [class.on]="!!filter().labelId"
        [matMenuTriggerFor]="labelMenu"
      >
        <app-icon name="plus" [size]="14" />{{ chipText('Label', labelName()) }}
      </button>
      <mat-menu #labelMenu="matMenu">
        <button
          mat-menu-item
          role="menuitemradio"
          [attr.aria-checked]="filter().labelId === ''"
          (click)="setFilter({ labelId: '' })"
        >
          <span class="check" aria-hidden="true">{{ mark(filter().labelId === '') }}</span
          >Any label
        </button>
        @for (l of ctx.labels(); track l.id) {
          <button
            mat-menu-item
            role="menuitemradio"
            [attr.aria-checked]="filter().labelId === l.id"
            (click)="setFilter({ labelId: l.id })"
          >
            <span class="check" aria-hidden="true">{{ mark(filter().labelId === l.id) }}</span
            >{{ l.name }}
          </button>
        }
      </mat-menu>

      <button
        type="button"
        class="k-chip"
        [class.on]="!!filter().sprintId"
        [matMenuTriggerFor]="sprintMenu"
      >
        <app-icon name="sprints" [size]="14" />{{ chipText('Sprint', sprintFilterName()) }}
      </button>
      <mat-menu #sprintMenu="matMenu">
        <button
          mat-menu-item
          role="menuitemradio"
          [attr.aria-checked]="filter().sprintId === ''"
          (click)="setFilter({ sprintId: '' })"
        >
          <span class="check" aria-hidden="true">{{ mark(filter().sprintId === '') }}</span
          >Any sprint
        </button>
        <button
          mat-menu-item
          role="menuitemradio"
          [attr.aria-checked]="filter().sprintId === none"
          (click)="setFilter({ sprintId: none })"
        >
          <span class="check" aria-hidden="true">{{ mark(filter().sprintId === none) }}</span
          >No sprint
        </button>
        @for (s of ctx.sprints(); track s.id) {
          <button
            mat-menu-item
            role="menuitemradio"
            [attr.aria-checked]="filter().sprintId === s.id"
            (click)="setFilter({ sprintId: s.id })"
          >
            <span class="check" aria-hidden="true">{{ mark(filter().sprintId === s.id) }}</span
            >{{ s.name }}
          </button>
        }
      </mat-menu>

      <button
        type="button"
        class="k-chip"
        [class.on]="!!filter().type"
        [matMenuTriggerFor]="typeMenu"
      >
        <app-icon name="TASK" [size]="14" />{{
          chipText('Type', filter().type ? typeLabels[filter().type || 'TASK'] : '')
        }}
      </button>
      <mat-menu #typeMenu="matMenu">
        <button
          mat-menu-item
          role="menuitemradio"
          [attr.aria-checked]="filter().type === ''"
          (click)="setFilter({ type: '' })"
        >
          <span class="check" aria-hidden="true">{{ mark(filter().type === '') }}</span
          >Any type
        </button>
        @for (t of types; track t) {
          <button
            mat-menu-item
            role="menuitemradio"
            [attr.aria-checked]="filter().type === t"
            (click)="setFilter({ type: t })"
          >
            <span class="check" aria-hidden="true">{{ mark(filter().type === t) }}</span
            >{{ typeLabels[t] }}
          </button>
        }
      </mat-menu>

      <button
        type="button"
        class="k-chip"
        [class.on]="!!filter().due"
        [matMenuTriggerFor]="dueMenu"
      >
        <app-icon name="calendar" [size]="14" />{{ chipText('Due', dueNames[filter().due]) }}
      </button>
      <mat-menu #dueMenu="matMenu">
        <button
          mat-menu-item
          role="menuitemradio"
          [attr.aria-checked]="filter().due === ''"
          (click)="setFilter({ due: '' })"
        >
          <span class="check" aria-hidden="true">{{ mark(filter().due === '') }}</span
          >Any time
        </button>
        <button
          mat-menu-item
          role="menuitemradio"
          [attr.aria-checked]="filter().due === 'overdue'"
          (click)="setFilter({ due: 'overdue' })"
        >
          <span class="check" aria-hidden="true">{{ mark(filter().due === 'overdue') }}</span
          >Overdue
        </button>
        <button
          mat-menu-item
          role="menuitemradio"
          [attr.aria-checked]="filter().due === 'week'"
          (click)="setFilter({ due: 'week' })"
        >
          <span class="check" aria-hidden="true">{{ mark(filter().due === 'week') }}</span
          >Due this week
        </button>
      </mat-menu>

      @if (quickPeople().length > 0) {
        <div class="k-avatars" role="group" aria-label="Filter by person">
          @for (m of quickPeople(); track m.userId) {
            <app-avatar
              [userId]="m.userId"
              [name]="m.displayName"
              [email]="m.email"
              [size]="30"
              [toggle]="true"
            />
          }
        </div>
      }
      @if (filtered()) {
        <button type="button" class="k-chip on" (click)="clearFilters()">
          Clear filters<app-icon name="close" [size]="13" [stroke]="2.4" />
        </button>
      }

      <span class="spacer"></span>

      @if (canCreate()) {
        <button
          type="button"
          class="k-chip"
          [matMenuTriggerFor]="quickTypeMenu"
          aria-label="Type of new cards"
        >
          New cards: {{ typeLabels[quickType()] }}<app-icon name="chevronDown" [size]="13" />
        </button>
        <mat-menu #quickTypeMenu="matMenu">
          @for (t of types; track t) {
            <button
              mat-menu-item
              role="menuitemradio"
              [attr.aria-checked]="quickType() === t"
              (click)="quickType.set(t)"
            >
              <span class="check" aria-hidden="true">{{ mark(quickType() === t) }}</span
              >{{ typeLabels[t] }}
            </button>
          }
        </mat-menu>
      }
      <mat-button-toggle-group
        class="k-segmented"
        aria-label="Group by"
        hideSingleSelectionIndicator
        [value]="groupBy()"
        (change)="groupBy.set($event.value)"
      >
        <mat-button-toggle value="bucket">Bucket</mat-button-toggle>
        <mat-button-toggle value="status">Status</mat-button-toggle>
        @if (ctx.project()?.ownerId === null) {
          <mat-button-toggle value="assignee">Assignee</mat-button-toggle>
        }
        <mat-button-toggle value="sprint">Sprint</mat-button-toggle>
      </mat-button-toggle-group>
    </div>

    @if (!ctx.loaded()) {
      <app-skeleton kind="cards" label="Loading the board" />
    } @else if (ctx.buckets().length === 0) {
      <app-empty-state
        title="This project has no buckets yet"
        text="A PM or Lead adds buckets (the board's columns) in the project settings."
      />
    } @else {
      <div class="columns" cdkDropListGroup>
        @for (column of columns(); track column.id) {
          <section class="column" [attr.aria-label]="column.title">
            <h2>
              <span>{{ column.title }}</span>
              <span class="k-pill count">{{ column.items.length }}</span>
            </h2>
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
                <app-item-card
                  class="open"
                  cdkDrag
                  [cdkDragData]="item"
                  [cdkDragDisabled]="!canDrag(item)"
                  [item]="item"
                  [today]="today"
                  (click)="open($event, item)"
                />
              } @empty {
                @if (filtered()) {
                  <div class="k-empty">
                    <span class="text">{{
                      active() ? 'No cards for ' + assigneeName() + ' here' : 'No matching cards'
                    }}</span>
                  </div>
                }
              }
            </div>
          </section>
        }
      </div>
    }

    <router-outlet />
  `,
})
export class BoardPage implements OnInit, PersonFilter {
  /** Shared project state. */
  protected readonly ctx = inject(ProjectContext);
  private readonly api = inject(ItemsApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(SessionStore);
  private readonly toast = inject(ToastService);

  /** `?sprint=<id>`: show the sprint board (the board filtered to one sprint). */
  readonly sprint = input<string>();

  /** "None" column/filter value for the template. */
  protected readonly none = NONE;
  /** Item types for the template. */
  protected readonly types = Object.values(ItemType);
  /** Type names for the template. */
  protected readonly typeLabels = TYPE_LABELS;
  /** Names of the due filters. */
  protected readonly dueNames: Record<BoardFilter['due'], string> = {
    '': '',
    overdue: 'Overdue',
    week: 'This week',
  };
  /** Longest title accepted. */
  protected readonly titleMax = ITEM_TITLE_MAX;
  /** Today as `YYYY-MM-DD`, for the due filters and due pills. */
  protected readonly today = isoDate(new Date());

  /** What the columns are. */
  protected readonly groupBy = signal<GroupBy>('bucket');
  /** Current filters. */
  protected readonly filter = signal<BoardFilter>(EMPTY_FILTER);
  /** Type of cards created by quick-add. */
  protected readonly quickType = signal<ItemType>(ItemType.TASK);

  /** The person the board is filtered to ({@link PersonFilter}). */
  readonly active = computed(() => {
    const id = this.filter().assigneeId;
    return id === '' || id === NONE ? null : id;
  });

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

  /** True when any filter is set. */
  protected readonly filtered = computed(() => {
    const f = this.filter();
    return Object.values(f).some((v) => v !== '');
  });

  /** Name of the sprint the board is filtered to, for the heading. */
  protected readonly sprintName = computed(() =>
    this.sprint() ? this.sprintFilterName() || null : null,
  );

  /** Name of the sprint filter's value. */
  protected readonly sprintFilterName = computed(() => {
    const id = this.filter().sprintId;
    if (id === NONE) return 'None';
    return id ? (this.ctx.sprintsById().get(id)?.name ?? '') : '';
  });

  /** Name of the assignee filter's value. */
  protected readonly assigneeName = computed(() => {
    const id = this.filter().assigneeId;
    if (id === NONE) return 'Unassigned';
    return id ? (this.ctx.membersById().get(id)?.displayName ?? '') : '';
  });

  /** Name of the label filter's value. */
  protected readonly labelName = computed(() => {
    const id = this.filter().labelId;
    return id ? (this.ctx.labelsById().get(id)?.name ?? '') : '';
  });

  /**
   * Members for the quick person filter: the people with cards on the board
   * first, then others, active members only, plus the filtered person.
   */
  protected readonly quickPeople = computed(() => {
    const counts = new Map<string, number>();
    for (const item of this.ctx.items()) {
      for (const id of item.assigneeIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const active = this.active();
    return this.ctx
      .members()
      .filter((m) => m.isActive || m.userId === active)
      .sort((a, b) => (counts.get(b.userId) ?? 0) - (counts.get(a.userId) ?? 0))
      .filter((m, i) => i < QUICK_PEOPLE || m.userId === active);
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
    const element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const shortcuts = inject(Shortcuts);
    shortcuts.register((key) => {
      if (document.querySelector('.d-panel')) return false;
      const links = [...element.querySelectorAll<HTMLAnchorElement>('app-item-card a.title')];
      if (key === 'j' || key === 'k') {
        const current = links.findIndex((link) => link === document.activeElement);
        const next =
          links[
            current < 0
              ? key === 'j'
                ? 0
                : links.length - 1
              : Math.max(0, Math.min(links.length - 1, current + (key === 'j' ? 1 : -1)))
          ];
        next?.focus();
        next?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return next !== undefined;
      }
      const selected = links.find((link) => link === document.activeElement);
      if (selected && ['m', 'a', 'l'].includes(key)) {
        shortcuts.field.set(key === 'm' ? 'Bucket' : key === 'a' ? 'Assignees' : 'Labels');
        selected.click();
        return true;
      }
      return false;
    }, inject(DestroyRef));
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
    this.ctx.refresh().catch((error: unknown) => this.toast.error(error));
  }

  /**
   * Filters to a person, or clears the person filter ({@link PersonFilter}).
   *
   * @param userId The person.
   */
  toggle(userId: string): void {
    this.setFilter({ assigneeId: this.active() === userId ? '' : userId });
  }

  /**
   * Text of a filter chip: its name, plus the chosen value.
   *
   * @param name Filter name.
   * @param value Chosen value, or empty.
   * @returns The chip text.
   */
  protected chipText(name: string, value: string): string {
    return value ? `${name}: ${value}` : name;
  }

  /**
   * A tick for the chosen menu entry.
   *
   * @param chosen Whether the entry is the current value.
   * @returns "✓" or nothing.
   */
  protected mark(chosen: boolean): string {
    return chosen ? '✓' : '';
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
   * Opens the item drawer for a click on a card outside its links and
   * buttons (those handle themselves: the title link opens the drawer too).
   *
   * @param event The click.
   * @param item The card.
   */
  protected open(event: MouseEvent, item: WorkItemDto): void {
    if ((event.target as HTMLElement | null)?.closest('a, button')) return;
    void this.router.navigate(['items', item.number], {
      relativeTo: this.route,
      queryParamsHandling: 'preserve',
    });
  }

  /**
   * Sends a drop to the API and shows the item the server returns, with a
   * toast offering Undo. The card is placed at once and put back if the API
   * refuses.
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
    // The card it followed before, so Undo can put it back in place.
    const fromIndex = from.items.findIndex((i) => i.id === item.id);
    const previousAfterId = fromIndex > 0 ? (from.items[fromIndex - 1]?.id ?? null) : null;
    if (change.kind === 'move') {
      // Show the card in its new place until the server's answer arrives.
      const others = to.items.filter((i) => i.id !== item.id);
      const before = others[event.currentIndex - 1]?.position ?? (others[0]?.position ?? 1) - 1;
      const after = others[event.currentIndex]?.position ?? before + 2;
      this.ctx.upsert({ ...item, bucketId: to.id, position: (before + after) / 2 });
    }
    try {
      const updated =
        change.kind === 'move'
          ? await this.api.move(project.id, item.id, change.request)
          : await this.api.update(project.id, item.id, change.request);
      this.ctx.upsert(updated);
      if (change.kind === 'move' && from.id === to.id) return;
      this.toast.show(this.describe(item, updated), () =>
        this.undo(project.id, item, updated, previousAfterId),
      );
    } catch (error) {
      this.ctx.upsert(item);
      this.toast.error(error);
    }
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
    try {
      this.ctx.upsert(await this.api.create(project.id, request));
      input.value = '';
    } catch (error) {
      this.toast.error(error);
    }
  }

  /**
   * One sentence about a drop, e.g. "KLO-14 moved to In Progress · status
   * set to In progress".
   *
   * @param before The card before the drop.
   * @param after The card the server returned.
   * @returns The toast text.
   */
  private describe(before: WorkItemDto, after: WorkItemDto): string {
    const parts: string[] = [];
    if (before.bucketId !== after.bucketId) {
      const name = after.bucketId
        ? this.ctx.bucketsById().get(after.bucketId)?.name
        : 'off the board';
      parts.push(`${after.key} moved to ${name ?? 'another bucket'}`);
    }
    if (before.status !== after.status) parts.push(`status set to ${STATUS_LABELS[after.status]}`);
    if (before.sprintId !== after.sprintId) {
      const name = after.sprintId ? this.ctx.sprintsById().get(after.sprintId)?.name : null;
      parts.push(name ? `sprint set to ${name}` : 'removed from its sprint');
    }
    if (revertFields(before, after)?.assigneeIds !== undefined) parts.push('assignees changed');
    if (parts.length === 0) return `${after.key} updated`;
    const text = parts.join(' · ');
    return text.startsWith(after.key) ? text : `${after.key}: ${text}`;
  }

  /**
   * Reverses a drop: moves the card back to its bucket and place, then puts
   * back any field the move or edit changed (a bucket's entry rule may have
   * set the status).
   *
   * @param projectId Project id.
   * @param before The card before the drop.
   * @param after The card after the drop.
   * @param previousAfterId The card it followed before.
   * @returns Resolves once reverted.
   */
  private async undo(
    projectId: string,
    before: WorkItemDto,
    after: WorkItemDto,
    previousAfterId: string | null,
  ): Promise<void> {
    let current = after;
    const move = revertMove(before, after, previousAfterId);
    if (move !== null && before.bucketId !== after.bucketId) {
      current = await this.api.move(projectId, before.id, move);
      this.ctx.upsert(current);
    }
    const fields = undoFields(before, after, current);
    if (fields !== null) this.ctx.upsert(await this.api.update(projectId, before.id, fields));
  }
}
