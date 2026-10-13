import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Empty state (DESIGN §11): a one-line title, one sentence of what to do
 * next and, where the user may act, one action projected into it.
 */
@Component({
  selector: 'app-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: block' },
  template: `
    <div class="k-empty">
      <div class="title">{{ title() }}</div>
      @if (text()) {
        <div class="text">{{ text() }}</div>
      }
      <div class="action"><ng-content /></div>
    </div>
  `,
})
export class EmptyState {
  /** What is empty, e.g. "No sprints yet". */
  readonly title = input.required<string>();
  /** What to do next. */
  readonly text = input('');
}

/**
 * Loading skeleton (DESIGN §11): grey shapes of the content being loaded,
 * hidden from screen readers, which hear the `label` instead. `cards` draws
 * board columns, `rows` a list.
 */
@Component({
  selector: 'app-skeleton',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: block;
    }
    .cols {
      display: flex;
      gap: 16px;
      overflow: hidden;
    }
    .col {
      flex: 0 0 288px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 10px;
      border-radius: var(--k-radius-lg);
      background: var(--k-sunken);
    }
    .card,
    .row {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px;
      border: 1px solid var(--k-border);
      border-radius: var(--k-radius-md);
      background: var(--k-surface);
    }
    .row {
      flex-direction: row;
      align-items: center;
    }
    .rows {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
  `,
  template: `
    <div role="status" [attr.aria-label]="label()">
      @if (kind() === 'cards') {
        <div class="cols" aria-hidden="true">
          @for (col of [1, 2, 3, 4]; track col) {
            <div class="col">
              @for (card of [1, 2, 3].slice(0, 4 - (col % 2)); track card) {
                <div class="card">
                  <span class="k-skel" style="width: 40%; height: 10px"></span>
                  <span class="k-skel" style="width: 90%; height: 12px"></span>
                  <span class="k-skel" style="width: 65%; height: 12px"></span>
                  <span
                    class="k-skel"
                    style="width: 52px; height: 18px; border-radius: 999px"
                  ></span>
                </div>
              }
            </div>
          }
        </div>
      } @else {
        <div class="rows" aria-hidden="true">
          @for (row of rowList(); track row) {
            <div class="row">
              <span class="k-skel" style="width: 20px; height: 20px"></span>
              <span class="k-skel" style="width: 56px; height: 12px"></span>
              <span class="k-skel" style="flex: 1; max-width: 420px; height: 12px"></span>
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class Skeleton {
  /** Board columns or list rows. */
  readonly kind = input<'cards' | 'rows'>('rows');
  /** Number of list rows. */
  readonly rows = input(5);
  /** What is loading, for screen readers. */
  readonly label = input('Loading');

  /**
   * Row numbers for the template.
   *
   * @returns 1 … rows.
   */
  protected rowList(): number[] {
    return Array.from({ length: this.rows() }, (_, i) => i + 1);
  }
}
