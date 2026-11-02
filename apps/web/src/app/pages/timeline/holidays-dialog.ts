import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { HOLIDAY_NAME_MAX, type HolidayDto, type ProjectHolidaysDto } from '@kloister/shared';
import { errorMessage } from '../../core/api';
import { formatDay } from '../../core/format';
import { HolidaysApiService } from '../../core/holidays-api.service';
import { ProjectsApiService } from '../../core/projects-api.service';
import { filter } from 'rxjs';
import { DateField } from '../../ui/date-field';
import { Icon } from '../../ui/icon';

/** What the dialog shows. */
export interface HolidaysDialogData {
  /** Project id. */
  projectId: string;
  /** The project's holidays when opened. */
  info: ProjectHolidaysDto;
  /** The caller may add and remove project holidays (PMs and Leads). */
  canManage: boolean;
  /** The caller may switch the instance holidays on or off (PMs). */
  canSwitch: boolean;
  /** `YYYY-MM-DD`. */
  today: string;
}

/** What changed, so affected items can keep their working days. */
export interface HolidaysDialogResult {
  /** Project holidays added or removed. */
  changed: { startDate: string; endDate: string }[];
  /** The new instance switch, when it changed. */
  useInstanceHolidays?: boolean;
}

/**
 * The project's holidays (SPEC §6.4, M9.1): instance holidays read-only, the
 * project's own added or removed by PMs and Leads, and the PM switch for the
 * instance holidays. Closing returns what changed; the timeline then keeps
 * the affected items' working days through the reschedule flow.
 */
@Component({
  selector: 'app-holidays-dialog',
  imports: [
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    DateField,
    Icon,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      display: flex;
      align-items: center;
      gap: var(--k-space-2);
      padding: var(--k-space-2) 0;
      border-bottom: var(--k-line) solid var(--k-border);
    }
    .name {
      flex: 1;
    }
    form {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--k-space-2);
      margin-top: var(--k-space-4);
    }
  `,
  template: `
    <h2 mat-dialog-title>Holidays</h2>
    <mat-dialog-content>
      <p>Holidays are not working days: durations and dependent moves skip them.</p>
      @if (data.canSwitch) {
        <mat-checkbox [checked]="useInstance()" (change)="switchInstance($event.checked)">
          Use the instance-wide holidays set by administrators
        </mat-checkbox>
      }
      @if (holidays().length === 0) {
        <p class="muted">No holidays yet.</p>
      } @else {
        <ul aria-label="Holidays">
          @for (h of holidays(); track h.id) {
            <li>
              <span class="name">{{ h.name }}</span>
              <span>{{ range(h) }}</span>
              @if (h.scope === 'INSTANCE') {
                <span class="k-pill">Instance</span>
              } @else if (data.canManage) {
                <button
                  type="button"
                  class="k-icon-btn"
                  [attr.aria-label]="'Remove ' + h.name"
                  (click)="remove(h)"
                >
                  <app-icon name="trash" />
                </button>
              }
            </li>
          }
        </ul>
      }
      @if (data.canManage) {
        <form (ngSubmit)="add()">
          <mat-form-field subscriptSizing="dynamic">
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
          <button mat-flat-button type="submit" [disabled]="busy()">Add holiday</button>
        </form>
      }
      @if (error()) {
        <p class="k-alert" role="alert">{{ error() }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-flat-button type="button" (click)="done()">Done</button>
    </mat-dialog-actions>
  `,
})
export class HolidaysDialog {
  /** What the dialog shows. */
  protected readonly data = inject<HolidaysDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<HolidaysDialog, HolidaysDialogResult>>(MatDialogRef);
  private readonly api = inject(HolidaysApiService);
  private readonly projects = inject(ProjectsApiService);

  /** Longest name. */
  protected readonly nameMax = HOLIDAY_NAME_MAX;
  /** The project's calendar, kept current while the dialog is open. */
  protected readonly holidays = signal<HolidayDto[]>(this.data.info.holidays);
  /** The instance switch. */
  protected readonly useInstance = signal(this.data.info.useInstanceHolidays);
  /** New holiday name. */
  protected name = '';
  /** New holiday's first day. */
  protected readonly start = signal<string | null>(null);
  /** New holiday's last day; the first day when not set. */
  protected readonly end = signal<string | null>(null);
  /** A request is running. */
  protected readonly busy = signal(false);
  /** The last error. */
  protected readonly error = signal('');
  private readonly changed: { startDate: string; endDate: string }[] = [];
  private switched: boolean | undefined;

  /**
   * Closing by Escape or outside the dialog reports the changes too, since
   * they are already saved and the timeline must follow them.
   */
  constructor() {
    this.ref.disableClose = true;
    this.ref
      .backdropClick()
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.done());
    this.ref
      .keydownEvents()
      .pipe(
        filter((e) => e.key === 'Escape'),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.done());
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
   * Adds a project holiday.
   *
   * @returns Resolves once added.
   */
  protected async add(): Promise<void> {
    const startDate = this.start();
    const endDate = this.end() ?? startDate;
    if (this.name.trim() === '' || startDate === null || endDate === null) {
      this.error.set('Give the holiday a name and its days');
      return;
    }
    await this.run(async () => {
      const added = await this.api.addToProject(this.data.projectId, {
        name: this.name.trim(),
        startDate,
        endDate,
      });
      this.holidays.update((list) =>
        [...list, added].sort((a, b) => a.startDate.localeCompare(b.startDate)),
      );
      this.changed.push({ startDate, endDate });
      this.name = '';
      this.start.set(null);
      this.end.set(null);
    });
  }

  /**
   * Removes a project holiday.
   *
   * @param h The holiday.
   * @returns Resolves once removed.
   */
  protected async remove(h: HolidayDto): Promise<void> {
    await this.run(async () => {
      await this.api.removeFromProject(this.data.projectId, h.id);
      this.holidays.update((list) => list.filter((x) => x.id !== h.id));
      this.changed.push({ startDate: h.startDate, endDate: h.endDate });
    });
  }

  /**
   * Switches the instance holidays on or off for the project (PMs).
   *
   * @param on Use them.
   * @returns Resolves once saved.
   */
  protected async switchInstance(on: boolean): Promise<void> {
    await this.run(async () => {
      await this.projects.update(this.data.projectId, { settings: { useInstanceHolidays: on } });
      this.useInstance.set(on);
      this.switched = on;
      this.holidays.set((await this.api.forProject(this.data.projectId)).holidays);
    });
  }

  /**
   * Closes the dialog with what changed.
   */
  protected done(): void {
    this.ref.close({
      changed: this.changed,
      ...(this.switched === undefined ? {} : { useInstanceHolidays: this.switched }),
    });
  }

  /**
   * Runs a request, showing a refusal in the dialog.
   *
   * @param work The request.
   * @returns Resolves when done.
   */
  private async run(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await work();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}
