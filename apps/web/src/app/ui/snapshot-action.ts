import { Component, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { Icon } from './icon';
import { dialogMotion } from './motion';

/**
 * Lazy export entry point; the server calculates and rechecks the eligible
 * scope. Shown in a page header's actions (M8.5).
 */
@Component({
  selector: 'app-snapshot-action',
  imports: [MatButtonModule, Icon],
  template: `<button mat-stroked-button type="button" (click)="open()">
    <app-icon name="download" />Export…
  </button>`,
})
export class SnapshotAction {
  /** Project uuid or me for My work; never an arbitrary person. */
  readonly source = input.required<string>();
  /** Current screen filters; all-eligible mode removes narrowing on the server. */
  readonly filters = input<Record<string, string | boolean>>({});
  private readonly dialog = inject(MatDialog);
  /**
   * Loads the scope preview and download dialog on demand.
   * @returns Resolves after dialog code loads.
   */
  protected async open(): Promise<void> {
    const { SnapshotDialog } = await import('../pages/project/snapshot-dialog');
    this.dialog.open(SnapshotDialog, {
      enterAnimationDuration: dialogMotion(),
      exitAnimationDuration: dialogMotion(),
      width: 'var(--k-size-640px)',
      maxWidth: 'calc(100vw - var(--k-space-4))',
      data: { source: this.source(), filters: this.filters() },
    });
  }
}
