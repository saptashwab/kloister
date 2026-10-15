import { Component, computed, inject, input } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ProjectPermission, type WorkItemDto } from '@kloister/shared';
import { ProjectContext } from '../core/project-context';
import { dialogMotion } from './motion';
import { Icon } from './icon';

/** Lazy same-space copy entry point for fully readable cards and drawers. */
@Component({
  selector: 'app-item-copy-action',
  imports: [Icon, MatTooltipModule],
  template: `@if (allowed()) {
    <button
      type="button"
      class="k-icon-btn"
      aria-label="Duplicate item"
      matTooltip="Duplicate item"
      (click)="open($event)"
    >
      <app-icon name="copy" />
    </button>
  }`,
})
export class ItemCopyAction {
  /** Fully readable source; title-only ancestors never get this control. */
  readonly item = input.required<WorkItemDto>();
  private readonly ctx = inject(ProjectContext);
  private readonly dialog = inject(MatDialog);
  /** Creation rights in the current, writable space. */
  protected readonly allowed = computed(
    () => this.ctx.writable() && this.ctx.has(ProjectPermission.CREATE_ITEMS),
  );
  /**
   * Opens the independently confirmed copy preview.
   * @param event Prevent card navigation behind the action.
   * @returns Resolves after lazy code loads.
   */
  protected async open(event: Event): Promise<void> {
    event.stopPropagation();
    const { DuplicateDialog } = await import('../pages/project/duplicate-dialog');
    this.dialog.open(DuplicateDialog, {
      enterAnimationDuration: dialogMotion(),
      exitAnimationDuration: dialogMotion(),
      width: 'var(--k-size-640px)',
      maxWidth: 'calc(100vw - var(--k-space-4))',
      data: { ctx: this.ctx, item: this.item() },
    });
  }
}
