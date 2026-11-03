import { DOCUMENT } from '@angular/common';
import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { dueNow, type DueNow } from '@kloister/shared';

/**
 * Milliseconds until the next whole minute, plus a little so the new minute
 * has surely begun.
 *
 * @param now The current time in milliseconds.
 * @returns The delay.
 */
export function untilNextMinute(now: number): number {
  return 60_000 - (now % 60_000) + 50;
}

/**
 * Today and the current minute, in the viewer's local time, as signals that
 * stay current while a tab is left open (v1.4.0): due pills ("Due tomorrow",
 * overdue red, "Overdue since 17:00"), calendars and the timeline's today
 * line read it instead of the date they were opened on. It ticks on each new
 * minute, so midnight is noticed within a minute, and again when the tab is
 * shown after sleeping in the background. Loaded with the pages that use it,
 * not with the first page.
 */
@Injectable({ providedIn: 'root' })
export class Today {
  /** The current date and minute; changes only when either changes. */
  readonly now = signal<DueNow>(dueNow(new Date()), {
    equal: (a, b) => a.date === b.date && a.minutes === b.minutes,
  });
  /** Today as `YYYY-MM-DD`; changes once a day. */
  readonly date = computed(() => this.now().date);
  /** Minutes after midnight now, for due times. */
  readonly minutes = computed(() => this.now().minutes);

  /** Starts the minute clock and stops it with the application. */
  constructor() {
    const document = inject(DOCUMENT);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      this.refresh();
      clearTimeout(timer);
      timer = setTimeout(tick, untilNextMinute(Date.now()));
    };
    timer = setTimeout(tick, untilNextMinute(Date.now()));
    // Timers are throttled or paused in background tabs and during sleep.
    const shown = (): void => {
      if (document.visibilityState !== 'hidden') tick();
    };
    document.addEventListener('visibilitychange', shown);
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', shown);
    });
  }

  /** Reads the clock now. */
  refresh(): void {
    this.now.set(dueNow(new Date()));
  }
}
