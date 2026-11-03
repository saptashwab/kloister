import { NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { Router, RouterLink } from '@angular/router';
import { addDays, mondayOf } from '@kloister/shared';
import {
  agenda,
  type CalendarEntry,
  type CalendarRange,
  dayDiff,
  holidayOn,
  layoutWeek,
  monthWeeks,
  shiftDates,
  weekBands,
  weekDays,
} from '../../core/calendar-logic';
import { TYPE_LABELS } from '../../core/labels';
import { shortDay } from '../../core/timeline-logic';
import { Icon } from '../../ui/icon';

/** Month or week. */
export type CalendarMode = 'month' | 'week';

/** A move asked for by drag or keyboard. */
export interface CalendarMove {
  /** The item. */
  entry: CalendarEntry;
  /** Calendar days to move its finish (and start with it). */
  days: number;
}

/** Day names, Monday first. */
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Month names. */
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Loads the calendar's styles with the route that uses it.
 */
@Component({
  selector: 'app-calendar-styles',
  template: '',
  styleUrl: '../../../styles/_calendar.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CalendarStyles {}

/**
 * A month or week calendar of items (SPEC §6.5, docs/M13-PLAN.md §4): spans
 * from start to due in week rows (half days as half cells), holidays shaded
 * and named, sprint bands at the top of each week, Done items dimmed and
 * ad-hoc items tagged. Items the caller may move are dragged to another day
 * or moved with the arrow keys (← → a day, ↑ ↓ a week; Enter saves, Escape
 * cancels); the host saves the move. At phone width it is an agenda by day.
 * Undated items are listed beside it.
 */
@Component({
  selector: 'app-calendar-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The side list and the phone agenda; the grid's styles are in _calendar.scss.
  styles: `
    .c-side {
      flex: 1 1 var(--k-size-280px);
      padding: var(--k-space-3);
      border: var(--k-line) solid var(--k-border);
      border-radius: var(--k-radius-md);
      h3 {
        margin: 0 0 var(--k-space-2);
        font-size: var(--k-body-sm);
      }
    }
    .c-side ul,
    .c-agenda,
    .c-agenda ul {
      display: flex;
      flex-direction: column;
      gap: var(--k-space-2);
      margin: 0;
      padding: 0;
      list-style: none;
      font-size: var(--k-body-sm);
    }
    .c-agenda h3 {
      margin: var(--k-space-2) 0 var(--k-space-1);
      font-size: var(--k-body-sm);
    }
    .c-agenda .c-item {
      display: block;
      padding: var(--k-space-2);
      white-space: normal;
    }
  `,
  imports: [
    NgTemplateOutlet,
    MatButtonModule,
    MatButtonToggleModule,
    RouterLink,
    Icon,
    CalendarStyles,
  ],
  template: `
    <app-calendar-styles />
    <div class="c-tools">
      <button mat-icon-button type="button" aria-label="Earlier" (click)="page(-1)">
        <app-icon name="arrowLeft" />
      </button>
      <button mat-button type="button" (click)="anchor.set(today())">Today</button>
      <button mat-icon-button type="button" aria-label="Later" (click)="page(1)">
        <app-icon name="arrowRight" />
      </button>
      <h2>{{ title() }}</h2>
      <span class="spacer"></span>
      @if (!phone()) {
        <mat-button-toggle-group
          aria-label="Calendar view"
          hideSingleSelectionIndicator
          [value]="mode()"
          (change)="mode.set($event.value)"
        >
          <mat-button-toggle value="month">Month</mat-button-toggle>
          <mat-button-toggle value="week">Week</mat-button-toggle>
        </mat-button-toggle-group>
      }
    </div>
    <p class="visually-hidden" aria-live="polite">{{ announce() }}</p>
    <div class="c-body">
      @if (phone()) {
        <ol class="c-agenda" aria-label="Agenda">
          @for (d of agendaDays(); track d.day) {
            <li>
              <h3 [class.today]="d.day === today()">
                {{ dayTitle(d.day) }}
                @if (holiday(d.day); as h) {
                  <span class="c-hol">{{ h }}</span>
                }
              </h3>
              <ul>
                @for (e of d.entries; track e.id) {
                  <li>
                    <a
                      class="c-item"
                      [class.done]="e.status === 'DONE'"
                      [class.k-pending]="e.pending"
                      [routerLink]="e.link"
                      ><ng-container *ngTemplateOutlet="label; context: { $implicit: e }"
                    /></a>
                  </li>
                }
              </ul>
            </li>
          } @empty {
            <li class="muted">Nothing scheduled in these weeks.</li>
          }
        </ol>
      } @else {
        <div
          class="c-grid"
          [class.week]="mode() === 'week'"
          role="grid"
          [attr.aria-label]="title()"
        >
          <div class="c-dow" role="row">
            @for (d of dayNames; track d) {
              <span role="columnheader">{{ d }}</span>
            }
          </div>
          @for (w of weeks(); track w.monday) {
            <div class="c-week" role="row" [style.--lanes]="w.lanes">
              @for (d of w.days; track d.date; let col = $index) {
                <div
                  role="gridcell"
                  class="c-day"
                  [style.grid-column]="col + 1"
                  [class.out]="d.out"
                  [class.today]="d.date === today()"
                  [class.holiday]="d.holiday !== null"
                  [class.weekend]="col >= 5"
                  [class.drop]="d.date === dropDay()"
                  [attr.data-day]="d.date"
                  [attr.aria-label]="dayTitle(d.date) + (d.holiday ? ', ' + d.holiday : '')"
                >
                  <span class="num">{{ d.number }}</span>
                  @if (d.holiday) {
                    <span class="c-hol">{{ d.holiday }}</span>
                  }
                </div>
              }
              @for (b of w.bands; track b.name) {
                <span
                  class="c-band"
                  [style.grid-column]="b.start + 1 + ' / ' + (b.end + 2)"
                  [attr.title]="b.name"
                  >{{ b.name }}</span
                >
              }
              @for (s of w.segments; track s.entry.id) {
                <button
                  type="button"
                  class="c-item"
                  [class.done]="s.entry.status === 'DONE'"
                  [class.moving]="moving()?.id === s.entry.id"
                  [class.k-pending]="s.entry.pending"
                  [class.before]="s.before"
                  [class.after]="s.after"
                  [class.movable]="s.entry.canMove"
                  [style.grid-column]="s.start + 1 + ' / ' + (s.end + 2)"
                  [style.grid-row]="s.lane + 3"
                  [style.margin-left.%]="s.startHalf ? 50 / (s.end - s.start + 1) : 0"
                  [style.margin-right.%]="s.endHalf ? 50 / (s.end - s.start + 1) : 0"
                  [attr.data-item]="s.entry.id"
                  [attr.aria-label]="itemLabel(s.entry)"
                  [attr.title]="itemLabel(s.entry)"
                  (pointerdown)="grab($event, s.entry)"
                  (click)="open(s.entry)"
                  (keydown)="key($event, s.entry)"
                  (focusout)="leave($event, s.entry)"
                >
                  <ng-container *ngTemplateOutlet="label; context: { $implicit: s.entry }" />
                </button>
              }
            </div>
          }
        </div>
      }
      @if (undated().length > 0) {
        <aside class="c-side" aria-labelledby="c-undated">
          <h3 id="c-undated">Not on the calendar</h3>
          <ul>
            @for (e of undated(); track e.id) {
              <li>
                <a [routerLink]="e.link"
                  ><ng-container *ngTemplateOutlet="label; context: { $implicit: e }"
                /></a>
              </li>
            }
          </ul>
        </aside>
      }
    </div>

    <ng-template #label let-e>
      @if (e.presence) {
        <span class="c-presence" aria-hidden="true"></span>
      }
      <b>{{ e.key }}</b> {{ e.title }}
      @if (e.adHoc) {
        <span class="c-tag">Ad hoc</span>
      }
      @if (e.project) {
        <span class="c-tag">{{ e.project }}</span>
      }
    </ng-template>
  `,
  host: { '(document:pointermove)': 'drag($event)', '(document:pointerup)': 'drop($event)' },
})
export class CalendarView {
  /** Items with dates. */
  readonly entries = input.required<readonly CalendarEntry[]>();
  /** Items without dates, for the side list. */
  readonly undated = input<readonly CalendarEntry[]>([]);
  /** Holidays to shade. */
  readonly holidays = input<readonly CalendarRange[]>([]);
  /** Sprints to band. */
  readonly sprints = input<readonly CalendarRange[]>([]);
  /** Today, `YYYY-MM-DD`. */
  readonly today = input.required<string>();
  /** Phone width: the agenda. */
  readonly phone = input(false);
  /** Emits a move to save. */
  readonly move = output<CalendarMove>();
  /** Emits the item being moved (for presence), or null when done. */
  readonly movingChange = output<string | null>();
  /** Emits the shown range, so the host can load it. */
  readonly rangeChange = output<{ from: string; to: string }>();

  /** Month or week. */
  readonly mode = signal<CalendarMode>('month');
  /** A day of the shown month or week. */
  readonly anchor = signal('');

  protected readonly dayNames = DAY_NAMES;
  /** The day under the pointer while dragging. */
  protected readonly dropDay = signal<string | null>(null);
  /** The item being moved by keyboard, with its pending shift. */
  protected readonly moving = signal<{ id: string; days: number } | null>(null);
  /** What a screen reader hears about a keyboard move. */
  protected readonly announce = signal('');

  private dragging: {
    entry: CalendarEntry;
    from: string;
    x: number;
    y: number;
    started: boolean;
  } | null = null;
  private suppressClick = false;

  /** The anchor, or today before one is chosen. */
  private readonly shown = computed(() => this.anchor() || this.today());

  /** The weeks on screen. */
  private readonly mondays = computed(() =>
    this.mode() === 'week' && !this.phone() ? [mondayOf(this.shown())] : monthWeeks(this.shown()),
  );

  /** The first and last day on screen. */
  readonly range = computed(() => {
    const mondays = this.mondays();
    return { from: mondays[0], to: addDays(mondays[mondays.length - 1], 6) };
  });

  /** The heading: the month, or the week's dates. */
  protected readonly title = computed(() => {
    const shown = this.shown();
    if (this.mode() === 'week' && !this.phone()) {
      const r = this.range();
      return `${shortDay(r.from, this.today())} – ${shortDay(r.to, this.today())}`;
    }
    return `${MONTHS[Number(shown.slice(5, 7)) - 1]} ${shown.slice(0, 4)}`;
  });

  /** The entries, with the keyboard move previewed. */
  private readonly placed = computed(() => {
    const m = this.moving();
    return m === null
      ? this.entries()
      : this.entries().map((e) => (e.id === m.id ? shiftDates(e, m.days) : e));
  });

  /** Each week with its days, bands and item pieces. */
  protected readonly weeks = computed(() => {
    const month = this.shown().slice(0, 7);
    return this.mondays().map((monday) => {
      const segments = layoutWeek(this.placed(), monday);
      return {
        monday,
        days: weekDays(monday).map((date) => ({
          date,
          number: Number(date.slice(8)),
          out: this.mode() === 'month' && date.slice(0, 7) !== month,
          holiday: holidayOn(this.holidays(), date),
        })),
        bands: weekBands(this.sprints(), monday),
        segments,
        lanes: Math.max(1, ...segments.map((s) => s.lane + 1)),
      };
    });
  });

  /** The agenda of the shown month. */
  protected readonly agendaDays = computed(() =>
    agenda(this.entries(), this.range().from, this.range().to),
  );

  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  /** Tells the host every range shown, so it can load it. */
  constructor() {
    effect(() => this.rangeChange.emit(this.range()));
  }

  /**
   * Shows the previous or next month (or week).
   *
   * @param direction -1 or 1.
   */
  protected page(direction: number): void {
    const shown = this.shown();
    if (this.mode() === 'week' && !this.phone()) this.anchor.set(addDays(shown, direction * 7));
    else {
      const first = `${shown.slice(0, 7)}-01`;
      this.anchor.set(
        direction > 0
          ? `${addDays(first, 32).slice(0, 7)}-01`
          : `${addDays(first, -1).slice(0, 7)}-01`,
      );
    }
  }

  /**
   * Starts a possible drag of a movable item.
   *
   * @param event The pointer event.
   * @param entry The item.
   */
  protected grab(event: PointerEvent, entry: CalendarEntry): void {
    if (!entry.canMove || event.button !== 0) return;
    const from = this.dayAt(event.clientX, event.clientY);
    if (from === null) return;
    this.dragging = { entry, from, x: event.clientX, y: event.clientY, started: false };
  }

  /**
   * Follows the pointer while dragging.
   *
   * @param event The pointer event.
   */
  protected drag(event: PointerEvent): void {
    const d = this.dragging;
    if (d === null) return;
    if (!d.started && Math.hypot(event.clientX - d.x, event.clientY - d.y) < 5) return;
    if (!d.started) {
      d.started = true;
      this.movingChange.emit(d.entry.id);
    }
    event.preventDefault();
    this.dropDay.set(this.dayAt(event.clientX, event.clientY));
  }

  /**
   * Ends a drag: a drop on another day asks the host to move the item.
   *
   * @param event The pointer event.
   */
  protected drop(event: PointerEvent): void {
    const d = this.dragging;
    this.dragging = null;
    if (d === null || !d.started) return;
    // The click that ends a drag must not open the item; one that lands
    // elsewhere must not swallow the next real click either.
    this.suppressClick = true;
    setTimeout(() => (this.suppressClick = false));
    const to = this.dayAt(event.clientX, event.clientY);
    this.dropDay.set(null);
    this.movingChange.emit(null);
    if (to !== null && to !== d.from) this.move.emit({ entry: d.entry, days: dayDiff(d.from, to) });
  }

  /**
   * Opens an item, unless the click ends a drag.
   *
   * @param entry The item.
   */
  protected open(entry: CalendarEntry): void {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    void this.router.navigate(entry.link);
  }

  /**
   * Keyboard moves: arrows shift the focused item, Enter saves, Escape cancels.
   *
   * @param event The key event.
   * @param entry The item.
   */
  protected key(event: KeyboardEvent, entry: CalendarEntry): void {
    const steps: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    const m = this.moving();
    if (event.key in steps && entry.canMove) {
      event.preventDefault();
      const days = (m?.id === entry.id ? m.days : 0) + steps[event.key];
      if (m?.id !== entry.id) this.movingChange.emit(entry.id);
      this.moving.set({ id: entry.id, days });
      // The piece may move to another week row and be drawn anew: keep focus on it.
      afterNextRender(() => this.focusItem(entry.id), { injector: this.injector });
      const due = shiftDates(entry, days).dueDate ?? shiftDates(entry, days).startDate ?? '';
      this.announce.set(
        `${entry.key} moves to ${this.dayTitle(due)}. Enter saves, Escape cancels.`,
      );
    } else if (event.key === 'Enter' && m?.id === entry.id) {
      event.preventDefault();
      this.moving.set(null);
      this.movingChange.emit(null);
      if (m.days !== 0) this.move.emit({ entry, days: m.days });
    } else if (event.key === 'Escape' && m?.id === entry.id) {
      event.preventDefault();
      event.stopPropagation();
      this.cancelKeys(entry);
      this.announce.set(`Move of ${entry.key} cancelled.`);
    }
  }

  /**
   * Focuses an item's piece on the calendar.
   *
   * @param id Item id.
   */
  private focusItem(id: string): void {
    const piece = this.host.querySelector<HTMLElement>(`button.c-item[data-item="${id}"]`);
    if (piece !== null && document.activeElement !== piece) piece.focus();
  }

  /**
   * Drops a pending keyboard move when focus leaves the calendar's items;
   * a redraw that moves the piece to another row keeps it.
   *
   * @param event The focus event.
   * @param entry The item.
   */
  protected leave(event: FocusEvent, entry: CalendarEntry): void {
    const next = event.relatedTarget;
    if (next instanceof HTMLElement && next.dataset['item'] === entry.id) return;
    // A removed piece gets no new focus target; wait for the redraw to refocus it.
    if (next === null) return;
    this.cancelKeys(entry);
  }

  /**
   * Drops a pending keyboard move.
   *
   * @param entry The item.
   */
  protected cancelKeys(entry: CalendarEntry): void {
    if (this.moving()?.id !== entry.id) return;
    this.moving.set(null);
    this.movingChange.emit(null);
  }

  /**
   * The day cell under a point.
   *
   * @param x Client x.
   * @param y Client y.
   * @returns The day, or null.
   */
  private dayAt(x: number, y: number): string | null {
    const cell = document
      .elementsFromPoint(x, y)
      .find(
        (el): el is HTMLElement => el instanceof HTMLElement && el.dataset['day'] !== undefined,
      );
    return cell?.dataset['day'] ?? null;
  }

  /**
   * A day as a heading.
   *
   * @param date `YYYY-MM-DD`.
   * @returns E.g. "Mon 2 Nov".
   */
  protected dayTitle(date: string): string {
    if (date === '') return '';
    const weekday = DAY_NAMES[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7];
    return `${weekday} ${shortDay(date, this.today())}`;
  }

  /**
   * The holiday on a day.
   *
   * @param date `YYYY-MM-DD`.
   * @returns Its name, or null.
   */
  protected holiday(date: string): string | null {
    return holidayOn(this.holidays(), date);
  }

  /**
   * An item's accessible name.
   *
   * @param e The item.
   * @returns E.g. "KLO-12 Write docs, Task, 2 Nov to 4 Nov, movable".
   */
  protected itemLabel(e: CalendarEntry): string {
    const dates =
      e.startDate !== null && e.dueDate !== null
        ? `${shortDay(e.startDate, this.today())}${e.startSecondHalf ? ' 2nd half' : ''} to ${shortDay(e.dueDate, this.today())}${e.dueFirstHalf ? ' 1st half' : ''}`
        : `on ${shortDay((e.dueDate ?? e.startDate)!, this.today())}`;
    return [
      `${e.key} ${e.title}`,
      TYPE_LABELS[e.type],
      e.status === 'DONE' ? 'Done' : null,
      e.adHoc ? 'ad hoc' : null,
      e.project,
      dates,
      e.presence,
      e.canMove ? 'arrow keys move it' : null,
    ]
      .filter((p) => p !== null && p !== '')
      .join(', ');
  }
}
