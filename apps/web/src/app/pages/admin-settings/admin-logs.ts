import { Component, inject, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { LOG_RETENTION_LIMITS } from '@kloister/shared';
import { SettingsApiService } from '../../core/settings-api.service';
import { wholeNumber } from '../../core/validators';
import { ToastService } from '../../ui/toast.service';

/**
 * Admin log retention (SPEC §6 logs, §9.5): how many days of the daily
 * backend and backup log files the app keeps before its nightly clean-up
 * deletes them.
 *
 * Permissions: admin route; the API refuses everyone else.
 */
@Component({
  selector: 'app-admin-logs',
  host: { class: 'k-tab' },
  imports: [ReactiveFormsModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  template: `
    <form class="k-panel" [formGroup]="form" (ngSubmit)="save()" aria-labelledby="logs-title">
      <h2 id="logs-title">Log retention</h2>
      <p class="lead">
        The server writes one backend log file and one backup log file per day, in the logs folder
        of the app (backend-YYYY-MM-DD.log and backup-YYYY-MM-DD.log). Every night at 03:45 server
        time, files older than the days below are deleted. Install and upgrade logs are kept.
      </p>
      <div class="k-fields">
        <mat-form-field>
          <mat-label>Keep logs for (days)</mat-label>
          <input matInput type="number" formControlName="retentionDays" />
        </mat-form-field>
      </div>
      <div class="k-actions">
        <button mat-flat-button type="submit" [disabled]="form.invalid || busy()">
          Save log retention
        </button>
      </div>
    </form>
  `,
})
export class AdminLogsPage implements OnInit {
  private readonly api = inject(SettingsApiService);
  private readonly toast = inject(ToastService);

  /** True while saving. */
  protected readonly busy = signal(false);

  /** The form, with the API's range. */
  protected readonly form = inject(NonNullableFormBuilder).group({
    retentionDays: [30, wholeNumber(LOG_RETENTION_LIMITS)],
  });

  /**
   * Loads the retention.
   */
  ngOnInit(): void {
    void this.api.logs().then(
      (value) => this.form.setValue(value),
      (error: unknown) => this.toast.error(error),
    );
  }

  /**
   * Saves the retention.
   *
   * @returns Resolves once saved.
   */
  protected async save(): Promise<void> {
    if (this.form.invalid) return;
    this.busy.set(true);
    try {
      const retentionDays = Number(this.form.getRawValue().retentionDays);
      this.form.setValue(await this.api.saveLogs({ retentionDays }));
      this.toast.show('Log retention saved');
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.busy.set(false);
    }
  }
}
