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

/** Link schemes the editor offers; the server allows the same (SPEC §5). */
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

/**
 * A small rich-text editor for item descriptions: bold, italic, lists and
 * links on a content-editable area.
 *
 * The HTML it produces is only a suggestion: the API sanitizes descriptions
 * against an allow-list before storing them (SPEC §5), and Angular sanitizes
 * them again when they are displayed.
 */
@Component({
  selector: 'app-description-editor',
  imports: [MatButtonModule],
  styles: `
    .area {
      min-height: 96px;
      max-height: 320px;
      overflow-y: auto;
      padding: 8px;
      border: 1px solid var(--mat-sys-outline);
      border-radius: 4px;
    }
    .area:focus {
      outline: 2px solid var(--mat-sys-primary);
    }
  `,
  template: `
    <div class="row" role="toolbar" aria-label="Formatting">
      <button mat-button type="button" (mousedown)="format($event, 'bold')">Bold</button>
      <button mat-button type="button" (mousedown)="format($event, 'italic')">Italic</button>
      <button mat-button type="button" (mousedown)="format($event, 'insertUnorderedList')">
        Bullets
      </button>
      <button mat-button type="button" (mousedown)="format($event, 'insertOrderedList')">
        Numbers
      </button>
      <button mat-button type="button" (mousedown)="link($event)">Link</button>
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
    ></div>
    @if (tooLong()) {
      <p class="error" role="alert">The description is too long.</p>
    }
    @if (dirty()) {
      <div class="row">
        <button mat-flat-button type="button" (click)="submit()">Save description</button>
        <button mat-button type="button" (click)="reset()">Cancel</button>
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
  private readonly area = viewChild.required<ElementRef<HTMLDivElement>>('area');

  /**
   * Applies a formatting command to the selection. Runs on mousedown so the
   * editing area keeps its selection.
   *
   * @param event The mouse event.
   * @param command A `document.execCommand` name.
   */
  protected format(event: Event, command: string): void {
    event.preventDefault();
    // execCommand is deprecated but is still the only built-in way to format
    // a content-editable selection without an editor library.
    document.execCommand(command);
    this.dirty.set(true);
  }

  /**
   * Turns the selection into a link after asking for an http(s) or mailto URL.
   *
   * @param event The mouse event.
   */
  protected link(event: Event): void {
    event.preventDefault();
    const url = prompt('Link address (https://… or mailto:…)')?.trim() ?? '';
    if (!SAFE_LINK.test(url)) return;
    document.execCommand('createLink', false, url);
    this.dirty.set(true);
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
