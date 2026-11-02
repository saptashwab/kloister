import { Component, inject, type OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { HOLIDAY_NAME_MAX, type HolidayDto } from '@kloister/shared';
import { formatDay } from '../../core/format';
import { HolidaysApiService } from '../../core/holidays-api.service';
import { DateField } from '../../ui/date-field';
import { Dialogs } from '../../ui/dialogs';
import { Icon } from '../../ui/icon';
import { ToastService } from '../../ui/toast.service';

/**
 * Instance-wide holidays (SPEC §6.4, M9.1): whole days that are not working
 * days on every project timeline that uses them. Adding or removing one
 * moves no project item; each project's PMs and Leads then choose to keep
 * durations or dates.
 *
 * Permissions: admin route; the API refuses everyone else.
 */
@Component({
  selector: 'app-admin-holidays',
  host: { class: 'k-tab' },
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, DateField, Icon],
  styles: `
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      display: flex;
      align-items: center;
      gap: var(--k-space-3);
      padding: var(--k-space-2) 0;
      border-bottom: var(--k-line) solid var(--k-border);
    }
    .name {
      flex: 1;
    }
  `,
  template: `
    <section class="k-panel" aria-labelledby="holidays-title">
      <h2 id="holidays-title">Holidays</h2>
      <p class="lead">
        Whole days that are not working days on project timelines: durations and dependent moves
        skip them. Projects can switch these off and add their own. Changes here move no items; each
        project's PMs and Leads choose to keep durations or dates.
      </p>
      @if (holidays().length === 0) {
        <p class="muted">No instance holidays yet.</p>
      } @else {
        <ul aria-label="Instance holidays">
          @for (h of holidays(); track h.id) {
            <li>
              <span class="name">{{ h.name }}</span>
              <span>{{ range(h) }}</span>
              <button
                type="button"
                class="k-icon-btn"
                [attr.aria-label]="'Remove ' + h.name"
                (click)="remove(h)"
              >
                <app-icon name="trash" />
              </button>
            </li>
          }
        </ul>
      }
      <form class="k-fields" (ngSubmit)="add()">
        <mat-form-field>
          <mat-label>Name</mat-label>
          <input matInput name="name" [(ngModel)]="name" [maxlength]="nameMax" required />
        </mat-form-field>
        <span>From</span>
        <app-date-field label="First day" [value]="start()" (valueChange)="start.set($event)" />
        <span>to</span>
        <app-date-field
          label="Last day"
          [value]="end() ?? start()"
          [min]="start()"
          (valueChange)="end.set($event)"
        />
        <div class="k-actions">
          <button mat-flat-button type="submit" [disabled]="busy()">Add holiday</button>
        </div>
      </form>
    </section>
  `,
})
export class AdminHolidaysPage implements OnInit {
  private readonly api = inject(HolidaysApiService);
  private readonly toast = inject(ToastService);
  private readonly dialogs = inject(Dialogs);

  /** Longest name. */
  protected readonly nameMax = HOLIDAY_NAME_MAX;
  /** The instance holidays. */
  protected readonly holidays = signal<HolidayDto[]>([]);
  /** New holiday name. */
  protected name = '';
  /** New holiday's first day. */
  protected readonly start = signal<string | null>(null);
  /** New holiday's last day; the first day when not set. */
  protected readonly end = signal<string | null>(null);
  /** True while saving. */
  protected readonly busy = signal(false);

  /**
   * Loads the holidays.
   */
  ngOnInit(): void {
    void this.api.listInstance().then(
      (list) => this.holidays.set(list),
      (error: unknown) => this.toast.error(error),
    );
  }

  /**
   * A holiday's days as text.
   *
   * @param h The holiday.
   * @returns E.g. "24 Dec 2026 – 26 Dec 2026".
   */
  protected range(h: HolidayDto): string {
    return h.startDate === h.endDate
      ? formatDay(h.startDate)
      : `${formatDay(h.startDate)} – ${formatDay(h.endDate)}`;
  }

  /**
   * Adds an instance holiday.
   *
   * @returns Resolves once added.
   */
  protected async add(): Promise<void> {
    const startDate = this.start();
    const endDate = this.end() ?? startDate;
    if (this.name.trim() === '' || startDate === null || endDate === null) {
      this.toast.show('Give the holiday a name and its days');
      return;
    }
    this.busy.set(true);
    try {
      const added = await this.api.addInstance({ name: this.name.trim(), startDate, endDate });
      this.holidays.update((list) =>
        [...list, added].sort((a, b) => a.startDate.localeCompare(b.startDate)),
      );
      this.name = '';
      this.start.set(null);
      this.end.set(null);
      this.toast.show(`${added.name} added`);
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Removes an instance holiday after a confirmation.
   *
   * @param h The holiday.
   * @returns Resolves once removed.
   */
  protected async remove(h: HolidayDto): Promise<void> {
    const ok = await this.dialogs.confirm({
      title: `Remove ${h.name}?`,
      message:
        'Project timelines that use instance holidays will count these days as working days again.',
      confirm: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.removeInstance(h.id);
      this.holidays.update((list) => list.filter((x) => x.id !== h.id));
    } catch (error) {
      this.toast.error(error);
    }
  }
}
