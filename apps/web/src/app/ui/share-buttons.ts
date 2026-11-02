import {
  Component,
  computed,
  DestroyRef,
  Directive,
  ElementRef,
  inject,
  input,
  output,
} from '@angular/core';
import { MatSelect } from '@angular/material/select';
import { clampShare, SHARE_PRESETS, stepShare } from '../core/shares';

/** A share chosen for one person. */
export interface ShareChoice {
  /** The person. */
  userId: string;
  /** The new percent. */
  share: number;
}

/** How long typed digits wait for more before they apply, in ms. */
const TYPED_SHARE_MS = 600;

/**
 * Keys that set a share (docs/M13-PLAN.md §2): ← and → step through
 * 25 · 50 · 100, digits type any value (rounded to a step of 5), applied
 * once typing pauses.
 */
export class ShareKeys {
  private typed = '';
  private timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Remembers what to do with a chosen share.
   *
   * @param apply Applies a share to a person.
   */
  constructor(private readonly apply: (choice: ShareChoice) => void) {}

  /**
   * Handles a key for a person's share.
   *
   * @param event The key event.
   * @param userId The person.
   * @param share Their current percent.
   * @returns True when the key set (or is typing) a share.
   */
  handle(event: KeyboardEvent, userId: string, share: number): boolean {
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      this.stop(event);
      this.apply({ userId, share: stepShare(share, event.key === 'ArrowLeft' ? -1 : 1) });
      return true;
    }
    if (/^\d$/.test(event.key)) {
      this.stop(event);
      this.typed = (this.typed + event.key).slice(-3);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        const typed = Number(this.typed);
        this.typed = '';
        this.apply({ userId, share: clampShare(typed) });
      }, TYPED_SHARE_MS);
      return true;
    }
    return false;
  }

  /** Forgets typed digits that were not applied. */
  cancel(): void {
    clearTimeout(this.timer);
    this.typed = '';
  }

  /**
   * Keeps the key from the list's own handling (moving between options).
   *
   * @param event The key event.
   */
  private stop(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

/**
 * Inline share buttons at the end of a ticked person's row in an assignee
 * list: 100% · 75% · 50% · 25% with the current share pressed, and an "Other %"
 * field for any other share (5–100, rounded to a step of 5), which shows a
 * typed share highlighted like a pressed button. The buttons take no tab
 * stop: the list's own keys (see {@link ShareKeys}) reach them from the
 * keyboard. Clicks and keys do not reach the row, so choosing a share never
 * unticks the person.
 */
@Component({
  selector: 'app-share-buttons',
  // Nothing inside reaches the row: a click never ticks or unticks the person.
  host: { '(mousedown)': '$event.stopPropagation()', '(click)': '$event.stopPropagation()' },
  styles: `
    :host {
      display: inline-flex;
      float: right;
      gap: var(--k-space-1);
      padding-left: var(--k-space-2);
    }
    button,
    label {
      min-width: var(--k-size-28px);
      padding: 0 var(--k-space-1);
      border: var(--k-line) solid var(--k-border-strong);
      border-radius: var(--k-radius-sm);
      background: transparent;
      color: var(--k-text-2);
      font: inherit;
      font-size: var(--k-small);
      line-height: 1.6;
      cursor: pointer;
    }
    button[aria-pressed='true'],
    label.on {
      border-color: var(--k-primary);
      background: var(--k-primary-soft);
      color: var(--k-text);
      font-weight: 600;
    }
    label {
      display: inline-flex;
      align-items: center;
      cursor: text;
    }
    label:focus-within {
      outline: var(--k-focus-width) solid var(--k-primary);
    }
    input {
      width: 3.2em;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--k-text);
      font: inherit;
      text-align: right;
      outline: none;
    }
    input::placeholder {
      color: var(--k-text-2);
      opacity: 1;
    }
    button:disabled,
    label.off {
      cursor: default;
      opacity: 0.6;
    }
  `,
  template: `
    <span class="visually-hidden">Share for {{ name() }}:</span>
    @for (p of presets; track p) {
      <button
        type="button"
        tabindex="-1"
        [attr.aria-pressed]="share() === p"
        [disabled]="disabled()"
        (mousedown)="$event.stopPropagation()"
        (click)="pick($event, p)"
      >
        {{ p }}%
      </button>
    }
    <!-- Any other share, typed: Enter or leaving the field applies it. -->
    <label [class.on]="custom()" [class.off]="disabled()"
      ><input
        #other
        type="text"
        inputmode="numeric"
        maxlength="3"
        placeholder="Other"
        [attr.aria-label]="'Other share for ' + name() + ', percent from 5 to 100'"
        [value]="custom() ? share() : ''"
        [disabled]="disabled()"
        (keydown)="otherKey($event, other)"
        (blur)="applyOther(other)"
      />%</label
    >
  `,
})
export class ShareButtons {
  /** The person's name, for screen readers. */
  readonly name = input.required<string>();
  /** The current percent. */
  readonly share = input.required<number>();
  /** The caller may not change it. */
  readonly disabled = input(false);
  /** Emits the chosen percent. */
  readonly shareChange = output<number>();

  /** The offered shares. */
  protected readonly presets = SHARE_PRESETS;

  /** The share is not one of the buttons, so the "Other" field shows it. */
  protected readonly custom = computed(() => !SHARE_PRESETS.includes(this.share()));

  /**
   * Keys in the "Other" field stay there (the list must not toggle the row
   * or move its highlight); Enter applies, Escape restores.
   *
   * @param event The key event.
   * @param field The field.
   */
  protected otherKey(event: KeyboardEvent, field: HTMLInputElement): void {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      this.applyOther(field);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      field.value = this.custom() ? String(this.share()) : '';
      field.blur();
    }
  }

  /**
   * Applies a typed share, rounded to a step of 5 between 5 and 100.
   *
   * @param field The field.
   */
  protected applyOther(field: HTMLInputElement): void {
    const typed = Number(field.value.replace('%', '').trim());
    if (field.value.trim() === '' || !Number.isFinite(typed)) {
      field.value = this.custom() ? String(this.share()) : '';
      return;
    }
    const share = clampShare(typed);
    field.value = SHARE_PRESETS.includes(share) ? '' : String(share);
    if (share !== this.share()) this.shareChange.emit(share);
  }

  /**
   * Chooses a share without toggling the row it sits in.
   *
   * @param event The click.
   * @param share The percent.
   */
  protected pick(event: MouseEvent, share: number): void {
    event.stopPropagation();
    event.preventDefault();
    if (share !== this.share()) this.shareChange.emit(share);
  }
}

/**
 * Share keys for a multiple `mat-select` of people: while its list is open,
 * ← / → and digits set the share of the highlighted person if they are
 * ticked. The listener runs before the select's own, so the keys do not
 * also move the highlight.
 */
@Directive({ selector: 'mat-select[appShareKeys]' })
export class ShareKeysDirective {
  /** The current share of a person, or null when not ticked (or not changeable). */
  readonly appShareKeys = input.required<(userId: string) => number | null>();
  /** Emits a share set from the keyboard. */
  readonly shareKey = output<ShareChoice>();

  private readonly select = inject(MatSelect);
  private readonly keys = new ShareKeys((choice) => this.shareKey.emit(choice));

  /** Listens in the capture phase on the select itself. */
  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const listener = (event: KeyboardEvent): void => {
      if (!this.select.panelOpen) return;
      const userId = this.select.options?.find((o) => o.active)?.value as unknown;
      if (typeof userId !== 'string') return;
      const share = this.appShareKeys()(userId);
      if (share !== null) this.keys.handle(event, userId, share);
    };
    host.addEventListener('keydown', listener, { capture: true });
    inject(DestroyRef).onDestroy(() => {
      host.removeEventListener('keydown', listener, { capture: true });
      this.keys.cancel();
    });
  }
}
