import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  type OnInit,
  signal,
  untracked,
  ViewEncapsulation,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { Router, RouterLink } from '@angular/router';
import {
  addDays,
  ItemStatus,
  mondayOf,
  type OverviewReportDto,
  type PlanHealthReportDto,
  type ReportItemDto,
  type SprintReportDto,
  type WorkloadCellDto,
  WorkloadLevel,
  type WorkloadReportDto,
} from '@kloister/shared';
import { errorMessage } from '../../core/api';
import { dayOf } from '../../core/format';
import { STATUS_LABELS } from '../../core/labels';
import { PageActions } from '../../core/page-actions';
import { ProjectContext } from '../../core/project-context';
import { ReportsApiService } from '../../core/reports-api.service';
import { SessionStore } from '../../core/session.store';
import { shortDay } from '../../core/timeline-logic';
import { EmptyState, Skeleton } from '../../ui/feedback';
import { burndownChart, statusBars } from './report-charts';

/** The dashboards, in tab order. */
type View = 'overview' | 'sprint' | 'workload' | 'health';

/** Least time between two live refreshes, in ms (docs/M13-PLAN.md §3). */
export const REPORT_REFRESH_MS = 2_000;

/** How long "Updated just now" shows after a live refresh, in ms. */
const UPDATED_NOTE_MS = 10_000;

/** Weeks shown in the workload. */
const WEEKS = 8;

/**
 * Loads the reports' styles with the route; global selectors scoped under
 * `app-reports-page` and `app-calendar` keep them within the style budget.
 */
@Component({
  selector: 'app-report-styles',
  template: '',
  styleUrl: '../../../styles/_reports.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportStyles {}

/**
 * Project › Reports (SPEC §6.5, docs/M13-PLAN.md §3): Overview, Sprint,
 * Workload and Plan health, each a page of tiles and one chart with the
 * numbers in a table beside it. The API computes every number from the
 * caller's visible items; personal spaces show Overview and Workload only.
 * While open, item, sprint, link and holiday changes from the live stream
 * reload the shown dashboard, at most once every two seconds.
 */
@Component({
  selector: 'app-reports-page',
  imports: [
    NgTemplateOutlet,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatSelectModule,
    RouterLink,
    EmptyState,
    Skeleton,
    ReportStyles,
  ],
  template: `
    <app-report-styles />
    <div class="r-head">
      <mat-button-toggle-group
        aria-label="Dashboard"
        hideSingleSelectionIndicator
        [value]="current()"
        (change)="show($event.value)"
      >
        @for (v of views(); track v.id) {
          <mat-button-toggle [value]="v.id">{{ v.label }}</mat-button-toggle>
        }
      </mat-button-toggle-group>
      @if (current() === 'sprint' && ctx.sprints().length > 0) {
        <mat-form-field subscriptSizing="dynamic">
          <mat-label>Sprint</mat-label>
          <mat-select [value]="sprintId() ?? ''" (valueChange)="chooseSprint($event)">
            <mat-option value="">Active sprint</mat-option>
            @for (s of ctx.sprints(); track s.id) {
              <mat-option [value]="s.id">{{ s.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      }
      @if (current() === 'workload') {
        <div class="r-weeks" role="group" aria-label="Weeks">
          <button mat-button type="button" (click)="shiftWeeks(-4)">Earlier</button>
          <button mat-button type="button" (click)="from.set(thisMonday)">This week</button>
          <button mat-button type="button" (click)="shiftWeeks(4)">Later</button>
        </div>
      }
      <span class="spacer"></span>
      <span class="r-note" aria-live="polite">{{ updatedNote() }}</span>
    </div>

    @if (error()) {
      <p class="k-alert" role="alert">{{ error() }}</p>
    } @else if (loading()) {
      <app-skeleton label="Loading the report" />
    } @else {
      @switch (current()) {
        @case ('overview') {
          @if (overview(); as o) {
            <div class="r-tiles">
              <a class="r-tile" [routerLink]="boardLink()" [queryParams]="{ due: 'overdue' }">
                <b>{{ o.overdue }}</b
                ><span>Overdue</span>
              </a>
              <a class="r-tile" [routerLink]="boardLink()" [queryParams]="{ due: 'week' }">
                <b>{{ o.dueThisWeek }}</b
                ><span>Due this week</span>
              </a>
              <a
                class="r-tile"
                [routerLink]="backlogLink()"
                [queryParams]="{ show: 'done-recent' }"
              >
                <b>{{ o.doneRecently }}</b
                ><span>Done in the last 14 days</span>
              </a>
              <a class="r-tile" [routerLink]="backlogLink()" [queryParams]="{ show: 'ad-hoc' }">
                <b>{{ o.adHocOpen }}</b
                ><span>Open ad-hoc items</span>
              </a>
            </div>
            <div class="r-grid">
              <section>
                <h2>Items by status</h2>
                <table class="r-table">
                  <caption class="visually-hidden">
                    Visible items by status
                  </caption>
                  <tbody>
                    @for (bar of statusBars(o); track bar.label) {
                      <tr>
                        <th scope="row">{{ bar.label }}</th>
                        <td class="num">{{ bar.value }}</td>
                        <td class="bar">
                          <svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
                            <rect [attr.width]="bar.width" height="10" [attr.class]="bar.tone" />
                          </svg>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </section>
              <section>
                <h2>Open items per bucket</h2>
                <table class="r-table">
                  <tbody>
                    @for (b of o.openByBucket; track b.bucketId) {
                      <tr>
                        <th scope="row">{{ b.name }}</th>
                        <td class="num">{{ b.count }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </section>
            </div>
          }
        }
        @case ('sprint') {
          @if (sprint(); as s) {
            @if (s.sprint === null) {
              <app-empty-state
                title="No active sprint"
                text="Start a sprint, or choose one above, to see its progress."
              />
            } @else {
              <div class="r-tiles">
                <a
                  class="r-tile"
                  [routerLink]="boardLink()"
                  [queryParams]="{ sprint: s.sprint.id }"
                >
                  <b>{{ s.items.done }} / {{ s.items.done + s.items.remaining }}</b
                  ><span>Items done</span>
                </a>
                <div class="r-tile">
                  <b>{{ s.days.remaining }}</b
                  ><span>Working days left in items</span>
                </div>
                <div class="r-tile">
                  <b>{{ s.sprintDays.elapsed }} / {{ s.sprintDays.total }}</b
                  ><span>Sprint days passed</span>
                </div>
                <div class="r-tile">
                  <b>{{ s.added.length }} · {{ s.removed.length }}</b
                  ><span>Added · removed after the start</span>
                </div>
              </div>
              <section>
                <h2>Burndown of {{ s.sprint.name }}</h2>
                @if (burndown(s); as chart) {
                  <svg
                    class="r-chart"
                    [attr.viewBox]="'0 0 ' + chart.width + ' ' + chart.height"
                    aria-hidden="true"
                  >
                    <line
                      class="axis"
                      x1="0"
                      [attr.y1]="chart.height"
                      [attr.x2]="chart.width"
                      [attr.y2]="chart.height"
                    />
                    <polyline class="ideal" [attr.points]="chart.ideal" />
                    <polyline class="actual" [attr.points]="chart.actual" />
                    @for (p of chart.dots; track p.x) {
                      <circle class="actual" [attr.cx]="p.x" [attr.cy]="p.y" r="3" />
                    }
                    <text x="0" y="12">{{ chart.max }} days</text>
                  </svg>
                  <p class="r-legend">
                    <span class="actual">Remaining working days</span>
                    <span class="ideal">Ideal</span>
                  </p>
                }
                <details>
                  <summary>Numbers</summary>
                  <table class="r-table">
                    <thead>
                      <tr>
                        <th scope="col">Day</th>
                        <th scope="col">Remaining</th>
                        <th scope="col">Ideal</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (p of s.burndown; track p.date) {
                        <tr>
                          <th scope="row">{{ day(p.date) }}</th>
                          <td class="num">{{ p.remaining ?? '–' }}</td>
                          <td class="num">{{ p.ideal }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </details>
              </section>
              <div class="r-grid">
                <section>
                  <h2>Added after the start</h2>
                  <ng-container
                    *ngTemplateOutlet="list; context: { $implicit: changed(s.added) }"
                  />
                </section>
                <section>
                  <h2>Removed after the start</h2>
                  <ng-container
                    *ngTemplateOutlet="list; context: { $implicit: changed(s.removed) }"
                  />
                </section>
                <section>
                  <h2>At risk: due after the sprint ends</h2>
                  <ng-container *ngTemplateOutlet="list; context: { $implicit: s.atRisk }" />
                </section>
              </div>
            }
          }
        }
        @case ('workload') {
          @if (workload(); as w) {
            <div class="r-scroll">
              <table class="r-table r-load">
                <caption class="visually-hidden">
                  Planned working days per person and week; amber from 80%, red above 100%
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    @for (week of w.weeks; track week.start) {
                      <th scope="col">
                        {{ day(week.start) }}<br /><small>{{ week.available }} days</small>
                      </th>
                    }
                  </tr>
                </thead>
                <tbody>
                  @for (row of w.rows; track row.userId) {
                    <tr>
                      <th scope="row">
                        @if (row.userId !== null && !personal()) {
                          <a [routerLink]="boardLink()" [queryParams]="{ assignee: row.userId }">{{
                            personName(row.userId)
                          }}</a>
                        } @else {
                          {{ personName(row.userId) }}
                        }
                      </th>
                      @for (cell of row.cells; track $index) {
                        <td>
                          <button
                            type="button"
                            class="r-cell"
                            [class]="'r-cell ' + cell.level"
                            [attr.aria-pressed]="isChosen(row.userId, $index)"
                            [attr.aria-label]="cellLabel(row.userId, $index, cell)"
                            (click)="choose(row.userId, $index)"
                          >
                            @if (cell.planned > 0) {
                              {{ cell.planned }} d
                              @if (cell.load !== null) {
                                <small>{{ percent(cell.load) }}</small>
                              }
                              @if (cell.level === over) {
                                <small>over</small>
                              }
                            } @else {
                              <span class="muted">–</span>
                            }
                          </button>
                        </td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <p class="r-legend">
              <span class="high">Amber: 80–100% of the week's working days</span>
              <span class="over">Red: over 100% (overallocated)</span>
            </p>
            @if (chosenCell(); as c) {
              <section class="r-detail" aria-live="polite">
                <h2>{{ personName(c.userId) }}, week of {{ day(c.week) }}</h2>
                @if (c.cell.entries.length === 0) {
                  <p class="muted">Nothing planned.</p>
                } @else {
                  <ul class="r-list">
                    @for (e of c.cell.entries; track e.item.id) {
                      <li>
                        <a [routerLink]="itemLink(e.item)">{{ e.item.key }}</a> {{ e.item.title }}
                        <span class="muted"
                          >{{ e.days }} days{{ e.share === 100 ? '' : ' × ' + e.share + '%' }}</span
                        >
                      </li>
                    }
                  </ul>
                }
              </section>
            }
          }
        }
        @case ('health') {
          @if (health(); as h) {
            <div class="r-tiles">
              <a class="r-tile" [routerLink]="boardLink()" [queryParams]="{ due: 'overdue' }">
                <b>{{ h.pastDue.length }}</b
                ><span>Past due</span>
              </a>
              <a class="r-tile" [routerLink]="timelineLink()">
                <b>{{ h.conflicts.length }}</b
                ><span>Start before their predecessors finish</span>
              </a>
              <a class="r-tile" [routerLink]="timelineLink()">
                <b>{{ h.undatedInSprint.length }}</b
                ><span>Undated in the active sprint</span>
              </a>
              <a class="r-tile" [routerLink]="timelineLink()">
                <b>{{ h.pinnedLate.length }}</b
                ><span>Held later by a pin</span>
              </a>
            </div>
            <div class="r-grid">
              <section>
                <h2>Past due</h2>
                <ng-container *ngTemplateOutlet="list; context: { $implicit: h.pastDue }" />
              </section>
              <section>
                <h2>Start before their predecessors finish</h2>
                <ul class="r-list">
                  @for (c of h.conflicts; track c.item.id) {
                    <li>
                      <a [routerLink]="timelineLink()" [queryParams]="{ item: c.item.number }">{{
                        c.item.key
                      }}</a>
                      {{ c.item.title }}
                      <span class="muted">after {{ keys(c.predecessors) }}</span>
                    </li>
                  } @empty {
                    <li class="muted">None.</li>
                  }
                </ul>
              </section>
              <section>
                <h2>
                  Stories and Tasks without dates in
                  {{ h.sprint?.name ?? 'the active sprint' }}
                </h2>
                <ng-container *ngTemplateOutlet="list; context: { $implicit: h.undatedInSprint }" />
              </section>
              <section>
                <h2>Held later by their pin</h2>
                <ul class="r-list">
                  @for (p of h.pinnedLate; track p.item.id) {
                    <li>
                      <a [routerLink]="timelineLink()" [queryParams]="{ item: p.item.number }">{{
                        p.item.key
                      }}</a>
                      {{ p.item.title }}
                      <span class="muted"
                        >pinned to {{ day(p.pin.date)
                        }}{{ p.earliest ? ', could start ' + day(p.earliest.date) : '' }}</span
                      >
                    </li>
                  } @empty {
                    <li class="muted">None.</li>
                  }
                </ul>
              </section>
            </div>
          }
        }
      }
    }

    <ng-template #list let-items>
      <ul class="r-list">
        @for (i of items; track i.id) {
          <li>
            <a [routerLink]="itemLink(i)">{{ i.key }}</a> {{ i.title }}
            @if (i.dueDate) {
              <span class="muted">due {{ day(i.dueDate) }}</span>
            }
          </li>
        } @empty {
          <li class="muted">None.</li>
        }
      </ul>
    </ng-template>
  `,
})
export class ReportsPage implements OnInit {
  /** Shared project state. */
  protected readonly ctx = inject(ProjectContext);
  private readonly api = inject(ReportsApiService);
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);

  /** `?view=`: the dashboard to show, e.g. from a link. */
  readonly view = input<string>();

  /** Today's Monday, for "This week". */
  protected readonly thisMonday = mondayOf(dayOf(new Date()));
  /** The workload's first week. */
  protected readonly from = signal(this.thisMonday);
  /** The chosen sprint, or null for the active one. */
  protected readonly sprintId = signal<string | null>(null);
  /** The shown dashboard. */
  protected readonly current = signal<View>('overview');
  /** The workload cell whose items are listed. */
  protected readonly chosen = signal<{ userId: string | null; index: number } | null>(null);

  protected readonly overview = signal<OverviewReportDto | null>(null);
  protected readonly sprint = signal<SprintReportDto | null>(null);
  protected readonly workload = signal<WorkloadReportDto | null>(null);
  protected readonly health = signal<PlanHealthReportDto | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  /** "Updated just now" after a live refresh changed the numbers. */
  protected readonly updatedNote = signal('');
  /** The "over" level, for the template. */
  protected readonly over = WorkloadLevel.OVER;

  /** Personal spaces have Overview and Workload only. */
  protected readonly personal = computed(() => (this.ctx.project()?.ownerId ?? null) !== null);

  /** The dashboards this space offers. */
  protected readonly views = computed(() =>
    [
      { id: 'overview' as const, label: 'Overview' },
      { id: 'sprint' as const, label: 'Sprint', projectOnly: true },
      { id: 'workload' as const, label: 'Workload' },
      { id: 'health' as const, label: 'Plan health', projectOnly: true },
    ].filter((v) => !this.personal() || !v.projectOnly),
  );

  /** The chosen workload cell with its data. */
  protected readonly chosenCell = computed(() => {
    const pick = this.chosen();
    const w = this.workload();
    if (pick === null || w === null) return null;
    const row = w.rows.find((r) => r.userId === pick.userId);
    const cell = row?.cells[pick.index];
    const week = w.weeks[pick.index];
    return cell === undefined || week === undefined
      ? null
      : { userId: pick.userId, week: week.start, cell };
  });

  private ready = false;
  private lastLoad = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private noteTimer: ReturnType<typeof setTimeout> | undefined;
  private run = 0;

  /** Registers the export action and the live refresh. */
  constructor() {
    inject(PageActions).register(() => ({ source: this.ctx.project()?.id ?? '', filters: {} }));
    effect(() => {
      const v = this.view();
      untracked(() => {
        if (v === 'overview' || v === 'sprint' || v === 'workload' || v === 'health')
          this.current.set(v);
      });
    });
    effect(() => {
      // Any change to the project's items, sprints or links (also holidays,
      // which reload the project) refreshes the shown dashboard.
      this.ctx.items();
      this.ctx.sprints();
      this.ctx.linksVersion();
      untracked(() => {
        if (this.ready) this.scheduleRefresh();
      });
    });
    effect(() => {
      this.from();
      this.sprintId();
      untracked(() => {
        if (this.ready) void this.load(false);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.refreshTimer);
      clearTimeout(this.noteTimer);
    });
  }

  /**
   * Loads the project's lists (for live updates and names), then the report.
   */
  ngOnInit(): void {
    void (async () => {
      try {
        await this.ctx.refresh();
      } catch (error) {
        this.error.set(errorMessage(error));
        return;
      }
      if (!this.views().some((v) => v.id === this.current())) this.current.set('overview');
      await this.load(false);
      this.ready = true;
    })();
  }

  /**
   * Shows another dashboard and remembers it in the address.
   *
   * @param view The dashboard.
   */
  protected show(view: View): void {
    this.current.set(view);
    this.chosen.set(null);
    void this.router.navigate([], { queryParams: { view }, replaceUrl: true });
    void this.load(false);
  }

  /**
   * Chooses the sprint to report on.
   *
   * @param id Sprint id, or '' for the active sprint.
   */
  protected chooseSprint(id: string): void {
    this.sprintId.set(id === '' ? null : id);
  }

  /**
   * Moves the workload's weeks.
   *
   * @param weeks Weeks to move; negative goes back.
   */
  protected shiftWeeks(weeks: number): void {
    this.from.update((f) => addDays(f, weeks * 7));
    this.chosen.set(null);
  }

  /**
   * Lists or hides a workload cell's items.
   *
   * @param userId The row's person, or null for unassigned work.
   * @param index The week.
   */
  protected choose(userId: string | null, index: number): void {
    this.chosen.set(this.isChosen(userId, index) ? null : { userId, index });
  }

  /**
   * Reports whether a workload cell is the listed one.
   *
   * @param userId The row's person.
   * @param index The week.
   * @returns True when listed.
   */
  protected isChosen(userId: string | null, index: number): boolean {
    const c = this.chosen();
    return c !== null && c.userId === userId && c.index === index;
  }

  /**
   * Refreshes after a live change, at most once every two seconds.
   */
  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) return;
    const wait = Math.max(0, this.lastLoad + REPORT_REFRESH_MS - Date.now());
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.load(true);
    }, wait);
  }

  /**
   * Loads the shown dashboard.
   *
   * @param live True for a refresh after a live change: no skeleton, and a
   *   note when the numbers changed.
   * @returns Resolves once loaded.
   */
  private async load(live: boolean): Promise<void> {
    const project = this.ctx.project();
    if (project === null) return;
    const run = ++this.run;
    this.lastLoad = Date.now();
    if (!live) this.loading.set(true);
    try {
      const view = this.current();
      const before = JSON.stringify(this.data(view));
      switch (view) {
        case 'overview':
          this.overview.set(await this.api.overview(project.id));
          break;
        case 'sprint':
          this.sprint.set(await this.api.sprint(project.id, this.sprintId()));
          break;
        case 'workload':
          this.workload.set(await this.api.workload(project.id, this.from(), WEEKS));
          break;
        case 'health':
          this.health.set(await this.api.planHealth(project.id));
          break;
      }
      if (run !== this.run) return;
      this.error.set('');
      if (live && JSON.stringify(this.data(view)) !== before) {
        this.updatedNote.set('Updated just now');
        clearTimeout(this.noteTimer);
        this.noteTimer = setTimeout(() => this.updatedNote.set(''), UPDATED_NOTE_MS);
      }
    } catch (error) {
      if (run === this.run) this.error.set(errorMessage(error));
    } finally {
      if (run === this.run) this.loading.set(false);
    }
  }

  /**
   * The loaded data of a dashboard.
   *
   * @param view The dashboard.
   * @returns Its data, or null.
   */
  private data(view: View): unknown {
    return {
      overview: this.overview,
      sprint: this.sprint,
      workload: this.workload,
      health: this.health,
    }[view]();
  }

  /** The board of this space. */
  protected boardLink(): unknown[] {
    return ['/p', this.ctx.project()?.key ?? 'personal'];
  }

  /** The backlog of this space. */
  protected backlogLink(): unknown[] {
    return [...this.boardLink(), 'backlog'];
  }

  /** The timeline of this project. */
  protected timelineLink(): unknown[] {
    return [...this.boardLink(), 'timeline'];
  }

  /**
   * An item's drawer beside the board.
   *
   * @param item The item.
   * @returns The route.
   */
  protected itemLink(item: ReportItemDto): unknown[] {
    return [...this.boardLink(), 'items', item.number];
  }

  /**
   * A person's name for a workload row.
   *
   * @param userId User id, or null for unassigned work.
   * @returns The name.
   */
  protected personName(userId: string | null): string {
    if (userId === null) return 'Unassigned';
    if (this.personal()) return this.session.user()?.displayName ?? 'You';
    return this.ctx.membersById().get(userId)?.displayName ?? 'Former member';
  }

  /**
   * The accessible name of a workload cell.
   *
   * @param userId The row's person.
   * @param index The week.
   * @param cell The cell.
   * @returns E.g. "Ann, week of 2 Nov: 4.5 of 5 days, 90%, amber".
   */
  protected cellLabel(userId: string | null, index: number, cell: WorkloadCellDto): string {
    const week = this.workload()?.weeks[index];
    const level =
      cell.level === WorkloadLevel.OVER
        ? ', red: overallocated'
        : cell.level === WorkloadLevel.HIGH
          ? ', amber'
          : '';
    const load = cell.load === null ? 'no working days' : this.percent(cell.load);
    return `${this.personName(userId)}, week of ${this.day(week?.start ?? '')}: ${cell.planned} of ${week?.available ?? 0} days, ${load}${level}. Show items`;
  }

  /**
   * A load as a percentage.
   *
   * @param load 0.5 for 50%.
   * @returns E.g. "50%".
   */
  protected percent(load: number): string {
    return `${Math.round(load * 100)}%`;
  }

  /**
   * A short date.
   *
   * @param date `YYYY-MM-DD`.
   * @returns E.g. "2 Nov".
   */
  protected day(date: string): string {
    return date === '' ? '' : shortDay(date, dayOf(new Date()));
  }

  /**
   * The keys of some items.
   *
   * @param items The items.
   * @returns E.g. "KLO-1, KLO-4".
   */
  protected keys(items: readonly ReportItemDto[]): string {
    return items.map((i) => i.key).join(', ');
  }

  /**
   * The items of sprint changes.
   *
   * @param changes The changes.
   * @returns Their items.
   */
  protected changed(changes: readonly { item: ReportItemDto }[]): ReportItemDto[] {
    return changes.map((c) => c.item);
  }

  /**
   * The status bars of the Overview.
   *
   * @param o The overview.
   * @returns One bar per status.
   */
  protected statusBars(o: OverviewReportDto): ReturnType<typeof statusBars> {
    return statusBars(
      Object.values(ItemStatus).map((s) => ({
        status: s,
        label: STATUS_LABELS[s],
        value: o.byStatus[s],
      })),
    );
  }

  /**
   * The burndown chart of a sprint.
   *
   * @param s The sprint report.
   * @returns The chart's shapes, or null without days.
   */
  protected burndown(s: SprintReportDto): ReturnType<typeof burndownChart> {
    return burndownChart(s.burndown);
  }
}
