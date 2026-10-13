import {
  Component,
  type ElementRef,
  inject,
  input,
  output,
  SecurityContext,
  signal,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { DomSanitizer } from '@angular/platform-browser';
import { ITEM_DESCRIPTION_MAX } from '@kloister/shared';
import { Dialogs } from '../../ui/dialogs';

/** Link schemes the editor offers; the server allows the same (SPEC §5). */
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

/**
 * A small rich-text editor for item descriptions: bold, italic, lists and
 * links on a content-editable area (DESIGN §10). Ctrl/Cmd+Enter saves and
 * Esc throws the edits away.
 *
 * The HTML it produces is only a suggestion: the API sanitizes descriptions
 * against an allow-list before storing them (SPEC §5), and Angular sanitizes
 * them again when they are displayed.
 */
@Component({
  selector: 'app-description-editor',
  imports: [MatButtonModule],
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .tools {
      display: flex;
      flex-wrap: wrap;
      gap: 2px;
    }
    .tools button {
      min-height: 30px;
      padding: 0 10px;
      border: 0;
      border-radius: var(--k-radius-sm);
      background: transparent;
      color: var(--k-muted);
      font: inherit;
      font-size: var(--k-small);
      font-weight: 600;
      cursor: pointer;
    }
    .tools button:hover {
      background: var(--k-sunken);
      color: var(--k-text);
    }
    .area {
      min-height: 96px;
      max-height: 360px;
      overflow-y: auto;
      padding: 12px 14px;
      border: 1px solid var(--k-border);
      border-radius: var(--k-radius-md);
      line-height: 1.6;
    }
    .area:focus {
      border-color: var(--k-primary);
    }
    .hint {
      font-size: var(--k-small);
      color: var(--k-muted);
    }
  `,
  template: `
    <div class="tools" role="toolbar" aria-label="Formatting">
      <button type="button" (mousedown)="$event.preventDefault()" (click)="format('bold')">
        Bold
      </button>
      <button type="button" (mousedown)="$event.preventDefault()" (click)="format('italic')">
        Italic
      </button>
      <button
        type="button"
        (mousedown)="$event.preventDefault()"
        (click)="format('insertUnorderedList')"
      >
        Bullets
      </button>
      <button
        type="button"
        (mousedown)="$event.preventDefault()"
        (click)="format('insertOrderedList')"
      >
        Numbers
      </button>
      <button type="button" (mousedown)="$event.preventDefault()" (click)="link()">Link</button>
    </div>
    <div
      #area
      class="area"
      contenteditable="true"
      role="textbox"
      aria-multiline="true"
      aria-label="Description"
      [innerHTML]="html()"
      (input)="dirty.set(true)"
      (keydown.control.enter)="submit()"
      (keydown.meta.enter)="submit()"
      (keydown.escape)="cancel($event)"
    ></div>
    @if (tooLong()) {
      <p class="error" role="alert">The description is too long.</p>
    }
    @if (dirty()) {
      <div class="row">
        <button mat-flat-button type="button" (click)="submit()">Save description</button>
        <button mat-button type="button" (click)="reset()">Cancel</button>
        <span class="hint">Ctrl+Enter saves, Esc cancels</span>
      </div>
    }
  `,
})
export class DescriptionEditor {
  /** The stored (sanitized) description. */
  readonly html = input.required<string>();
  /** Emits the edited HTML when the user saves. */
  readonly save = output<string>();

  /** True after the text was changed and not yet saved. */
  protected readonly dirty = signal(false);
  /** True when the last save attempt exceeded the length limit. */
  protected readonly tooLong = signal(false);

  private readonly sanitizer = inject(DomSanitizer);
  private readonly dialogs = inject(Dialogs);
  private readonly area = viewChild.required<ElementRef<HTMLDivElement>>('area');

  /**
   * Applies a formatting command to the selection. The buttons cancel their
   * mousedown, so the editing area keeps its selection; keyboard users press
   * them like any button.
   *
   * @param command A `document.execCommand` name.
   */
  protected format(command: string): void {
    // execCommand is deprecated but is still the only built-in way to format
    // a content-editable selection without an editor library.
    document.execCommand(command);
    this.dirty.set(true);
  }

  /**
   * Turns the selection into a link after asking for an http(s) or mailto URL.
   *
   * @returns Resolves once the link is added or the dialog cancelled.
   */
  protected async link(): Promise<void> {
    // The dialog takes focus, so the selection is kept and restored after it.
    const selection = window.getSelection();
    const range = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const url =
      (await this.dialogs.prompt({
        title: 'Add a link',
        label: 'Link address (https://… or mailto:…)',
        confirm: 'Add link',
      })) ?? '';
    if (!SAFE_LINK.test(url)) return;
    this.area().nativeElement.focus();
    if (range !== null) {
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    document.execCommand('createLink', false, url);
    this.dirty.set(true);
  }

  /**
   * Esc throws the edits away; without edits it lets the drawer close.
   *
   * @param event The key event.
   */
  protected cancel(event: Event): void {
    if (!this.dirty()) return;
    event.stopPropagation();
    this.reset();
  }

  /**
   * Emits the edited HTML.
   */
  protected submit(): void {
    const html = this.area().nativeElement.innerHTML;
    this.tooLong.set(html.length > ITEM_DESCRIPTION_MAX);
    if (this.tooLong()) return;
    this.save.emit(html);
    this.dirty.set(false);
  }

  /**
   * Throws away unsaved edits.
   */
  protected reset(): void {
    // Same sanitizing as the [innerHTML] binding that first filled the area.
    this.area().nativeElement.innerHTML =
      this.sanitizer.sanitize(SecurityContext.HTML, this.html()) ?? '';
    this.dirty.set(false);
    this.tooLong.set(false);
  }
}
