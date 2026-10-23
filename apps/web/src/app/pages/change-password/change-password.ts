import { Component, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Router } from '@angular/router';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@kloister/shared';
import { errorMessage } from '../../core/api';
import { required } from '../../core/validators';
import { AuthService } from '../../core/auth.service';
import { SessionStore } from '../../core/session.store';
import { ThemeService } from '../../core/theme.service';

/**
 * Password change screen. Forced after login with a temporary password
 * (SPEC §5) and also reachable from the header. Changing the password ends
 * the user's other sessions.
 */
@Component({
  selector: 'app-change-password',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  template: `
    <mat-card class="auth-card">
      <mat-card-header
        ><mat-card-title
          ><h1>Change your {{ theme.appName() }} password</h1></mat-card-title
        ></mat-card-header
      >
      <mat-card-content>
        @if (forced()) {
          <p>You signed in with a temporary password. Choose a new one to continue.</p>
        }
        <form [formGroup]="form" (ngSubmit)="submit()">
          <mat-form-field>
            <mat-label>Current password</mat-label>
            <input
              matInput
              type="password"
              formControlName="currentPassword"
              autocomplete="current-password"
            />
          </mat-form-field>
          <mat-form-field>
            <mat-label>New password</mat-label>
            <input
              matInput
              type="password"
              formControlName="newPassword"
              autocomplete="new-password"
            />
            <mat-hint>At least {{ minLength }} characters.</mat-hint>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Repeat new password</mat-label>
            <input matInput type="password" formControlName="confirm" autocomplete="new-password" />
          </mat-form-field>
          @if (error()) {
            <p class="error" role="alert">{{ error() }}</p>
          }
          <button mat-flat-button type="submit" [disabled]="form.invalid || busy()">
            Change password
          </button>
        </form>
      </mat-card-content>
    </mat-card>
  `,
})
export class ChangePasswordPage {
  /** Branding shown in the heading; the sign-in pages retry it if its first load timed out. */
  protected readonly theme = inject(ThemeService);

  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly store = inject(SessionStore);

  /** Shown in the hint. */
  protected readonly minLength = PASSWORD_MIN_LENGTH;
  /** True when the user cannot do anything else until they change it. */
  protected readonly forced = computed(() => this.store.user()?.mustChangePassword === true);
  /** Password form. */
  protected readonly form = inject(NonNullableFormBuilder).group({
    currentPassword: ['', [required]],
    newPassword: [
      '',
      [
        required,
        Validators.minLength(PASSWORD_MIN_LENGTH),
        Validators.maxLength(PASSWORD_MAX_LENGTH),
      ],
    ],
    confirm: ['', [required]],
  });
  /** Last error message, if any. */
  protected readonly error = signal('');
  /** True while the request is in flight. */
  protected readonly busy = signal(false);

  /**
   * Submits the change and returns to the home page.
   *
   * @returns Resolves when navigation has started or the error is shown.
   */
  protected async submit(): Promise<void> {
    const { currentPassword, newPassword, confirm } = this.form.getRawValue();
    if (newPassword !== confirm) {
      this.error.set('The new passwords do not match.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.changePassword({ currentPassword, newPassword });
      await this.router.navigate(['/']);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}
