import { Clipboard } from '@angular/cdk/clipboard';
import { Location } from '@angular/common';
import { Component, inject, input } from '@angular/core';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router } from '@angular/router';
import type { WorkItemDto } from '@kloister/shared';
import { ProjectContext } from '../core/project-context';
import { Icon } from './icon';
import { ToastService } from './toast.service';

/**
 * The absolute address of an item's deep link (`/<app>/p/:key/items/:number`),
 * including the app's base href, so it opens the item for anyone who may see
 * it, whichever view it was copied from.
 *
 * @param router The router.
 * @param location Adds the base href.
 * @param projectKey The project key, or null for the personal space.
 * @param number The item number.
 * @param origin The page origin, e.g. `https://host`.
 * @returns The absolute URL.
 */
export function itemUrl(
  router: Router,
  location: Location,
  projectKey: string | null,
  number: number,
  origin: string,
): string {
  const path = router.serializeUrl(
    router.createUrlTree(['/p', projectKey ?? 'personal', 'items', number]),
  );
  return new URL(location.prepareExternalUrl(path), origin).href;
}

/**
 * "Copy link" for a card or the drawer (v1.4.0): copies the item's absolute
 * deep link and confirms with a toast. Copying grants nothing: the link opens
 * only for people who can already see the item (SPEC §3.4).
 */
@Component({
  selector: 'app-item-link-action',
  imports: [Icon, MatTooltipModule],
  template: `<button
    type="button"
    class="k-icon-btn"
    aria-label="Copy link"
    matTooltip="Copy link"
    (click)="copy($event)"
  >
    <app-icon name="link" [size]="size()" />
  </button>`,
})
export class ItemLinkAction {
  /** The item whose link is copied. */
  readonly item = input.required<Pick<WorkItemDto, 'number'>>();
  /** Icon size in pixels. */
  readonly size = input(16);
  private readonly ctx = inject(ProjectContext);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly clipboard = inject(Clipboard);
  private readonly toast = inject(ToastService);

  /**
   * Copies the link without opening the card behind the button.
   *
   * @param event The click.
   */
  protected copy(event: Event): void {
    event.stopPropagation();
    const project = this.ctx.project();
    const url = itemUrl(
      this.router,
      this.location,
      project?.key ?? null,
      this.item().number,
      window.location.origin,
    );
    if (this.clipboard.copy(url)) this.toast.show('Link copied');
    else this.toast.error('The link could not be copied; copy it from the address bar.');
  }
}
