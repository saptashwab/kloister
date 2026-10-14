import { Component, computed, inject, type OnDestroy, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import { RouterLink } from '@angular/router';
import type { ThemeDto } from '@kloister/shared';
import { SessionStore } from '../../core/session.store';
import { SettingsApiService } from '../../core/settings-api.service';
import { ThemeService } from '../../core/theme.service';
import { required } from '../../core/validators';
import { Icon } from '../../ui/icon';
import { ThemePicker } from '../../ui/theme-picker';
import { ToastService } from '../../ui/toast.service';

/**
 * The signed-in user's own settings (SPEC §6 user settings): display name,
 * a link to change the password, and the theme: the admin default, or the
 * user's own mode, primary and accent colour. A theme being edited is shown
 * across the app at once and only kept when saved.
 *
 * Permissions: any signed-in user, for their own account only (`/me`).
 */
@Component({
  selector: 'app-account-settings',
  host: { class: 'k-page' },
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatRadioModule,
    RouterLink,
    Icon,
    ThemePicker,
  ],
  template: `
    <header class="k-page-head"><h1>Settings and theme</h1></header>

    <section class="k-panel" aria-labelledby="profile-title">
      <h2 id="profile-title">Profile</h2>
      <form class="k-fields" [formGroup]="profile" (ngSubmit)="saveName()">
        <mat-form-field>
          <mat-label>Display name</mat-label>
          <input matInput formControlName="displayName" maxlength="100" />
        </mat-form-field>
        <div class="k-actions">
          <button mat-flat-button type="submit" [disabled]="profile.invalid || busy()">
            Save name
          </button>
          <a mat-button routerLink="/change-password"><app-icon name="key" />Change password</a>
        </div>
      </form>
    </section>

    <section class="k-panel" aria-labelledby="theme-title">
      <h2 id="theme-title">Theme</h2>
      <p class="lead">Your theme applies to you only, on every device you sign in on.</p>
      <mat-radio-group
        class="k-actions"
        aria-labelledby="theme-title"
        [value]="ownTheme() ? 'own' : 'default'"
        (change)="choose($event.value === 'own')"
      >
        <mat-radio-button value="default">Use the default theme</mat-radio-button>
        <mat-radio-button value="own">Use my own theme</mat-radio-button>
      </mat-radio-group>
      @if (draft(); as draft) {
        <app-theme-picker label="Your theme" [value]="draft" (valueChange)="edit($event)" />
      }
      <div class="k-actions">
        <button
          mat-flat-button
          type="button"
          [disabled]="!changed() || busy()"
          (click)="saveTheme()"
        >
          Save theme
        </button>
        <button mat-button type="button" [disabled]="!changed() || busy()" (click)="reset()">
          Cancel
        </button>
      </div>
    </section>
  `,
})
export class AccountSettingsPage implements OnDestroy {
  private readonly api = inject(SettingsApiService);
  private readonly store = inject(SessionStore);
  private readonly theme = inject(ThemeService);
  private readonly toast = inject(ToastService);

  /** The theme being edited, or null for "use the default theme". */
  protected readonly draft = signal<ThemeDto | null>(this.theme.userTheme());
  /** Whether the draft uses an own theme. */
  protected readonly ownTheme = computed(() => this.draft() !== null);
  /** True when the draft differs from the saved theme. */
  protected readonly changed = computed(
    () => JSON.stringify(this.draft()) !== JSON.stringify(this.theme.userTheme()),
  );
  /** True while saving. */
  protected readonly busy = signal(false);

  /** Display name form. */
  protected readonly profile = inject(NonNullableFormBuilder).group({
    displayName: [this.store.user()?.displayName ?? '', [required, Validators.maxLength(100)]],
  });

  /**
   * Stops any preview when the page is left without saving.
   */
  ngOnDestroy(): void {
    this.theme.previewTheme(null);
  }

  /**
   * Switches between the default and an own theme, starting an own theme
   * from the theme in effect.
   *
   * @param own True for an own theme.
   */
  protected choose(own: boolean): void {
    this.edit(own ? (this.theme.userTheme() ?? this.theme.branding().theme) : null);
  }

  /**
   * Updates the draft and shows it at once.
   *
   * @param theme The draft, or null for the default.
   */
  protected edit(theme: ThemeDto | null): void {
    this.draft.set(theme);
    this.theme.previewTheme(theme ?? this.theme.branding().theme);
  }

  /**
   * Returns to the saved theme.
   */
  protected reset(): void {
    this.draft.set(this.theme.userTheme());
    this.theme.previewTheme(null);
  }

  /**
   * Saves the draft as the user's theme, or clears it.
   *
   * @returns Resolves once saved.
   */
  protected async saveTheme(): Promise<void> {
    this.busy.set(true);
    try {
      const saved = await this.api.setMyTheme(this.draft());
      this.theme.setUserTheme(saved.theme);
      this.theme.previewTheme(null);
      this.draft.set(saved.theme);
      this.toast.show(saved.theme ? 'Your theme is saved' : 'You use the default theme again');
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Saves the display name.
   *
   * @returns Resolves once saved.
   */
  protected async saveName(): Promise<void> {
    if (this.profile.invalid) return;
    this.busy.set(true);
    try {
      const user = await this.api.updateMe({ displayName: this.profile.getRawValue().displayName });
      this.store.set(user);
      this.toast.show('Display name saved');
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.busy.set(false);
    }
  }
}
