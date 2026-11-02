import {
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  type OnInit,
  signal,
  untracked,
} from '@angular/core';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { RouterOutlet } from '@angular/router';
import {
  addDays,
  type ProjectDto,
  ItemStatus,
  ItemType,
  moveFinishTo,
  PresenceAction,
  type ScheduleDates,
  workCalendar,
  type WorkItemDto,
} from '@kloister/shared';
import { errorMessage } from '../../core/api';
import { NONE } from '../../core/board-logic';
import type { CalendarEntry, CalendarRange } from '../../core/calendar-logic';
import { dayOf } from '../../core/format';
import { HolidaysApiService } from '../../core/holidays-api.service';
import { ItemsApiService } from '../../core/items-api.service';
import { TYPE_LABELS } from '../../core/labels';
import { presenceLine } from '../../core/live-logic';
import { PageActions } from '../../core/page-actions';
import { ReportsApiService } from '../../core/reports-api.service';
import { type ItemHold, ProjectContext } from '../../core/project-context';
import { RescheduleFlow } from '../../core/reschedule';
import { SessionStore } from '../../core/session.store';
import { Skeleton } from '../../ui/feedback';
import { phoneLayout } from '../../ui/row-cards';
import { ToastService } from '../../ui/toast.service';
import { CalendarView, type CalendarMove } from './calendar-view';

/** Most undated items listed beside the calendar. */
const UNDATED_MAX = 100;

/**
 * Project › Calendar (SPEC §6.5, docs/M13-PLAN.md §4): the project's visible
 * items on their dates, with holidays and sprints. It reads the shared
 * project store, so live changes show at once. Moving an item changes its
 * due date and start, keeping the working duration, through the timeline's
 * reschedule flow (plan setting, dependent moves, Undo); ad-hoc items and
 * personal spaces, which have no timeline, save the dates directly with Undo.
 * Filters: assignee, type, label, sprint and "My items".
 */
@Component({
  selector: 'app-calendar-page',
  imports: [
    MatFormFieldModule,
    MatSelectModule,
    MatSlideToggleModule,
    RouterOutlet,
    Skeleton,
    CalendarView,
  ],
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--k-space-3);
      padding: var(--k-space-4) var(--k-gutter);
    }
    .filters {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--k-space-2);
    }
  `,
  template: `
    <div class="filters" role="group" aria-label="Filters">
      @if (!personal()) {
        <mat-form-field subscriptSizing="dynamic">
          <mat-label>Assignee</mat-label>
          <mat-select [value]="assignee()" (valueChange)="assignee.set($event)">
            <mat-option value="">Anyone</mat-option>
            <mat-option [value]="none">Unassigned</mat-option>
            @for (m of ctx.members(); track m.userId) {
              <mat-option [value]="m.userId">{{ m.displayName }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      }
      <mat-form-field subscriptSizing="dynamic">
        <mat-label>Type</mat-label>
        <mat-select [value]="type()" (valueChange)="type.set($event)">
          <mat-option value="">Any type</mat-option>
          @for (t of types; track t) {
            <mat-option [value]="t">{{ typeLabels[t] }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field subscriptSizing="dynamic">
        <mat-label>Label</mat-label>
        <mat-select [value]="label()" (valueChange)="label.set($event)">
          <mat-option value="">Any label</mat-option>
          @for (l of ctx.labels(); track l.id) {
            <mat-option [value]="l.id">{{ l.name }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field subscriptSizing="dynamic">
        <mat-label>Sprint</mat-label>
        <mat-select [value]="sprint()" (valueChange)="sprint.set($event)">
          <mat-option value="">Any sprint</mat-option>
          <mat-option [value]="none">No sprint</mat-option>
          @for (s of ctx.sprints(); track s.id) {
            <mat-option [value]="s.id">{{ s.name }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      @if (!personal()) {
        <mat-slide-toggle [checked]="mine()" (change)="mine.set($event.checked)"
          >My items</mat-slide-toggle
        >
      }
    </div>
    @if (error()) {
      <p class="k-alert" role="alert">{{ error() }}</p>
    } @else if (!ctx.loaded()) {
      <app-skeleton label="Loading the calendar" />
    } @else {
      <app-calendar-view
        [entries]="entries()"
        [undated]="undated()"
        [holidays]="holidays()"
        [sprints]="sprintRanges()"
        [today]="today"
        [phone]="phone()"
        (move)="move($event)"
        (movingChange)="moving($event)"
      />
    }
    <router-outlet />
  `,
})
export class CalendarPage implements OnInit {
  /** Shared project state. */
  protected readonly ctx = inject(ProjectContext);
  private readonly api = inject(ItemsApiService);
  private readonly holidaysApi = inject(HolidaysApiService);
  private readonly reportsApi = inject(ReportsApiService);
  private readonly flow = inject(RescheduleFlow);
  private readonly session = inject(SessionStore);
  private readonly toast = inject(ToastService);

  protected readonly none = NONE;
  protected readonly types = Object.values(ItemType);
  protected readonly typeLabels = TYPE_LABELS;
  protected readonly today = dayOf(new Date());
  protected readonly phone = phoneLayout();

  protected readonly assignee = signal('');
  protected readonly type = signal('');
  protected readonly label = signal('');
  protected readonly sprint = signal('');
  protected readonly mine = signal(false);
  protected readonly error = signal('');
  private readonly holidayList = signal<CalendarRange[]>([]);
  private hold: ItemHold | null = null;

  /** Personal spaces have no assignees. */
  protected readonly personal = computed(() => (this.ctx.project()?.ownerId ?? null) !== null);

  /** The project's working calendar. */
  private readonly calendar = computed(() => workCalendar(this.holidayList()));

  /** Holidays, shaded. */
  protected readonly holidays = computed(() => this.holidayList());

  /** Sprints, banded. */
  protected readonly sprintRanges = computed(() =>
    this.ctx.sprints().map((s) => ({ name: s.name, startDate: s.startDate, endDate: s.endDate })),
  );

  /** The visible items that pass the filters. */
  private readonly filtered = computed(() => {
    const me = this.session.user()?.id ?? '';
    const assignee = this.assignee();
    const type = this.type();
    const label = this.label();
    const sprint = this.sprint();
    const mine = this.mine();
    return this.ctx
      .items()
      .filter(
        (i) =>
          (assignee === '' ||
            (assignee === NONE ? i.assigneeIds.length === 0 : i.assigneeIds.includes(assignee))) &&
          (type === '' || i.type === type) &&
          (label === '' || i.labelIds.includes(label)) &&
          (sprint === '' || (sprint === NONE ? i.sprintId === null : i.sprintId === sprint)) &&
          (!mine || i.assigneeIds.includes(me)),
      );
  });

  /** Dated items, as calendar entries. */
  protected readonly entries = computed(() =>
    this.filtered()
      .filter((i) => i.startDate !== null || i.dueDate !== null)
      .map((i) => this.entry(i)),
  );

  /** Open items without dates, for "Not on the calendar". */
  protected readonly undated = computed(() =>
    this.filtered()
      .filter((i) => i.startDate === null && i.dueDate === null && i.status !== ItemStatus.DONE)
      .slice(0, UNDATED_MAX)
      .map((i) => this.entry(i)),
  );

  /** Registers the export action and reloads holidays with the project. */
  constructor() {
    inject(PageActions).register(() => ({ source: this.ctx.project()?.id ?? '', filters: {} }));
    inject(DestroyRef).onDestroy(() => void this.hold?.release());
    effect(() => {
      // The project is set again on every reload, also after holiday changes.
      const project = this.ctx.project();
      untracked(() => {
        if (project !== null) void this.loadHolidays(project);
      });
    });
  }

  /** Loads the project's lists; live updates keep them current. */
  ngOnInit(): void {
    this.ctx.refresh().catch((error: unknown) => this.error.set(errorMessage(error)));
  }

  /**
   * Converts an item to a calendar entry.
   *
   * @param i The item.
   * @returns The entry.
   */
  private entry(i: WorkItemDto): CalendarEntry {
    const people = this.ctx.presenceByItem().get(i.id);
    return {
      id: i.id,
      key: i.key,
      title: i.title,
      type: i.type,
      status: i.status,
      adHoc: i.adHoc,
      startDate: i.startDate,
      startSecondHalf: i.startSecondHalf,
      dueDate: i.dueDate,
      dueFirstHalf: i.dueFirstHalf,
      link: ['/p', this.ctx.project()?.key ?? 'personal', 'calendar', 'items', i.number],
      canMove: this.ctx.writable() && this.ctx.canPlan(i),
      presence: people === undefined ? null : presenceLine(people, this.ctx.membersById()),
      project: null,
    };
  }

  /**
   * Loads the space's holidays. A personal space has no holiday settings of
   * its own; its calendar is the instance holidays (when it uses them), read
   * through the caller's own calendar.
   *
   * @param project The project or personal space.
   * @returns Resolves once loaded.
   */
  private async loadHolidays(project: ProjectDto): Promise<void> {
    try {
      if (project.ownerId === null) {
        this.holidayList.set((await this.holidaysApi.forProject(project.id)).holidays);
        return;
      }
      if (!project.settings.useInstanceHolidays) {
        this.holidayList.set([]);
        return;
      }
      const mine = await this.reportsApi.myCalendar(this.today, this.today);
      this.holidayList.set(mine.holidays.filter((h) => h.projectId === null));
    } catch {
      // Holidays only shade the calendar; without them it still works.
      this.holidayList.set([]);
    }
  }

  /**
   * Shows that the caller is moving an item (presence), and holds live
   * changes to it until the move ends.
   *
   * @param id The item, or null when the move ended.
   */
  protected moving(id: string | null): void {
    void this.hold?.release();
    this.hold = id === null ? null : this.ctx.hold(id, PresenceAction.MOVING);
  }

  /**
   * Saves a move: the finish moves by the days asked and the start keeps the
   * working duration.
   *
   * @param request The item and how far.
   * @returns Resolves once saved.
   */
  protected async move(request: CalendarMove): Promise<void> {
    const item = this.ctx.itemsById().get(request.entry.id);
    const anchor = item?.dueDate ?? item?.startDate ?? null;
    if (item === undefined || anchor === null) return;
    const to = moveFinishTo(item, addDays(anchor, request.days), this.calendar());
    if (this.personal() || item.adHoc) {
      await this.saveDirectly(item, to);
      return;
    }
    await this.flow.change([{ item: item.id, ...to }]);
  }

  /**
   * Saves dates without the planner (personal spaces and ad-hoc items, which
   * have no timeline), with Undo.
   *
   * @param item The item.
   * @param to The new dates.
   * @returns Resolves once saved.
   */
  private async saveDirectly(item: WorkItemDto, to: ScheduleDates): Promise<void> {
    const project = this.ctx.project();
    if (project === null) return;
    const from: ScheduleDates = {
      startDate: item.startDate,
      startSecondHalf: item.startSecondHalf,
      dueDate: item.dueDate,
      dueFirstHalf: item.dueFirstHalf,
    };
    try {
      this.ctx.upsert(await this.api.update(project.id, item.id, to));
      this.toast.show(`${item.key} moved`, async () => {
        try {
          this.ctx.upsert(await this.api.update(project.id, item.id, from));
        } catch (error) {
          this.toast.error(error);
        }
      });
    } catch (error) {
      this.toast.error(error);
    }
  }
}
