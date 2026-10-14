import { formatDate } from '@angular/common';
import { Component, computed, inject, type OnDestroy, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import {
  APP_NAME_MAX,
  type BrandingFileDto,
  type BrandingSettingsDto,
  FontWeight,
  type ThemeDto,
  UiFont,
} from '@kloister/shared';
import { formatSize } from '../../core/format';
import { SettingsApiService } from '../../core/settings-api.service';
import { FONT_NAMES, FONT_STACKS } from '../../core/theme';
import { ThemeService } from '../../core/theme.service';
import { required } from '../../core/validators';
import { Dialogs } from '../../ui/dialogs';
import { Skeleton } from '../../ui/feedback';
import { Icon } from '../../ui/icon';
import { ThemePicker } from '../../ui/theme-picker';
import { ToastService } from '../../ui/toast.service';

/** Font choices in the order shown. */
const FONTS: readonly UiFont[] = [
  UiFont.FIGTREE,
  UiFont.ATKINSON_HYPERLEGIBLE,
  UiFont.IBM_PLEX_SANS,
  UiFont.GEORGIA,
  UiFont.ARIAL,
  UiFont.UPLOADED,
];

/** Notes under each font choice (DESIGN §6). */
const FONT_HINTS: Record<UiFont, string> = {
  FIGTREE: 'Bundled with the app.',
  ATKINSON_HYPERLEGIBLE: 'Bundled. Designed for low vision readers.',
  IBM_PLEX_SANS: 'Bundled.',
  GEORGIA: 'Installed on most computers; a serif font.',
  ARIAL: 'Installed on most computers.',
  UPLOADED: 'Your own font files, below. Figtree is used if they cannot be loaded.',
};

/** Logo types offered by the file picker; the API checks the content. */
const LOGO_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

/** Font types offered by the file picker; the API checks the content. */
const FONT_ACCEPT = '.woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf';

/**
 * Admin branding (SPEC §6): the app name (shell and page title), the logo,
 * the UI font (a preset, or uploaded regular and optional bold files,
 * docs/DESIGN.md §6) and the default theme everyone without their own theme
 * sees, the sign-in page included. Changes show across the app at once.
 *
 * Permissions: admin route; the API refuses everyone else, checks uploads
 * by content and audits every change.
 */
@Component({
  selector: 'app-admin-branding',
  host: { class: 'k-tab' },
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    Icon,
    Skeleton,
    ThemePicker,
  ],
  template: `
    @if (settings(); as s) {
      <form
        class="k-panel"
        [formGroup]="nameForm"
        (ngSubmit)="saveName()"
        aria-labelledby="name-title"
      >
        <h2 id="name-title">App name</h2>
        <p class="lead">Shown in the sidebar, on the sign-in page and as the browser tab title.</p>
        <div class="k-fields">
          <mat-form-field>
            <mat-label>App name</mat-label>
            <input matInput formControlName="appName" [attr.maxlength]="nameMax" />
          </mat-form-field>
        </div>
        <div class="k-actions">
          <button mat-flat-button type="submit" [disabled]="nameForm.invalid || busy()">
            Save name
          </button>
        </div>
      </form>

      <section class="k-panel" aria-labelledby="logo-title">
        <h2 id="logo-title">Logo</h2>
        <p class="lead">PNG, JPEG, GIF or WebP, at most 1 MB. Shown next to the app name.</p>
        <div class="k-file-row">
          @if (theme.logoUrl(); as logo) {
            <img class="k-logo lg" [src]="logo" alt="Current logo" />
          }
          <div class="what">
            @if (s.logo; as file) {
              <span>{{ file.name }}</span>
              <span class="detail">{{ describe(file) }}</span>
            } @else {
              <span>No logo</span>
              <span class="detail">The app name is shown with a plain mark.</span>
            }
          </div>
          <input
            #logoInput
            class="k-file-input"
            type="file"
            tabindex="-1"
            aria-hidden="true"
            [accept]="logoAccept"
            (change)="uploadLogo(logoInput)"
          />
          <button mat-stroked-button type="button" [disabled]="busy()" (click)="logoInput.click()">
            <app-icon name="upload" />{{ s.logo ? 'Replace logo' : 'Upload logo' }}
          </button>
          @if (s.logo) {
            <button mat-button type="button" [disabled]="busy()" (click)="removeLogo()">
              <app-icon name="trash" />Remove logo
            </button>
          }
        </div>
      </section>

      <section class="k-panel" aria-labelledby="font-title">
        <h2 id="font-title">UI font</h2>
        <p class="lead">One font for everyone. Item keys always use the bundled monospace font.</p>
        <div class="k-choices" role="radiogroup" aria-labelledby="font-title">
          @for (f of fonts; track f) {
            <label
              class="k-choice"
              [class.on]="font() === f"
              [class.off]="f === uploaded && !s.fontFiles.regular"
            >
              <span class="name">
                <input
                  type="radio"
                  name="ui-font"
                  [value]="f"
                  [checked]="font() === f"
                  [attr.aria-label]="fontNames[f]"
                  [attr.aria-describedby]="'font-hint-' + f"
                  [disabled]="f === uploaded && !s.fontFiles.regular"
                  (change)="font.set(f)"
                />{{ fontNames[f] }}
              </span>
              <span class="sample" [style.font-family]="stacks[f]"
                >Plan the next sprint · 0123</span
              >
              <span class="hint" [id]="'font-hint-' + f">{{ fontHints[f] }}</span>
            </label>
          }
        </div>
        <div class="k-actions">
          <button
            mat-flat-button
            type="button"
            [disabled]="!fontChanged() || busy()"
            (click)="saveFont()"
          >
            Save font
          </button>
        </div>

        <h2 id="files-title">Uploaded font files</h2>
        <p class="lead">
          WOFF2 recommended; WOFF, TTF and OTF work too, at most 10 MB each. Without a bold file the
          browser makes bold text itself.
        </p>
        @for (w of weights; track w.weight) {
          <div class="k-file-row">
            <div class="what">
              <span>{{ w.name }}</span>
              @if (s.fontFiles[w.key]; as file) {
                <span class="detail">{{ file.name }} · {{ describe(file) }}</span>
              } @else {
                <span class="detail">Not uploaded</span>
              }
            </div>
            <input
              #fontInput
              class="k-file-input"
              type="file"
              tabindex="-1"
              aria-hidden="true"
              [accept]="fontAccept"
              (change)="uploadFont(w.weight, fontInput)"
            />
            <button
              mat-stroked-button
              type="button"
              [disabled]="busy() || (w.weight === bold && !s.fontFiles.regular)"
              (click)="fontInput.click()"
            >
              <app-icon name="upload" />Upload {{ w.name.toLowerCase() }} file
            </button>
            @if (s.fontFiles[w.key]) {
              <button mat-button type="button" [disabled]="busy()" (click)="removeFont(w.weight)">
                <app-icon name="trash" />Remove
              </button>
            }
          </div>
        }
      </section>

      <section class="k-panel" aria-labelledby="default-theme-title">
        <h2 id="default-theme-title">Default theme</h2>
        <p class="lead">
          For the sign-in page and everyone who has not picked a theme of their own. Changes show
          here at once and are kept when saved.
        </p>
        @if (themeDraft(); as draft) {
          <app-theme-picker
            label="Default theme"
            [value]="draft"
            (valueChange)="editTheme($event)"
          />
        }
        <div class="k-actions">
          <button
            mat-flat-button
            type="button"
            [disabled]="!themeChanged() || busy()"
            (click)="saveTheme()"
          >
            Save default theme
          </button>
          <button
            mat-button
            type="button"
            [disabled]="!themeChanged() || busy()"
            (click)="resetTheme()"
          >
            Cancel
          </button>
        </div>
      </section>
    } @else {
      <app-skeleton label="Loading the branding" [rows]="4" />
    }
  `,
})
export class AdminBrandingPage implements OnInit, OnDestroy {
  private readonly api = inject(SettingsApiService);
  private readonly toast = inject(ToastService);
  private readonly dialogs = inject(Dialogs);
  /** The branding in effect, for the logo preview. */
  protected readonly theme = inject(ThemeService);

  /** The branding settings. */
  protected readonly settings = signal<BrandingSettingsDto | null>(null);
  /** The font chosen on screen. */
  protected readonly font = signal<UiFont>(UiFont.FIGTREE);
  /** True when the chosen font differs from the saved one. */
  protected readonly fontChanged = computed(() => this.font() !== this.settings()?.font);
  /** The saved default theme. */
  private readonly savedTheme = signal<ThemeDto | null>(null);
  /** The default theme being edited. */
  protected readonly themeDraft = signal<ThemeDto | null>(null);
  /** True when the draft differs from the saved default theme. */
  protected readonly themeChanged = computed(
    () => JSON.stringify(this.themeDraft()) !== JSON.stringify(this.savedTheme()),
  );
  /** True while a request runs. */
  protected readonly busy = signal(false);

  /** Template constants. */
  protected readonly fonts = FONTS;
  protected readonly fontNames = FONT_NAMES;
  protected readonly fontHints = FONT_HINTS;
  protected readonly stacks = FONT_STACKS;
  protected readonly uploaded = UiFont.UPLOADED;
  protected readonly bold = FontWeight.BOLD;
  protected readonly nameMax = APP_NAME_MAX;
  protected readonly logoAccept = LOGO_ACCEPT;
  protected readonly fontAccept = FONT_ACCEPT;
  protected readonly weights = [
    { weight: FontWeight.REGULAR, key: 'regular', name: 'Regular' },
    { weight: FontWeight.BOLD, key: 'bold', name: 'Bold' },
  ] as const;

  /** The app name form. */
  protected readonly nameForm = inject(NonNullableFormBuilder).group({
    appName: ['', [required, Validators.maxLength(APP_NAME_MAX)]],
  });

  /**
   * Loads the branding and the default theme.
   */
  ngOnInit(): void {
    void this.load();
  }

  /**
   * Stops any theme preview when the page is left.
   */
  ngOnDestroy(): void {
    this.theme.previewTheme(null);
  }

  /**
   * A file's type, size and upload date.
   *
   * @param file The file.
   * @returns E.g. "image/png · 12.0 KB · uploaded 14 Oct 2026".
   */
  protected describe(file: BrandingFileDto): string {
    const date = formatDate(file.uploadedAt, 'mediumDate', 'en-US');
    return `${file.type} · ${formatSize(file.sizeBytes)} · uploaded ${date}`;
  }

  /**
   * Saves the app name with the saved font.
   *
   * @returns Resolves once saved.
   */
  protected async saveName(): Promise<void> {
    const s = this.settings();
    if (s === null || this.nameForm.invalid) return;
    await this.change('App name saved', () =>
      this.api.saveBranding({ appName: this.nameForm.getRawValue().appName.trim(), font: s.font }),
    );
  }

  /**
   * Saves the chosen font with the saved name.
   *
   * @returns Resolves once saved.
   */
  protected async saveFont(): Promise<void> {
    const s = this.settings();
    if (s === null) return;
    await this.change('UI font saved', () =>
      this.api.saveBranding({ appName: s.appName, font: this.font() }),
    );
  }

  /**
   * Uploads the file picked for the logo.
   *
   * @param input The file input.
   * @returns Resolves once uploaded.
   */
  protected async uploadLogo(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (file === undefined) return;
    await this.change('Logo uploaded', () => this.api.uploadLogo(file));
  }

  /**
   * Removes the logo after confirmation.
   *
   * @returns Resolves once removed.
   */
  protected async removeLogo(): Promise<void> {
    const ok = await this.dialogs.confirm({
      title: 'Remove the logo?',
      message: 'The app name is shown with a plain mark instead.',
      confirm: 'Remove logo',
      danger: true,
    });
    if (ok) await this.change('Logo removed', () => this.api.removeLogo());
  }

  /**
   * Uploads the file picked for a font weight.
   *
   * @param weight Regular or bold.
   * @param input The file input.
   * @returns Resolves once uploaded.
   */
  protected async uploadFont(weight: FontWeight, input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (file === undefined) return;
    await this.change('Font file uploaded', () => this.api.uploadFont(weight, file));
  }

  /**
   * Removes a font file after confirmation; the regular one takes the bold
   * one with it and switches back to Figtree.
   *
   * @param weight Regular or bold.
   * @returns Resolves once removed.
   */
  protected async removeFont(weight: FontWeight): Promise<void> {
    const regular = weight === FontWeight.REGULAR;
    const ok = await this.dialogs.confirm({
      title: regular ? 'Remove the uploaded font?' : 'Remove the bold font file?',
      message: regular
        ? 'Both font files are removed and the app uses Figtree again.'
        : 'The browser makes bold text from the regular file instead.',
      confirm: 'Remove',
      danger: true,
    });
    if (ok) await this.change('Font file removed', () => this.api.removeFont(weight));
  }

  /**
   * Shows a default theme being edited.
   *
   * @param theme The draft.
   */
  protected editTheme(theme: ThemeDto): void {
    this.themeDraft.set(theme);
    // Only people without their own theme see the default.
    if (this.theme.userTheme() === null) this.theme.previewTheme(theme);
  }

  /**
   * Returns to the saved default theme.
   */
  protected resetTheme(): void {
    this.themeDraft.set(this.savedTheme());
    this.theme.previewTheme(null);
  }

  /**
   * Saves the default theme.
   *
   * @returns Resolves once saved.
   */
  protected async saveTheme(): Promise<void> {
    const draft = this.themeDraft();
    if (draft === null) return;
    this.busy.set(true);
    try {
      const saved = await this.api.saveDefaultTheme(draft);
      this.savedTheme.set(saved);
      this.themeDraft.set(saved);
      this.theme.previewTheme(null);
      await this.refreshPublic();
      this.toast.show('Default theme saved');
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Runs a branding change, then shows the result here and across the app.
   *
   * @param done Toast text on success.
   * @param request The change.
   * @returns Resolves once done.
   */
  private async change(done: string, request: () => Promise<BrandingSettingsDto>): Promise<void> {
    this.busy.set(true);
    try {
      this.apply(await request());
      await this.refreshPublic();
      this.toast.show(done);
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Shows saved branding settings.
   *
   * @param settings The settings.
   */
  private apply(settings: BrandingSettingsDto): void {
    this.settings.set(settings);
    this.font.set(settings.font);
    this.nameForm.setValue({ appName: settings.appName });
  }

  /**
   * Reloads the public branding so the shell, title and font follow.
   *
   * @returns Resolves once reloaded.
   */
  private async refreshPublic(): Promise<void> {
    this.theme.setBranding(await this.api.publicBranding());
  }

  /**
   * Loads the settings and the default theme.
   *
   * @returns Resolves once loaded.
   */
  private async load(): Promise<void> {
    try {
      const [settings, theme] = await Promise.all([this.api.branding(), this.api.defaultTheme()]);
      this.apply(settings);
      this.savedTheme.set(theme);
      this.themeDraft.set(theme);
    } catch (error) {
      this.toast.error(error);
    }
  }
}
