import { Component, inject, type OnInit, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { SECURITY_LIMITS, type SecuritySettingsDto } from '@kloister/shared';
import { formatMinutes } from '../../core/format';
import { SettingsApiService } from '../../core/settings-api.service';
import { wholeNumber } from '../../core/validators';
import { Skeleton } from '../../ui/feedback';
import { ToastService } from '../../ui/toast.service';

/**
 * Admin security settings (SPEC §5, §6): session idle and absolute timeouts
 * and the lockout after failed sign-ins. The idle timeout applies at once;
 * a new absolute timeout applies to sign-ins from then on, since each
 * session's end is fixed when it starts.
 *
 * Permissions: admin route; the API refuses everyone else.
 */
@Component({
  selector: 'app-admin-security',
  host: { class: 'k-tab' },
  imports: [ReactiveFormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, Skeleton],
  template: `
    @if (!loaded()) {
      <app-skeleton label="Loading the security settings" [rows]="3" />
    } @else {
      <form class="k-panel" [formGroup]="form" (ngSubmit)="save()" aria-labelledby="sessions-title">
        <h2 id="sessions-title">Sessions</h2>
        <p class="lead">
          Signed-in sessions end after a time without activity, and in any case some time after
          signing in. A new absolute timeout applies to sign-ins from now on.
        </p>
        <div class="k-fields">
          <mat-form-field>
            <mat-label>Idle timeout (minutes)</mat-label>
            <input matInput type="number" formControlName="idleTimeoutMinutes" />
            <mat-hint>{{ duration(values()?.idleTimeoutMinutes) }}</mat-hint>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Absolute timeout (minutes)</mat-label>
            <input matInput type="number" formControlName="absoluteTimeoutMinutes" />
            <mat-hint>{{ duration(values()?.absoluteTimeoutMinutes) }}</mat-hint>
          </mat-form-field>
        </div>

        <h2>Lockout</h2>
        <p class="lead">Repeated wrong passwords lock an account for a while.</p>
        <div class="k-fields">
          <mat-form-field>
            <mat-label>Failed sign-ins before a lockout</mat-label>
            <input matInput type="number" formControlName="lockoutThreshold" />
          </mat-form-field>
          <mat-form-field>
            <mat-label>Lockout length (minutes)</mat-label>
            <input matInput type="number" formControlName="lockoutMinutes" />
            <mat-hint>{{ duration(values()?.lockoutMinutes) }}</mat-hint>
          </mat-form-field>
        </div>
        @if (inconsistent()) {
          <p class="k-alert" role="alert">
            The absolute timeout must be at least the idle timeout.
          </p>
        }
        <div class="k-actions">
          <button mat-flat-button type="submit" [disabled]="form.invalid || busy()">
            Save security settings
          </button>
        </div>
      </form>
    }
  `,
})
export class AdminSecurityPage implements OnInit {
  private readonly api = inject(SettingsApiService);
  private readonly toast = inject(ToastService);

  /** True once the settings have loaded. */
  protected readonly loaded = signal(false);
  /** True while saving. */
  protected readonly busy = signal(false);

  /** The form, with the API's ranges. */
  protected readonly form = inject(NonNullableFormBuilder).group({
    idleTimeoutMinutes: [480, wholeNumber(SECURITY_LIMITS.idleTimeoutMinutes)],
    absoluteTimeoutMinutes: [10_080, wholeNumber(SECURITY_LIMITS.absoluteTimeoutMinutes)],
    lockoutThreshold: [5, wholeNumber(SECURITY_LIMITS.lockoutThreshold)],
    lockoutMinutes: [15, wholeNumber(SECURITY_LIMITS.lockoutMinutes)],
  });

  /** The form's values as they change. */
  protected readonly values = toSignal(this.form.valueChanges);

  /**
   * Loads the settings.
   */
  ngOnInit(): void {
    void this.load();
  }

  /**
   * True when the absolute timeout is shorter than the idle timeout.
   *
   * @returns The check.
   */
  protected inconsistent(): boolean {
    const v = this.form.getRawValue();
    return Number(v.absoluteTimeoutMinutes) < Number(v.idleTimeoutMinutes);
  }

  /**
   * A field's minutes in words.
   *
   * @param minutes The value.
   * @returns E.g. "8 hours".
   */
  protected duration(minutes: number | undefined): string {
    return minutes === undefined ? '' : formatMinutes(Number(minutes));
  }

  /**
   * Saves the form.
   *
   * @returns Resolves once saved.
   */
  protected async save(): Promise<void> {
    if (this.form.invalid || this.inconsistent()) return;
    const v = this.form.getRawValue();
    const value: SecuritySettingsDto = {
      idleTimeoutMinutes: Number(v.idleTimeoutMinutes),
      absoluteTimeoutMinutes: Number(v.absoluteTimeoutMinutes),
      lockoutThreshold: Number(v.lockoutThreshold),
      lockoutMinutes: Number(v.lockoutMinutes),
    };
    this.busy.set(true);
    try {
      this.form.setValue(await this.api.saveSecurity(value));
      this.toast.show('Security settings saved');
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Loads the stored settings into the form.
   *
   * @returns Resolves once loaded.
   */
  private async load(): Promise<void> {
    try {
      this.form.setValue(await this.api.security());
    } catch (error) {
      this.toast.error(error);
    }
    this.loaded.set(true);
  }
}
