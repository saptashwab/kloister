import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { ItemStatus, ItemType } from '@kloister/shared';
import { PRIORITY_LABELS, STATUS_LABELS, TYPE_LABELS } from '../core/labels';
import { Icon } from './icon';

/**
 * Item type tile (DESIGN §3.1): the type's icon on its soft colour. Named
 * for screen readers, so it can stand alone on a card.
 */
@Component({
  selector: 'app-type-icon',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: inline-flex' },
  template: `
    <span class="k-type" [class.lg]="large()" [attr.data-type]="type()" [title]="name()">
      <app-icon [name]="type()" [size]="large() ? 15 : 13" [stroke]="2.4" [label]="name()" />
    </span>
  `,
})
export class TypeIcon {
  /** The item type. */
  readonly type = input.required<ItemType>();
  /** 24 px tile instead of 20 px. */
  readonly large = input(false);

  /** Display name of the type. */
  protected readonly name = computed(() => TYPE_LABELS[this.type()]);
}

/** Status pill (DESIGN §3.2): icon plus the status name. */
@Component({
  selector: 'app-status-pill',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: inline-flex' },
  template: `
    <span class="k-pill" [class.lg]="large()" [attr.data-status]="status()">
      <app-icon [name]="status()" [size]="large() ? 15 : 13" [stroke]="2.4" />{{ name() }}
    </span>
  `,
})
export class StatusPill {
  /** The status. */
  readonly status = input.required<ItemStatus>();
  /** 32 px pill for the drawer heading. */
  readonly large = input(false);

  /** Display name of the status. */
  protected readonly name = computed(() => STATUS_LABELS[this.status()]);
}

/**
 * Priority bars (DESIGN §3.3): four rising bars, as many coloured as the
 * priority is high; named for screen readers.
 */
@Component({
  selector: 'app-priority-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: inline-flex' },
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 24 24"
      fill="none"
      stroke-width="2.4"
      stroke-linecap="round"
      role="img"
      [attr.aria-label]="label()"
    >
      <title>{{ label() }}</title>
      @for (bar of bars(); track bar.d) {
        <path [attr.d]="bar.d" [attr.stroke]="bar.colour" />
      }
    </svg>
  `,
})
export class PriorityIcon {
  /** Priority, 1 (highest) to 4. */
  readonly priority = input.required<number>();
  /** Size in px. */
  readonly size = input(16);

  /** Accessible name, e.g. "Priority 2 – High". */
  protected readonly label = computed(
    () => `Priority ${PRIORITY_LABELS[this.priority()] ?? this.priority()}`,
  );

  /** The four bars with their colours. */
  protected readonly bars = computed(() => {
    const p = this.priority();
    const lit = Math.max(1, 5 - p);
    return ['M5 19v-3', 'M10 19v-7', 'M15 19V8', 'M20 19V4'].map((d, i) => ({
      d,
      colour: i < lit ? `var(--k-priority-${p})` : 'var(--k-border-strong)',
    }));
  });
}
