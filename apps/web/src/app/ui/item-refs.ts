import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  ElementRef,
  inject,
  input,
  type OnDestroy,
  ViewEncapsulation,
} from '@angular/core';
import { Router } from '@angular/router';
import type { ItemPreviewDto } from '@kloister/shared';
import { TrashApiService } from '../core/trash-api.service';
import { formatDay } from '../core/format';
import { STATUS_LABELS, TYPE_LABELS } from '../core/labels';
import { REFERENCE_CLASS } from '../core/rich-text';

/** What a hover card shows about a referenced item. */
export interface RefPreview extends Pick<ItemPreviewDto, 'key' | 'type' | 'title' | 'status'> {
  /** Due date `YYYY-MM-DD`, or null. */
  dueDate: string | null;
  /** Assignee names, or a count for items of other projects. */
  assignees: string;
}

/** Finds a referenced item in the open project's live store, by canonical key. */
export type RefLookup = (key: string) => RefPreview | undefined;

/** How long a preview of another project's item is reused. */
const FOREIGN_TTL_MS = 60_000;

/** Previews of other projects' items, shared by every card for a short while. */
const foreign = new Map<string, { at: number; item: Promise<ItemPreviewDto | null> }>();

/** Element id of the one card shown at a time. */
const CARD_ID = 'k-ref-card';

/**
 * Item references in displayed rich text (M12 plan section 6): a click on a
 * reference link opens the item's drawer inside the app, and hovering or
 * focusing a reference shows a small card with its title, status, assignees
 * and due date. The card reads the open project's live store through the
 * given lookup, so a new status shows at once; items of other projects come
 * from `GET /references`, which returns only items the reader can see, and
 * are reused for a minute.
 *
 * The card is built with text nodes only, never HTML.
 */
@Directive({
  selector: '[appItemRefs]',
  host: {
    '(click)': 'clicked($event)',
    '(mouseover)': 'show($event)',
    '(focusin)': 'show($event)',
    '(mouseout)': 'hide()',
    '(focusout)': 'hide()',
    '(keydown.escape)': 'hide()',
  },
})
export class ItemRefs implements OnDestroy {
  /** Looks references up in the open project. */
  readonly appItemRefs = input<RefLookup | null>(null);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly router = inject(Router);
  private readonly api = inject(TrashApiService);
  /** The reference the card belongs to. */
  private current: Element | null = null;

  /**
   * Opens a reference link inside the app, unless a modifier asks the
   * browser for a new tab or window.
   *
   * @param event The click.
   */
  protected clicked(event: MouseEvent): void {
    const link = this.refAt(event.target)?.closest('a');
    if (
      link === null ||
      link === undefined ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    event.preventDefault();
    this.hide();
    void this.router.navigateByUrl(`/${link.getAttribute('href') ?? ''}`);
  }

  /**
   * Shows the card of the reference under the pointer or focus.
   *
   * @param event The pointer or focus event.
   */
  protected show(event: Event): void {
    const ref = this.refAt(event.target);
    if (ref === null || ref === this.current) return;
    this.hide();
    this.current = ref;
    const key = ref.getAttribute('data-ref') ?? ref.textContent?.trim() ?? '';
    const local = this.appItemRefs()?.(key);
    if (local !== undefined) {
      this.render(ref, local);
      return;
    }
    void this.foreign(key).then((preview) => {
      if (preview !== null && this.current === ref) this.render(ref, preview);
    });
  }

  /** Removes the card. */
  protected hide(): void {
    this.current?.removeAttribute('aria-describedby');
    this.current = null;
    document.getElementById(CARD_ID)?.remove();
  }

  /** Removes a card left open when the text goes away. */
  ngOnDestroy(): void {
    this.hide();
  }

  /**
   * The reference element an event happened on, inside this host.
   *
   * @param target The event target.
   * @returns The reference, or null.
   */
  private refAt(target: EventTarget | null): Element | null {
    if (!(target instanceof Element)) return null;
    const ref = target.closest(`.${REFERENCE_CLASS}`);
    return ref !== null && this.host.nativeElement.contains(ref) ? ref : null;
  }

  /**
   * Loads an item of another project once, remembering misses.
   *
   * @param key Canonical key.
   * @returns The preview, or null when hidden or unknown.
   */
  private async foreign(key: string): Promise<RefPreview | null> {
    if (!/^[A-Z]{2,6}-\d{1,9}$/.test(key)) return null;
    let found = foreign.get(key);
    if (found === undefined || Date.now() - found.at > FOREIGN_TTL_MS) {
      const item = this.api
        .previews([key])
        .then((items) => items[0] ?? null)
        .catch(() => {
          // Failures are not remembered: the next hover asks again.
          foreign.delete(key);
          return null;
        });
      found = { at: Date.now(), item };
      foreign.set(key, found);
    }
    const item = await found.item;
    if (item === null) return null;
    const count = item.assigneeIds.length;
    return {
      ...item,
      assignees: count === 0 ? '' : `${count} ${count === 1 ? 'assignee' : 'assignees'}`,
    };
  }

  /**
   * Builds and places the card below the reference.
   *
   * @param ref The reference element.
   * @param item What to show.
   */
  private render(ref: Element, item: RefPreview): void {
    const card = document.createElement('div');
    card.id = CARD_ID;
    card.className = 'k-popover k-ref-card';
    card.setAttribute('role', 'tooltip');
    const line = (text: string, className: string): void => {
      const el = document.createElement('div');
      el.className = className;
      el.textContent = text;
      card.append(el);
    };
    line(`${item.key} · ${TYPE_LABELS[item.type]}`, 'k-ref-card-key');
    line(item.title, 'k-ref-card-title');
    line(
      [
        STATUS_LABELS[item.status],
        item.dueDate === null ? '' : `Due ${formatDay(item.dueDate)}`,
        item.assignees,
      ]
        .filter((part) => part !== '')
        .join(' · '),
      'k-ref-card-meta',
    );
    const rect = ref.getBoundingClientRect();
    card.style.position = 'fixed';
    card.style.top = `${rect.bottom + 4}px`;
    card.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 288))}px`;
    document.body.append(card);
    ref.setAttribute('aria-describedby', CARD_ID);
  }
}

/**
 * The styles of item references and their hover card, loaded with the pages
 * that show references (the drawer) rather than with the first page.
 */
@Component({
  selector: 'app-item-ref-styles',
  template: '',
  styleUrl: '../../styles/_refs.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ItemRefStyles {}
