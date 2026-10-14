import { DatePipe } from '@angular/common';
import { Component, DestroyRef, inject, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import {
  BACKUP_RETENTION_LIMITS,
  BACKUP_TIME_PATTERN,
  type BackupRunDto,
  type BackupsDto,
  BackupTrigger,
} from '@kloister/shared';
import { formatSize } from '../../core/format';
import { SettingsApiService } from '../../core/settings-api.service';
import { required, wholeNumber } from '../../core/validators';
import { EmptyState, Skeleton } from '../../ui/feedback';
import { Icon } from '../../ui/icon';
import { ToastService } from '../../ui/toast.service';

/** How often the page asks whether a running backup has finished. */
const POLL_MS = 2000;

/**
 * Admin backups (SPEC §6 backups, §9.1): the daily Postgres backup (on or
 * off, time, days kept), "run now", the last results and the backup files
 * on the server. While a backup runs the page checks every two seconds and
 * reports the result in a toast.
 *
 * Permissions: admin route; the API refuses everyone else and audits every
 * change and run.
 */
@Component({
  selector: 'app-admin-backups',
  host: { class: 'k-tab' },
  imports: [
    DatePipe,
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSlideToggleModule,
    EmptyState,
    Icon,
    Skeleton,
  ],
  template: `
    @if (status(); as status) {
      <section class="k-panel" aria-labelledby="backup-now-title">
        <h2 id="backup-now-title">Database backups</h2>
        <p class="lead">
          A full copy of the database (pg_dump, custom format) in the backups folder. Attachments
          are files on disk and are not part of it.
        </p>
        <dl class="k-facts">
          <div>
            <dt>Status</dt>
            <dd role="status">{{ status.running ? 'Backing up…' : 'Idle' }}</dd>
          </div>
          <div>
            <dt>Next backup</dt>
            <dd>
              {{ status.nextRunAt ? (status.nextRunAt | date: 'medium') + ' (your time)' : 'Off' }}
            </dd>
          </div>
          <div>
            <dt>Folder</dt>
            <dd class="mono">{{ status.folder }}</dd>
          </div>
        </dl>
        <div class="k-actions">
          <button mat-flat-button type="button" [disabled]="status.running" (click)="runNow()">
            <app-icon name="play" />Run now
          </button>
        </div>
      </section>

      <form class="k-panel" [formGroup]="form" (ngSubmit)="save()" aria-labelledby="schedule-title">
        <h2 id="schedule-title">Schedule</h2>
        <mat-slide-toggle formControlName="enabled">Back up every day</mat-slide-toggle>
        <div class="k-fields">
          <mat-form-field>
            <mat-label>Time (server time)</mat-label>
            <input matInput type="time" formControlName="time" />
          </mat-form-field>
          <mat-form-field>
            <mat-label>Keep backups for (days)</mat-label>
            <input matInput type="number" formControlName="retentionDays" />
            <mat-hint>Older backups are deleted after each successful one.</mat-hint>
          </mat-form-field>
        </div>
        <div class="k-actions">
          <button mat-flat-button type="submit" [disabled]="form.invalid || busy()">
            Save schedule
          </button>
        </div>
      </form>

      <section class="k-panel" aria-labelledby="runs-title">
        <h2 id="runs-title">Last results</h2>
        @if (status.runs.length === 0) {
          <app-empty-state title="No backups yet" text="Run one now or wait for the schedule." />
        } @else {
          <div class="k-table-scroll">
            <table class="data" aria-labelledby="runs-title">
              <thead>
                <tr>
                  <th scope="col">Result</th>
                  <th scope="col">Started</th>
                  <th scope="col">Started by</th>
                  <th scope="col">Size</th>
                  <th scope="col">File or error</th>
                </tr>
              </thead>
              <tbody>
                @for (run of status.runs; track run.id) {
                  <tr>
                    <td>
                      <span
                        class="k-pill"
                        [class.success]="run.succeeded"
                        [class.danger]="!run.succeeded"
                      >
                        <app-icon [name]="run.succeeded ? 'check' : 'alert'" [size]="14" />{{
                          run.succeeded ? 'Succeeded' : 'Failed'
                        }}
                      </span>
                    </td>
                    <td>{{ run.startedAt | date: 'medium' }}</td>
                    <td>{{ run.trigger === manual ? 'Run now' : 'Schedule' }}</td>
                    <td>{{ run.sizeBytes === null ? '' : size(run.sizeBytes) }}</td>
                    <td class="mono">
                      {{ run.succeeded ? run.file : run.error }}
                      @if (run.pruned > 0) {
                        <span class="muted"> · {{ run.pruned }} old deleted</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <section class="k-panel" aria-labelledby="files-title">
        <h2 id="files-title">Backup files</h2>
        @if (status.files.length === 0) {
          <app-empty-state title="No backup files" text="Backups appear here once one has run." />
        } @else {
          <div class="k-table-scroll">
            <table class="data" aria-labelledby="files-title">
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Size</th>
                  <th scope="col">Written</th>
                </tr>
              </thead>
              <tbody>
                @for (file of status.files; track file.name) {
                  <tr>
                    <td class="mono">{{ file.name }}</td>
                    <td>{{ size(file.sizeBytes) }}</td>
                    <td>{{ file.modifiedAt | date: 'medium' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    } @else {
      <app-skeleton label="Loading the backups" [rows]="4" />
    }
  `,
})
export class AdminBackupsPage implements OnInit {
  private readonly api = inject(SettingsApiService);
  private readonly toast = inject(ToastService);

  /** The screen's data. */
  protected readonly status = signal<BackupsDto | null>(null);
  /** True while saving the schedule. */
  protected readonly busy = signal(false);
  /** "Run now" trigger, for the template. */
  protected readonly manual = BackupTrigger.MANUAL;
  /** Formats a size. */
  protected readonly size = formatSize;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private watching = false;

  /** The schedule form, with the API's checks. */
  protected readonly form = inject(NonNullableFormBuilder).group({
    enabled: [true],
    time: ['02:00', [required, Validators.pattern(BACKUP_TIME_PATTERN)]],
    retentionDays: [14, wholeNumber(BACKUP_RETENTION_LIMITS)],
  });

  /**
   * Stops checking when the page is left.
   */
  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  /**
   * Loads the screen's data.
   */
  ngOnInit(): void {
    void this.refresh(true);
  }

  /**
   * Starts a backup and follows it until it finishes.
   *
   * @returns Resolves once started.
   */
  protected async runNow(): Promise<void> {
    try {
      this.status.set(await this.api.runBackup());
      this.toast.show('Backup started');
      this.watching = true;
      this.schedule();
    } catch (error) {
      this.toast.error(error);
    }
  }

  /**
   * Saves the schedule.
   *
   * @returns Resolves once saved.
   */
  protected async save(): Promise<void> {
    if (this.form.invalid) return;
    const v = this.form.getRawValue();
    this.busy.set(true);
    try {
      const status = await this.api.saveBackupSettings({
        enabled: v.enabled,
        time: v.time,
        retentionDays: Number(v.retentionDays),
      });
      this.status.set(status);
      this.form.setValue(status.settings);
      this.toast.show('Backup schedule saved');
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Reloads the data; while a backup runs, checks again shortly and reports
   * its result when it ends.
   *
   * @param fillForm Whether to load the schedule into the form.
   * @returns Resolves once loaded.
   */
  private async refresh(fillForm = false): Promise<void> {
    try {
      const status = await this.api.backups();
      this.status.set(status);
      if (fillForm) this.form.setValue(status.settings);
      if (status.running) {
        this.schedule();
      } else if (this.watching) {
        this.watching = false;
        this.report(status.runs[0]);
      }
    } catch (error) {
      this.toast.error(error);
    }
  }

  /**
   * Checks again after a short wait.
   */
  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), POLL_MS);
  }

  /**
   * Reports the result of a backup that just ended.
   *
   * @param run The newest run.
   */
  private report(run: BackupRunDto | undefined): void {
    if (run === undefined) return;
    if (run.succeeded) this.toast.show(`Backup finished: ${run.file ?? ''}`);
    else this.toast.error(`Backup failed: ${run.error ?? 'unknown error'}`);
  }
}
