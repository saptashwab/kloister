import {
  CdkConnectedOverlay,
  CdkOverlayOrigin,
  type ConnectedPosition,
} from '@angular/cdk/overlay';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  inject,
  InjectionToken,
  input,
  type OnDestroy,
  type Signal,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { avatarColours, initials } from '../core/colour';
import { Icon } from './icon';

/**
 * The board's quick person filter (DESIGN §9), provided by pages that have
 * one. Avatars below such a page offer "Filter board to this person" and
 * filter on click; elsewhere they only show the hover card.
 */
export interface PersonFilter {
  /** The person the board is filtered to, or null. */
  readonly active: Signal<string | null>;
  /**
   * Filters to a person, or clears the filter when they are already active.
   *
   * @param userId The person.
   */
  toggle(userId: string): void;
}

/** Injection token for the {@link PersonFilter} of the current page. */
export const PERSON_FILTER = new InjectionToken<PersonFilter>('PERSON_FILTER');

/** Delay before a hover card opens on pointer hover, in ms. */
const OPEN_DELAY = 350;
/** Grace period for moving the pointer from the avatar into the card, in ms. */
const CLOSE_DELAY = 150;

/** Where the hover card goes: below the avatar, else above. */
const POSITIONS: ConnectedPosition[] = [
  { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 6 },
  { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 6 },
  { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -6 },
];

/**
 * A person's avatar (DESIGN §9): initials on a colour derived from the user
 * id. Hovering or keyboard-focusing it opens a hover card with their name,
 * email, "Filter board to this person" (on pages with a person filter) and
 * "View all their work". Clicking filters the board where a filter exists,
 * and otherwise toggles the card. Esc closes the card.
 */
@Component({
  selector: 'app-avatar',
  imports: [CdkOverlayOrigin, CdkConnectedOverlay, RouterLink, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: inline-flex' },
  styles: `
    .card {
      width: 264px;
    }
    .who {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .who div {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .name {
      font-size: var(--k-body);
      font-weight: 700;
    }
    .email {
      font-size: var(--k-body-sm);
      color: var(--k-muted);
      overflow-wrap: anywhere;
    }
    .actions {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding-top: 8px;
      border-top: 1px solid var(--k-border);
    }
  `,
  template: `
    <button
      #trigger
      type="button"
      class="k-avatar"
      cdkOverlayOrigin
      #origin="cdkOverlayOrigin"
      [class.active]="isActive()"
      [style]="vars()"
      [attr.aria-label]="name()"
      [attr.aria-pressed]="toggle() ? isActive() : null"
      [attr.aria-expanded]="open()"
      aria-haspopup="dialog"
      (click)="onClick($event)"
      (mouseenter)="hoverIn()"
      (mouseleave)="hoverOut()"
      (focus)="focusIn()"
      (blur)="focusOut($event)"
      (keydown.escape)="escape($event)"
      (keydown.tab)="tabIntoCard($event)"
    >
      {{ letters() }}
    </button>
    <ng-template
      cdkConnectedOverlay
      [cdkConnectedOverlayOrigin]="origin"
      [cdkConnectedOverlayOpen]="open()"
      [cdkConnectedOverlayPositions]="positions"
      (detach)="open.set(false)"
      (overlayKeydown)="onOverlayKey($event)"
    >
      <div
        #card
        class="k-popover card"
        role="dialog"
        [attr.aria-label]="name()"
        (mouseenter)="hoverIn()"
        (mouseleave)="hoverOut()"
        (focusout)="focusOut($event)"
      >
        <div class="who">
          <span class="k-avatar" [style]="bigVars()" aria-hidden="true">{{ letters() }}</span>
          <div>
            <span class="name">{{ name() }}</span>
            @if (email()) {
              <span class="email">{{ email() }}</span>
            }
          </div>
        </div>
        <div class="actions">
          @if (filter) {
            <button
              type="button"
              class="k-action"
              [attr.aria-pressed]="isActive()"
              (click)="filter.toggle(userId()); closeNow()"
            >
              <app-icon name="filter" />Filter board to this person
            </button>
          }
          <a class="k-action" [routerLink]="['/people', userId()]" (click)="closeNow()">
            <app-icon name="work" />View all their work
          </a>
        </div>
      </div>
    </ng-template>
  `,
})
export class Avatar implements OnDestroy {
  /** The person's user id (decides the colour and the links). */
  readonly userId = input.required<string>();
  /** Display name. */
  readonly name = input.required<string>();
  /** Email shown in the hover card, if known. */
  readonly email = input('');
  /** Size in px. */
  readonly size = input(24);
  /** Toolbar mode: a pressed/unpressed toggle of the person filter. */
  readonly toggle = input(false);

  /** The page's person filter, if it has one. */
  protected readonly filter = inject(PERSON_FILTER, { optional: true });
  /** Overlay positions. */
  protected readonly positions = POSITIONS;
  /** Whether the hover card is open. */
  protected readonly open = signal(false);

  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private readonly card = viewChild<ElementRef<HTMLElement>>('card');
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** Initials. */
  protected readonly letters = computed(() => initials(this.name()));
  /** Colour and size variables for `.k-avatar`. */
  protected readonly vars = computed(() => {
    const c = avatarColours(this.userId());
    return { '--a-bg': c.bg, '--a-fg': c.fg, '--a-size': `${this.size()}px` };
  });
  /** Variables for the 40 px avatar in the hover card. */
  protected readonly bigVars = computed(() => ({ ...this.vars(), '--a-size': '40px' }));
  /** True when the board is filtered to this person. */
  protected readonly isActive = computed(() => this.filter?.active() === this.userId());

  /**
   * Clears a pending open or close.
   */
  ngOnDestroy(): void {
    clearTimeout(this.timer);
  }

  /**
   * Filters the board where possible, otherwise toggles the card. The click
   * does not reach a surrounding card, which would open the item.
   *
   * @param event The click.
   */
  protected onClick(event: Event): void {
    event.stopPropagation();
    if (this.filter !== null) {
      this.filter.toggle(this.userId());
      this.closeNow();
    } else {
      this.schedule(!this.open(), 0);
    }
  }

  /** Pointer entered the avatar or the card: open after a short delay. */
  protected hoverIn(): void {
    this.schedule(true, this.open() ? 0 : OPEN_DELAY);
  }

  /** Pointer left: close after a grace period. */
  protected hoverOut(): void {
    this.schedule(false, CLOSE_DELAY);
  }

  /** Keyboard focus on the avatar opens the card at once. */
  protected focusIn(): void {
    if (this.trigger().nativeElement.matches(':focus-visible')) this.schedule(true, 0);
  }

  /**
   * Focus left the avatar or the card: close unless it moved between them.
   *
   * @param event The blur or focusout event.
   */
  protected focusOut(event: FocusEvent): void {
    const next = event.relatedTarget as Node | null;
    const inside =
      next !== null &&
      (this.trigger().nativeElement.contains(next) ||
        (this.card()?.nativeElement.contains(next) ?? false));
    if (!inside) this.schedule(false, CLOSE_DELAY);
  }

  /**
   * Esc on the avatar closes an open card without closing what surrounds
   * it (such as the item drawer).
   *
   * @param event The key event.
   */
  protected escape(event: Event): void {
    if (!this.open()) return;
    event.stopPropagation();
    this.closeNow();
  }

  /**
   * Tab from the avatar while its card is open moves focus into the card,
   * which the overlay places at the end of the page.
   *
   * @param event The key event.
   */
  protected tabIntoCard(event: Event): void {
    const first = this.actions()[0];
    if (!this.open() || (event as KeyboardEvent).shiftKey || first === undefined) return;
    event.preventDefault();
    first.focus();
  }

  /**
   * Keys inside the card: Esc, and Tab past either end, close it and return
   * focus to the avatar.
   *
   * @param event The key event.
   */
  protected onOverlayKey(event: KeyboardEvent): void {
    const actions = this.actions();
    const leavingForward =
      event.key === 'Tab' && !event.shiftKey && document.activeElement === actions.at(-1);
    const leavingBack =
      event.key === 'Tab' && event.shiftKey && document.activeElement === actions[0];
    if (event.key !== 'Escape' && !leavingForward && !leavingBack) return;
    event.preventDefault();
    event.stopPropagation();
    this.closeNow();
    this.trigger().nativeElement.focus();
  }

  /**
   * The card's focusable actions, in order.
   *
   * @returns The elements; empty while the card is closed.
   */
  private actions(): HTMLElement[] {
    return [...(this.card()?.nativeElement.querySelectorAll<HTMLElement>('a, button') ?? [])];
  }

  /** Closes the card immediately. */
  protected closeNow(): void {
    this.schedule(false, 0);
  }

  /**
   * Opens or closes the card after a delay, cancelling any pending change.
   *
   * @param open Target state.
   * @param delay Delay in ms.
   */
  private schedule(open: boolean, delay: number): void {
    clearTimeout(this.timer);
    if (delay === 0) {
      this.open.set(open);
      return;
    }
    this.timer = setTimeout(() => this.open.set(open), delay);
  }
}

/**
 * A non-interactive avatar, for places that only show who someone is (the
 * signed-in user in the sidebar, activity entries).
 */
@Component({
  selector: 'app-avatar-static',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: inline-flex' },
  template: `<span class="k-avatar" role="img" [attr.aria-label]="name()" [style]="vars()">{{
    letters()
  }}</span>`,
})
export class StaticAvatar {
  /** User id (decides the colour). */
  readonly userId = input.required<string>();
  /** Display name. */
  readonly name = input.required<string>();
  /** Size in px. */
  readonly size = input(24);

  /** Initials. */
  protected readonly letters = computed(() => initials(this.name()));
  /** Colour and size variables. */
  protected readonly vars = computed(() => {
    const c = avatarColours(this.userId());
    return { '--a-bg': c.bg, '--a-fg': c.fg, '--a-size': `${this.size()}px` };
  });
}
