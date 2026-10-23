import { Component, computed, Injectable, input, output } from '@angular/core';
import {
  DateAdapter,
  MAT_DATE_FORMATS,
  type MatDateFormats,
  NativeDateAdapter,
} from '@angular/material/core';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatTimepickerModule } from '@angular/material/timepicker';
import { dayOf, formatDay, parseDay, parseTime } from '../core/format';

/** Display and parse format keys understood by {@link AppDateAdapter}. */
const FORMATS: MatDateFormats = {
  parse: { dateInput: 'day', timeInput: 'time' },
  display: {
    dateInput: 'day',
    monthYearLabel: 'monthYear',
    dateA11yLabel: { year: 'numeric', month: 'long', day: 'numeric' },
    monthYearA11yLabel: { year: 'numeric', month: 'long' },
    timeInput: 'time',
    timeOptionLabel: 'time',
  },
};

/**
 * Date adapter for the app's one date format (DESIGN §15, M8.5): shows
 * "23 Oct 2026", reads that or `2026-10-23`, and uses 24-hour times. Values
 * are local Dates at midnight, so no time zone can shift a calendar day.
 */
@Injectable()
export class AppDateAdapter extends NativeDateAdapter {
  /**
   * Formats a date for the input, the calendar header or a time option.
   *
   * @param date The date.
   * @param displayFormat A key from the formats above, or Intl options.
   * @returns The text.
   */
  override format(date: Date, displayFormat: object | string): string {
    if (displayFormat === 'day') return formatDay(date);
    if (displayFormat === 'monthYear') return formatDay(date).replace(/^\d+ /, '');
    if (displayFormat === 'time')
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return super.format(date, displayFormat);
  }

  /**
   * Reads a typed date.
   *
   * @param value Typed text or a Date.
   * @returns The date, an invalid date for unreadable text, or null when empty.
   */
  override parse(value: unknown): Date | null {
    if (typeof value !== 'string') return super.parse(value);
    if (value.trim() === '') return null;
    const day = parseDay(value);
    return day === null ? this.invalid() : localDay(day);
  }

  /**
   * Reads a typed 24-hour time onto today's date.
   *
   * @param value Typed text or a Date.
   * @returns The time, an invalid date for unreadable text, or null when empty.
   */
  override parseTime(value: unknown): Date | null {
    if (typeof value !== 'string') return super.parseTime(value);
    if (value.trim() === '') return null;
    const time = parseTime(value);
    if (time === null) return this.invalid();
    const date = new Date();
    date.setHours(Number(time.slice(0, 2)), Number(time.slice(3)), 0, 0);
    return date;
  }
}

/**
 * A wire date as a local Date at midnight, for Material date inputs.
 *
 * @param day `YYYY-MM-DD`.
 * @returns The Date.
 */
export function localDay(day: string): Date {
  return new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8)));
}

/** Providers every date or time field needs; kept with the lazy screens that use them. */
export const DATE_PROVIDERS = [
  { provide: DateAdapter, useClass: AppDateAdapter },
  { provide: MAT_DATE_FORMATS, useValue: FORMATS },
];

/**
 * The app's date control (M8.5): a compact text input with a Material
 * calendar, reading and emitting `YYYY-MM-DD`. Typing "23 Oct 2026" or
 * "2026-10-23" works; clearing the text emits null.
 */
@Component({
  selector: 'app-date-field',
  imports: [MatDatepickerModule],
  providers: DATE_PROVIDERS,
  host: { class: 'app-date-field' },
  template: `<input
      class="k-inline"
      type="text"
      autocomplete="off"
      placeholder="d Mmm yyyy"
      [attr.aria-label]="label()"
      [matDatepicker]="picker"
      [min]="minDate()"
      [value]="date()"
      (dateChange)="changed($event.value)"
    /><mat-datepicker-toggle
      [for]="picker"
      [attr.aria-label]="'Choose ' + label()"
    /><mat-datepicker #picker />`,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
    }
    input {
      width: 8.5em;
    }
  `,
})
export class DateField {
  /** Current value, `YYYY-MM-DD` or null. */
  readonly value = input<string | null>(null);
  /** Accessible name of the input, e.g. "Due date". */
  readonly label = input.required<string>();
  /** Earliest selectable date, `YYYY-MM-DD`, or null. */
  readonly min = input<string | null>(null);
  /** Emits the chosen date, or null when cleared. */
  readonly valueChange = output<string | null>();

  /** The value as a local Date for the picker. */
  protected readonly date = computed(() => {
    const value = this.value();
    return value === null ? null : localDay(value);
  });
  /** The minimum as a local Date. */
  protected readonly minDate = computed(() => {
    const min = this.min();
    return min === null ? null : localDay(min);
  });

  /**
   * Emits a valid change; unreadable text is ignored until corrected.
   *
   * @param date The picked or typed date.
   */
  protected changed(date: Date | null): void {
    if (date === null) this.valueChange.emit(null);
    else if (!Number.isNaN(date.getTime())) this.valueChange.emit(dayOf(date));
  }
}

/**
 * The app's due time control (M8.5): a compact 24-hour input with a Material
 * time list, reading and emitting `HH:MM`; clearing it emits null.
 */
@Component({
  selector: 'app-time-field',
  imports: [MatTimepickerModule],
  providers: DATE_PROVIDERS,
  host: { class: 'app-time-field' },
  template: `<input
      class="k-inline"
      type="text"
      autocomplete="off"
      placeholder="hh:mm"
      [attr.aria-label]="label()"
      [matTimepicker]="picker"
      [value]="time()"
      (blur)="typed($any($event.target).value)"
    /><mat-timepicker-toggle
      [for]="picker"
      [attr.aria-label]="'Choose ' + label()"
    /><mat-timepicker #picker interval="30m" (selected)="picked($event.value)" />`,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
    }
    input {
      width: 4.5em;
    }
  `,
})
export class TimeField {
  /** Current value, `HH:MM` or null. */
  readonly value = input<string | null>(null);
  /** Accessible name of the input, e.g. "Due time". */
  readonly label = input.required<string>();
  /** Emits the chosen time, or null when cleared. */
  readonly valueChange = output<string | null>();

  /** The value as a Date for the picker. */
  protected readonly time = computed(() => {
    const value = this.value();
    if (value === null) return null;
    const date = new Date();
    date.setHours(Number(value.slice(0, 2)), Number(value.slice(3)), 0, 0);
    return date;
  });

  /**
   * Emits a time picked from the list.
   *
   * @param date The picked time.
   */
  protected picked(date: Date): void {
    this.emit(
      `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
    );
  }

  /**
   * Emits a typed time when the field loses focus; unreadable text is ignored.
   *
   * @param text What the person typed.
   */
  protected typed(text: string): void {
    if (text.trim() === '') this.emit(null);
    else {
      const time = parseTime(text);
      if (time !== null) this.emit(time);
    }
  }

  /**
   * Emits only real changes.
   *
   * @param time The new time.
   */
  private emit(time: string | null): void {
    // The blur after picking from the list arrives before the parent passes the new value back.
    if (time === this.value() || time === this.lastEmitted) return;
    this.lastEmitted = time;
    this.valueChange.emit(time);
  }

  /** The last time emitted, so a pick followed by blur sends one change. */
  private lastEmitted: string | null | undefined = undefined;
}
