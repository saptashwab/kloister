import {
  afterNextRender,
  Component,
  computed,
  Directive,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Layout } from '../core/layout';
import { Icon } from './icon';

/**
 * The folding behaviour of a page with a header and a toolbar marked
 * `k-page-tools` (DESIGN §7, v1.4.0): the project shell and My work. Applied
 * as a host directive, it sets `k-folded` and `k-peek` on the page, so the
 * global styles hide the toolbar or show it over the page, and folds a
 * peeking toolbar again after Escape, a press elsewhere, focus moving past
 * it or unfolding (pages also fold it on navigation). When folding removes the element that had focus, focus
 * moves to the fold button instead of the page.
 */
@Directive({
  selector: '[appFoldHost]',
  host: {
    '[class.k-folded]': 'layout.folded()',
    '[class.k-peek]': 'peek()',
    '(document:pointerdown)': 'pointerDown($event)',
    '(document:focusin)': 'focusIn($event)',
    '(document:keydown.escape)': 'escape($event)',
  },
})
export class FoldHost {
  /** The remembered fold choice, shared by every page. */
  readonly layout = inject(Layout);
  /** While folded: the toolbar shown over the page until a press elsewhere. */
  readonly peek = signal(false);
  /** The fold/pin button, which takes focus when what had it goes away. */
  readonly foldButton = signal<HTMLElement | null>(null);
  /** The button that shows the toolbar, which takes focus back from it. */
  readonly peekButton = signal<HTMLElement | null>(null);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Folds a peeking toolbar on unfolding and moves focus out of what folds away. */
  constructor() {
    const injector = inject(Injector);
    effect(() => {
      this.layout.folded();
      untracked(() => this.peek.set(false));
    });
    let wasFolded = this.layout.folded();
    effect(() => {
      const folded = this.layout.folded();
      if (folded === wasFolded) return;
      wasFolded = folded;
      untracked(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement) || !this.host.nativeElement.contains(active)) return;
        afterNextRender(
          () => {
            if (!this.host.nativeElement.contains(document.activeElement)) {
              this.foldButton()?.focus();
            }
          },
          { injector },
        );
      });
    });
  }

  /**
   * Escape folds a peeking toolbar again, unless it was for something
   * else: a list, menu or dialog open over the page, or a control that
   * handled it. Focus inside the toolbar returns to its show button.
   *
   * @param event The key press.
   */
  protected escape(event: Event): void {
    if (!this.peek() || event.defaultPrevented) return;
    if (document.querySelector('.cdk-overlay-container .cdk-overlay-pane:not(:empty)')) return;
    const inTools = document.activeElement?.closest('.k-page-tools') != null;
    this.peek.set(false);
    if (inTools) this.peekButton()?.focus();
  }

  /**
   * Folds a peeking toolbar again when keyboard focus moves past it, so it
   * never covers what has focus.
   *
   * @param event The focus change.
   */
  protected focusIn(event: FocusEvent): void {
    if (!this.peek() || this.keeps(event.target)) return;
    this.peek.set(false);
  }

  /**
   * Folds a peeking toolbar again after a press outside it. Presses in the
   * toolbar, its menus and lists (overlays) and the fold controls keep it.
   *
   * @param event The press.
   */
  protected pointerDown(event: PointerEvent): void {
    if (!this.peek() || this.keeps(event.target)) return;
    this.peek.set(false);
  }

  /**
   * Whether an event inside this target keeps the toolbar shown.
   *
   * @param target The event target.
   * @returns True for the toolbar, overlays and the fold controls.
   */
  private keeps(target: EventTarget | null): boolean {
    return (
      !(target instanceof Element) ||
      target.closest('.k-page-tools, .cdk-overlay-container, .fold-controls') !== null
    );
  }
}

/**
 * The end of a folding page's header row (DESIGN §7, v1.4.0). While folded:
 * the active-filter chip, the projected icon-only actions and the button
 * that shows the toolbar over the page. Always: one fold/pin button whose
 * name, icon and `aria-expanded` change, so it keeps focus when it folds or
 * unfolds. Needs a {@link FoldHost} on the page.
 */
@Component({
  selector: 'app-fold-controls',
  imports: [Icon],
  host: { class: 'fold-controls' },
  styles: `
    :host {
      display: flex;
      flex: none;
      align-items: center;
      gap: var(--k-space-2);
    }
  `,
  template: `
    @if (fold.layout.folded()) {
      @if (filterCount() > 0) {
        <button
          type="button"
          class="k-chip on"
          [attr.aria-label]="filterLabel()"
          [attr.aria-expanded]="fold.peek()"
          (click)="fold.peek.set(true)"
        >
          <app-icon name="filter" [size]="13" />{{ filterCount() }}
          {{ filterCount() === 1 ? 'filter' : 'filters' }}
        </button>
      }
      <ng-content />
      @if (hasTools()) {
        <button
          #peekButton
          type="button"
          class="k-icon-btn"
          [attr.aria-label]="fold.peek() ? 'Hide the toolbar' : 'Show the toolbar'"
          [attr.aria-expanded]="fold.peek()"
          [title]="fold.peek() ? 'Hide the toolbar' : 'Show the toolbar'"
          (click)="fold.peek.set(!fold.peek())"
        >
          <app-icon [name]="fold.peek() ? 'up' : 'down'" />
        </button>
      }
    }
    <!-- One button for both states, so it keeps focus when it folds or unfolds. -->
    <button
      #foldButton
      type="button"
      class="k-icon-btn"
      [attr.aria-label]="fold.layout.folded() ? openLabel() : foldLabel()"
      [attr.aria-expanded]="!fold.layout.folded()"
      [title]="(fold.layout.folded() ? openLabel() : foldLabel()) + ' (Ctrl+\\\\)'"
      (click)="fold.layout.setFolded(!fold.layout.folded())"
    >
      <app-icon [name]="fold.layout.folded() ? 'pin' : 'up'" />
    </button>
  `,
})
export class FoldControls {
  /** The page's folding state. */
  protected readonly fold = inject(FoldHost);
  /** Filters narrowing the page, for the chip. */
  readonly filterCount = input(0);
  /** Whether the page has a toolbar that folds (and so can be shown). */
  readonly hasTools = input(true);
  /** The fold button's name while open. */
  readonly foldLabel = input('Fold the header and toolbar');
  /** The pin's name while folded. */
  readonly openLabel = input('Keep the header and toolbar open');

  /** The chip's accessible name, saying what pressing it does. */
  protected readonly filterLabel = computed(
    () =>
      `${this.filterCount()} ${this.filterCount() === 1 ? 'filter' : 'filters'} set, show the toolbar`,
  );

  private readonly foldRef = viewChild.required<ElementRef<HTMLElement>>('foldButton');
  private readonly peekRef = viewChild<ElementRef<HTMLElement>>('peekButton');

  /** Tells the page which buttons take focus back. */
  constructor() {
    effect(() => this.fold.foldButton.set(this.foldRef().nativeElement));
    effect(() => this.fold.peekButton.set(this.peekRef()?.nativeElement ?? null));
  }
}
