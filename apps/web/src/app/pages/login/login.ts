import { Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Router } from '@angular/router';
import { errorMessage } from '../../core/api';
import { required } from '../../core/validators';
import { AuthService } from '../../core/auth.service';
import { ThemeService } from '../../core/theme.service';
import { DEFAULT_APP_NAME } from '@kloister/shared';

/**
 * Sign-in screen. Accounts are created by admins, so there is no sign-up
 * link. Users with a temporary password continue to the change-password page.
 */
@Component({
  selector: 'app-login',
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
          ><h1>Sign in to {{ theme.appName() }}</h1></mat-card-title
        ></mat-card-header
      >
      <mat-card-content>
        <form [formGroup]="form" (ngSubmit)="submit()">
          <mat-form-field>
            <mat-label>Email</mat-label>
            <input matInput type="email" formControlName="email" autocomplete="username" />
          </mat-form-field>
          <mat-form-field>
            <mat-label>Password</mat-label>
            <input
              matInput
              type="password"
              formControlName="password"
              autocomplete="current-password"
            />
          </mat-form-field>
          @if (error()) {
            <p class="error" role="alert">{{ error() }}</p>
          }
          <button mat-flat-button type="submit" [disabled]="form.invalid || busy()">Sign in</button>
        </form>
      </mat-card-content>
    </mat-card>
  `,
})
export class LoginPage {
  /** Branding shown in the heading; the sign-in pages retry it if its first load timed out. */
  protected readonly theme = inject(ThemeService);

  /**
   * Retries the public branding when the first load before rendering gave
   * up (it waits only a few seconds), so the page still updates to the
   * admin's name and logo.
   */
  constructor() {
    if (this.theme.appName() === DEFAULT_APP_NAME && this.theme.logoUrl() === null)
      void this.theme.loadBranding();
  }

  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** Sign-in form. */
  protected readonly form = inject(NonNullableFormBuilder).group({
    email: ['', [required]],
    password: ['', [required]],
  });
  /** Last error message, if any. */
  protected readonly error = signal('');
  /** True while the request is in flight. */
  protected readonly busy = signal(false);

  /**
   * Signs in and routes to the next screen.
   *
   * @returns Resolves when navigation has started or the error is shown.
   */
  protected async submit(): Promise<void> {
    if (this.form.invalid) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const user = await this.auth.login(this.form.getRawValue());
      await this.router.navigate([user.mustChangePassword ? '/change-password' : '/']);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}
