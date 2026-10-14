import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { type ThemeDto, ThemeMode } from '@kloister/shared';
import {
  checkColour,
  type ColourCheck,
  MIN_CONTRAST,
  type Mode,
  THEME_SWATCHES,
} from '../core/theme';

/** Labels of the modes. */
const MODES: readonly { value: ThemeMode; name: string }[] = [
  { value: ThemeMode.SYSTEM, name: 'Same as the device' },
  { value: ThemeMode.LIGHT, name: 'Light' },
  { value: ThemeMode.DARK, name: 'Dark' },
];

/**
 * Picks a theme (SPEC §6): light, dark or the device's mode, and a primary
 * and an accent colour from a curated set or any custom colour. Under each
 * colour it says whether text in it reaches WCAG AA (4.5:1) as chosen, or
 * which shade is shown instead in light and dark mode; the shades are
 * derived by core/theme.ts, which every theme goes through (DESIGN §2.1).
 */
@Component({
  selector: 'app-theme-picker',
  imports: [MatButtonToggleModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--k-space-4);
    }
    fieldset {
      margin: 0;
      padding: 0;
      border: 0;
    }
    legend {
      margin-bottom: var(--k-space-2);
      font-weight: 600;
    }
    .swatches {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--k-space-2);
    }
    .swatch {
      width: 28px;
      height: 28px;
      padding: 0;
      border: 2px solid var(--k-surface);
      border-radius: var(--k-radius-full);
      box-shadow: 0 0 0 1px var(--k-border-strong);
      cursor: pointer;
    }
    .swatch.on {
      box-shadow: 0 0 0 2px var(--k-text);
    }
    .custom {
      display: inline-flex;
      align-items: center;
      gap: var(--k-space-2);
      font-size: var(--k-body-sm);
    }
    .custom input {
      width: 36px;
      height: 28px;
      padding: 0;
      border: 1px solid var(--k-control-border);
      border-radius: var(--k-radius-sm);
      background: none;
    }
    .note {
      margin: var(--k-space-2) 0 0;
      font-size: var(--k-small);
      color: var(--k-muted);
    }
  `,
  template: `
    <fieldset>
      <legend>Mode</legend>
      <mat-button-toggle-group
        class="k-segmented"
        [attr.aria-label]="label() + ' mode'"
        [value]="value().mode"
        (change)="set({ mode: $event.value })"
      >
        @for (m of modes; track m.value) {
          <mat-button-toggle [value]="m.value">{{ m.name }}</mat-button-toggle>
        }
      </mat-button-toggle-group>
    </fieldset>

    @for (role of roles; track role.key) {
      <fieldset>
        <legend>{{ role.name }}</legend>
        <div class="swatches" role="radiogroup" [attr.aria-label]="label() + ' ' + role.name">
          @for (s of swatches; track s.hex) {
            <button
              type="button"
              role="radio"
              class="swatch"
              [class.on]="value()[role.key] === s.hex"
              [style.background]="s.hex"
              [attr.aria-checked]="value()[role.key] === s.hex"
              [attr.aria-label]="s.name"
              (click)="setColour(role.key, s.hex)"
            ></button>
          }
          <label class="custom">
            <input
              type="color"
              [value]="value()[role.key].toLowerCase()"
              (change)="pickCustom(role.key, $event)"
            />
            Custom {{ role.name.toLowerCase() }}
          </label>
        </div>
        <p class="note" aria-live="polite">{{ noteFor(role.key) }}</p>
      </fieldset>
    }
  `,
})
export class ThemePicker {
  /** The theme being edited. */
  readonly value = model.required<ThemeDto>();
  /** Prefix for accessible names, e.g. "Your theme" or "Default theme". */
  readonly label = input('Theme');

  /** Mode choices. */
  protected readonly modes = MODES;
  /** Curated colours. */
  protected readonly swatches = THEME_SWATCHES;
  /** The two colours and their names. */
  protected readonly roles = [
    { key: 'primary', name: 'Primary colour' },
    { key: 'accent', name: 'Accent colour' },
  ] as const;

  /** Contrast checks of both colours. */
  private readonly checks = computed(() => ({
    primary: checkColour(this.value().primary, 'primary'),
    accent: checkColour(this.value().accent, 'accent'),
  }));

  /**
   * Changes part of the theme.
   *
   * @param change Fields to change.
   */
  protected set(change: Partial<ThemeDto>): void {
    this.value.update((v) => ({ ...v, ...change }));
  }

  /**
   * Sets the primary or accent colour.
   *
   * @param role Which colour.
   * @param hex The colour.
   */
  protected setColour(role: 'primary' | 'accent', hex: string): void {
    this.set(role === 'primary' ? { primary: hex } : { accent: hex });
  }

  /**
   * Takes a colour from the browser's colour input.
   *
   * @param role Which colour.
   * @param event The input's change event.
   */
  protected pickCustom(role: 'primary' | 'accent', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    if (/^#[0-9a-f]{6}$/i.test(value)) this.setColour(role, value.toUpperCase());
  }

  /**
   * Explains how a colour is shown: as chosen, or adjusted for contrast.
   *
   * @param role Primary or accent.
   * @returns One sentence.
   */
  protected noteFor(role: 'primary' | 'accent'): string {
    const check = this.checks()[role];
    const adjusted = (['light', 'dark'] as const).filter((m: Mode) => check[m].adjusted);
    const what = role === 'primary' ? 'Text in this colour' : 'Text on this colour';
    if (adjusted.length === 0) {
      return `${what} reaches ${MIN_CONTRAST}:1 contrast in light and dark mode.`;
    }
    const shown = adjusted.map((m) => `${shade(check[m])} in ${m} mode`).join(' and ');
    return `Shown as ${shown}, so text reaches at least ${MIN_CONTRAST}:1 contrast.`;
  }
}

/**
 * Names a shown colour with its contrast.
 *
 * @param check The colour check.
 * @returns E.g. `#4338CA (5.9:1)`.
 */
function shade(check: ColourCheck): string {
  return `${check.shown} (${check.ratio.toFixed(1)}:1)`;
}
