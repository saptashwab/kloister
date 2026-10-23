import { DestroyRef, effect, inject, Injectable, signal } from '@angular/core';

/** What the open project view offers for export: its source and current filters. */
export interface PageExport {
  /** Project uuid; the server rechecks the readable scope. */
  source: string;
  /** Current view filters, kept by the "filtered" option. */
  filters: Record<string, string | boolean>;
}

/**
 * The page-actions area of the project header (DESIGN §15, M8.5). The open
 * view (board, backlog, sprints) registers its Export… action here, so the
 * shell shows it beside "New item" instead of above the view's content.
 * Provided per project shell.
 */
@Injectable()
export class PageActions {
  /** The open view's export, or null when it offers none. */
  readonly export = signal<PageExport | null>(null);

  /**
   * Keeps the view's export registered while the calling component lives.
   * Call from a component's injection context.
   *
   * @param read Reads the current export; tracked, so filter changes update it.
   * @returns This service, so a view can keep it in a field.
   */
  register(read: () => PageExport): this {
    effect(() => this.export.set(read()));
    inject(DestroyRef).onDestroy(() => this.export.set(null));
    return this;
  }
}
