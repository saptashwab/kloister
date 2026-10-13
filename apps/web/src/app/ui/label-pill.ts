import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { LabelStyle } from '@kloister/shared';
import { labelVars } from '../core/colour';

/**
 * One label in the project's label style (DESIGN §4): solid by default,
 * tinted, or tinted for cover-bar projects (the bar itself is drawn by the
 * card). Text colours follow the automatic contrast rule in `core/colour`.
 */
@Component({
  selector: 'app-label-pill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: inline-flex; min-width: 0' },
  template: `<span
    class="k-label"
    [class.lg]="large()"
    [attr.data-style]="labelStyle()"
    [style]="vars()"
    >{{ name() }}</span
  >`,
})
export class LabelPill {
  /** Label name. */
  readonly name = input.required<string>();
  /** Label colour, `#RRGGBB`. */
  readonly colour = input.required<string>();
  /** The project's label style. */
  readonly labelStyle = input<LabelStyle>(LabelStyle.SOLID);
  /** 24 px pill for the drawer. */
  readonly large = input(false);

  /** The pill's colour variables. */
  protected readonly vars = computed(() => labelVars(this.colour(), this.labelStyle()));
}
