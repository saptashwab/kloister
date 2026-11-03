import { Component, computed, DestroyRef, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  addDays,
  type CalendarItemDto,
  LiveEvent,
  moveFinishTo,
  type MyCalendarDto,
  type ScheduleDates,
  workCalendar,
} from '@kloister/shared';
import { errorMessage } from '../../core/api';
import type { CalendarEntry } from '../../core/calendar-logic';
import { Today } from '../../core/today';
import { ItemsApiService } from '../../core/items-api.service';
import { LiveService } from '../../core/live.service';
import { ReportsApiService } from '../../core/reports-api.service';
import { RescheduleFlow, type RescheduleTarget } from '../../core/reschedule';
import type { WorkFilter } from '../../core/work-logic';
import { phoneLayout } from '../../ui/row-cards';
import { ToastService } from '../../ui/toast.service';
import { CalendarView, type CalendarMove } from './calendar-view';

/** Wait after a live event before reloading, in ms. */
const LIVE_RELOAD_MS = 600;

/**
 * My work › Calendar (SPEC §6.5, docs/M13-PLAN.md §4): the caller's own items
 * across their projects and personal space, with holidays. Moving an item
 * keeps its working duration and goes through its project's reschedule flow
 * (plan setting, dependent moves, Undo); personal tasks and ad-hoc items save
 * their dates directly. The caller's live stream reloads it when their items
 * change.
 */
@Component({
  selector: 'app-work-calendar',
  imports: [CalendarView],
  providers: [RescheduleFlow],
  template: `
    @if (error()) {
      <p class="k-alert" role="alert">{{ error() }}</p>
    }
    <app-calendar-view
      [entries]="entries()"
      [undated]="undated()"
      [holidays]="holidays()"
      [today]="today()"
      [phone]="phone()"
      (rangeChange)="load($event.from, $event.to)"
      (move)="move($event)"
    />
  `,
})
export class WorkCalendar {
  /** The My work filters (source, project, type, label). */
  readonly filter = input.required<WorkFilter>();
  /** Show Done items (dimmed). */
  readonly includeDone = input(false);

  private readonly api = inject(ReportsApiService);
  private readonly items = inject(ItemsApiService);
  private readonly flow = inject(RescheduleFlow);
  private readonly toast = inject(ToastService);

  protected readonly today = inject(Today).date;
  protected readonly phone = phoneLayout();
  protected readonly error = signal('');
  private readonly data = signal<MyCalendarDto | null>(null);
  private range: { from: string; to: string } | null = null;
  private run = 0;

  /** The projects by id. */
  private readonly projects = computed(
    () => new Map((this.data()?.projects ?? []).map((p) => [p.id, p])),
  );

  /**
   * Holidays, named with their project when they are a project's own;
   * instance holidays only when a listed project uses them.
   */
  protected readonly holidays = computed(() =>
    (this.data()?.holidays ?? [])
      .filter(
        (h) =>
          h.projectId !== null || (this.data()?.projects ?? []).some((p) => p.useInstanceHolidays),
      )
      .map((h) => ({
        name:
          h.projectId === null
            ? h.name
            : `${h.name} (${this.projects().get(h.projectId)?.name ?? 'project'})`,
        startDate: h.startDate,
        endDate: h.endDate,
      })),
  );

  /** Dated items that pass the filters. */
  protected readonly entries = computed(() =>
    (this.data()?.items ?? [])
      .filter((i) => this.passes(i) && (this.includeDone() || i.status !== 'DONE'))
      .map((i) => this.entry(i)),
  );

  /** Undated items that pass the filters. */
  protected readonly undated = computed(() =>
    (this.data()?.undated ?? []).filter((i) => this.passes(i)).map((i) => this.entry(i)),
  );

  /** Reloads when the caller's own items change (M10). */
  constructor() {
    const destroy = inject(DestroyRef);
    let timer: ReturnType<typeof setTimeout> | undefined;
    destroy.onDestroy(() => {
      clearTimeout(timer);
      ++this.run;
    });
    inject(LiveService)
      .events.pipe(takeUntilDestroyed(destroy))
      .subscribe((event) => {
        if (
          event.name !== LiveEvent.ITEM_CHANGED &&
          event.name !== LiveEvent.ITEM_REMOVED &&
          event.name !== LiveEvent.RESYNC
        )
          return;
        clearTimeout(timer);
        timer = setTimeout(() => void this.reload(), LIVE_RELOAD_MS);
      });
  }

  /**
   * Loads a range.
   *
   * @param from First day.
   * @param to Last day.
   * @returns Resolves once loaded.
   */
  protected async load(from: string, to: string): Promise<void> {
    this.range = { from, to };
    await this.reload();
  }

  /**
   * Reloads the shown range.
   *
   * @returns Resolves once loaded.
   */
  private async reload(): Promise<void> {
    const range = this.range;
    if (range === null) return;
    const run = ++this.run;
    try {
      const data = await this.api.myCalendar(range.from, range.to);
      if (run !== this.run) return;
      this.data.set(data);
      this.error.set('');
    } catch (error) {
      if (run === this.run) this.error.set(errorMessage(error));
    }
  }

  /**
   * Applies the My work filters that make sense on a calendar.
   *
   * @param i The item.
   * @returns True when shown.
   */
  private passes(i: CalendarItemDto): boolean {
    const f = this.filter();
    const personal = this.projects().get(i.projectId)?.key === null;
    return (
      (f.source === 'ALL' || (f.source === 'PERSONAL') === personal) &&
      (f.projectId === '' || i.projectId === f.projectId) &&
      (f.type === '' || i.type === f.type) &&
      (f.labelId === '' || i.labelIds.includes(f.labelId))
    );
  }

  /**
   * Converts an item to a calendar entry.
   *
   * @param i The item.
   * @returns The entry.
   */
  private entry(i: CalendarItemDto): CalendarEntry {
    const project = this.projects().get(i.projectId);
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
      link: ['/p', project?.key ?? 'personal', 'items', i.number],
      canMove: i.canPlan,
      presence: null,
      project: project === undefined ? null : project.key === null ? 'Personal' : project.name,
    };
  }

  /**
   * Saves a move in the item's own project.
   *
   * @param request The item and how far.
   * @returns Resolves once saved.
   */
  protected async move(request: CalendarMove): Promise<void> {
    const data = this.data();
    const item = data?.items.find((i) => i.id === request.entry.id);
    const project = item === undefined ? undefined : this.projects().get(item.projectId);
    const anchor = item?.dueDate ?? item?.startDate ?? null;
    if (data === null || item === undefined || project === undefined || anchor === null) return;
    // The item's own project calendar: its holidays, plus the instance ones if it uses them.
    const cal = workCalendar(
      data.holidays.filter((h) =>
        h.projectId === null ? project.useInstanceHolidays : h.projectId === item.projectId,
      ),
    );
    const to = moveFinishTo(item, addDays(anchor, request.days), cal);
    if (project.key === null || item.adHoc) {
      await this.saveDirectly(item, to);
      return;
    }
    const target: RescheduleTarget = {
      projectId: project.id,
      autoMove: project.autoMoveDependents,
      canSwitch: project.canSwitch,
      version: (ref) => {
        const found = this.data()?.items.find((i) => i.id === ref || String(i.number) === ref);
        return found === undefined ? undefined : { id: found.id, updatedAt: found.updatedAt };
      },
      store: () => void this.reload(),
      refresh: () => this.reload(),
      switched: () =>
        this.data.update((d) =>
          d === null
            ? d
            : {
                ...d,
                projects: d.projects.map((p) =>
                  p.id === project.id ? { ...p, autoMoveDependents: true } : p,
                ),
              },
        ),
    };
    await this.flow.change([{ item: item.id, ...to }], target);
  }

  /**
   * Saves dates without the planner (personal tasks and ad-hoc items), with Undo.
   *
   * @param item The item.
   * @param to The new dates.
   * @returns Resolves once saved.
   */
  private async saveDirectly(item: CalendarItemDto, to: ScheduleDates): Promise<void> {
    const from: ScheduleDates = {
      startDate: item.startDate,
      startSecondHalf: item.startSecondHalf,
      dueDate: item.dueDate,
      dueFirstHalf: item.dueFirstHalf,
    };
    try {
      await this.items.update(item.projectId, item.id, to);
      await this.reload();
      this.toast.show(`${item.key} moved`, async () => {
        try {
          await this.items.update(item.projectId, item.id, from);
          await this.reload();
        } catch (error) {
          this.toast.error(error);
        }
      });
    } catch (error) {
      this.toast.error(error);
    }
  }
}
