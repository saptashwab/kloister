import { BreakpointObserver } from '@angular/cdk/layout';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  type Signal,
  ViewEncapsulation,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';

/**
 * The phone breakpoint shared with the CSS (`max-width: 599px` in the
 * tokens and shell), for layouts that change their markup, not only their
 * styles.
 */
export const PHONE_QUERY = '(max-width: 599.98px)';

/**
 * Whether the viewport is phone width, as a signal. Call from an injection
 * context (a component field).
 *
 * @returns True below the phone breakpoint.
 */
export function phoneLayout(): Signal<boolean> {
  const observer = inject(BreakpointObserver);
  return toSignal(observer.observe(PHONE_QUERY).pipe(map((state) => state.matches)), {
    initialValue: observer.isMatched(PHONE_QUERY),
  });
}

/**
 * Styles for wide tables shown as stacked cards at phone width (DESIGN §15,
 * M8.5): a `ul.k-row-cards` of `li.k-row-card`, each with a `.k-row-card-title`,
 * a `dl` of labelled lines and an optional `.k-row-card-actions` row. Pages
 * render a real table on wider screens instead, because restyling table rows
 * breaks their meaning for screen readers. Loaded with the pages that use it.
 */
@Component({
  selector: 'app-row-card-styles',
  template: '',
  styles: `
    .k-row-cards {
      display: flex;
      flex-direction: column;
      gap: var(--k-space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .k-row-card {
      display: flex;
      flex-direction: column;
      gap: var(--k-space-2);
      padding: var(--k-space-3);
      border: var(--k-line) solid var(--k-border);
      border-radius: var(--k-radius-md);
      background: var(--k-surface);
      overflow-wrap: anywhere;
    }
    .k-row-card-title {
      display: flex;
      align-items: center;
      gap: var(--k-space-2);
      font-weight: 600;
    }
    .k-row-card dl {
      display: grid;
      grid-template-columns: minmax(6em, auto) 1fr;
      gap: var(--k-space-1) var(--k-space-3);
      margin: 0;
      font-size: var(--k-body-sm);
    }
    .k-row-card dt {
      color: var(--k-muted);
    }
    .k-row-card dd {
      margin: 0;
      min-width: 0;
    }
    .k-row-card-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--k-space-2);
    }
  `,
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RowCardStyles {}
