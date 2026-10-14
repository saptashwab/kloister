import {
  afterRenderEffect,
  Component,
  type ElementRef,
  inject,
  input,
  output,
  SecurityContext,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import {
  CdkConnectedOverlay,
  CdkOverlayOrigin,
  type ConnectedPosition,
} from '@angular/cdk/overlay';
import { DomSanitizer } from '@angular/platform-browser';
import { INLINE_IMAGE_TYPES, type InlineImageDto, ITEM_DESCRIPTION_MAX } from '@kloister/shared';
import {
  cleanPastedHtml,
  forEditing,
  isInlineImage,
  type Mentionable,
  mentionAt,
  mentionElement,
  mentionSuggestions,
} from '../../core/rich-text';
import { Dialogs } from '../../ui/dialogs';
import { Icon } from '../../ui/icon';
import { ImageViewer } from '../../ui/image-viewer';
import { ToastService } from '../../ui/toast.service';

/** Link schemes the editor offers; the server allows the same (SPEC §5). */
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

/** Adds images to the edited item's text. */
export interface ImageUploader {
  /** The item's inline-image URL prefix; only images under it are kept when pasting HTML. */
  prefix: string;
  /** Uploads an image and returns where it is served. */
  upload(file: File): Promise<InlineImageDto>;
}

/** A mention being typed: the text node, where its `@` is, and the suggestions. */
interface MentionState {
  /** The text node holding the `@`. */
  node: Text;
  /** Offset of the `@` in the node. */
  start: number;
  /** Suggested people. */
  options: Mentionable[];
  /** Index of the highlighted suggestion. */
  active: number;
}

/** Counts editor instances, for unique element ids. */
let nextId = 0;

/**
 * The rich-text editor of descriptions and notes (DESIGN §10): bold,
 * italic, lists and links on a content-editable area. Ctrl/Cmd+Enter saves
 * and Esc throws the edits away.
 *
 * - Images (PNG, JPEG, GIF or WebP) can be pasted, dropped or picked; each
 *   is uploaded to the item's inline-image endpoint and inserted with the
 *   URL the API returns (SPEC §5). Clicking an image, or "View images",
 *   opens the full-size viewer.
 * - With `mentionables`, typing `@` offers matching people in a listbox
 *   (arrow keys, Enter or Tab to pick, Esc to close); a picked person is
 *   inserted as a mention the API keeps for project members.
 *
 * The HTML it produces is only a suggestion: the API sanitizes it against
 * an allow-list before storing it, and Angular sanitizes it again for
 * display and before it is edited.
 */
@Component({
  selector: 'app-rich-text-editor',
  imports: [MatButtonModule, Icon, CdkConnectedOverlay, CdkOverlayOrigin],
  host: { class: 'k-rte' },
  template: `
    <div class="tools" role="toolbar" [attr.aria-label]="label() + ' formatting'">
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
      @if (uploadImage()) {
        <button type="button" (mousedown)="$event.preventDefault()" (click)="picker.click()">
          <app-icon name="image" [size]="14" />Image
        </button>
        <input
          #picker
          type="file"
          hidden
          multiple
          [attr.accept]="imageTypes"
          (change)="picked(picker)"
        />
      }
      @if (imageCount() > 0) {
        <button type="button" (click)="viewImages()">View images ({{ imageCount() }})</button>
      }
    </div>
    <div class="area-wrap">
      <div
        #area
        class="area"
        contenteditable="true"
        role="textbox"
        aria-multiline="true"
        aria-autocomplete="list"
        [class.dragging]="dragging()"
        [attr.aria-label]="label()"
        [attr.aria-describedby]="ids.hint"
        [attr.aria-controls]="mention() ? ids.list : null"
        [attr.aria-expanded]="mention() ? 'true' : null"
        [attr.aria-activedescendant]="mention() ? ids.list + '-' + mention()!.active : null"
        [attr.data-placeholder]="placeholder()"
        (input)="changed(); trackMention()"
        (keyup)="trackMention($event)"
        (click)="clicked($event)"
        (keydown)="keydown($event)"
        (paste)="paste($event)"
        (dragover)="dragOver($event)"
        (dragleave)="dragging.set(false)"
        (drop)="drop($event)"
        (blur)="closeMention()"
      ></div>
      <span
        class="k-caret-origin"
        cdkOverlayOrigin
        #caret="cdkOverlayOrigin"
        [style.left.px]="caretPosition().x"
        [style.top.px]="caretPosition().y"
        aria-hidden="true"
      ></span>
      <ng-template
        cdkConnectedOverlay
        [cdkConnectedOverlayOrigin]="caret"
        [cdkConnectedOverlayOpen]="mention() !== null"
        [cdkConnectedOverlayPositions]="mentionPositions"
        [cdkConnectedOverlayPush]="true"
        [cdkConnectedOverlayViewportMargin]="8"
      >
        @if (mention(); as m) {
          <ul class="k-popover mention-list" role="listbox" [id]="ids.list" aria-label="People">
            @for (p of m.options; track p.id; let i = $index) {
              <li
                role="option"
                [id]="ids.list + '-' + i"
                [attr.aria-selected]="i === m.active"
                (mousedown)="$event.preventDefault(); choose(p)"
              >
                {{ p.name }}
              </li>
            }
          </ul>
        }
      </ng-template>
    </div>
    @if (uploading() > 0) {
      <p class="hint" role="status">
        Uploading {{ uploading() }} {{ uploading() === 1 ? 'image' : 'images' }}…
      </p>
    }
    @if (tooLong()) {
      <p class="error" role="alert">This text is too long.</p>
    }
    <p class="hint" [id]="ids.hint">{{ hint() }}</p>
    @if (dirty() || alwaysShowActions()) {
      <div class="row">
        <button mat-flat-button type="button" [disabled]="uploading() > 0" (click)="submit()">
          {{ saveLabel() }}
        </button>
        @if (dirty() || showCancel()) {
          <button mat-button type="button" (click)="reset(); cancelled.emit()">Cancel</button>
        }
        <span class="hint">Ctrl+Enter saves, Esc cancels</span>
      </div>
    }
  `,
})
export class RichTextEditor {
  /** The stored (sanitized) HTML. */
  readonly html = input.required<string>();
  /** Accessible name of the editing area, e.g. "Description". */
  readonly label = input('Description');
  /** Text of the save button. */
  readonly saveLabel = input('Save description');
  /** Shown while the area is empty. */
  readonly placeholder = input('');
  /** Help text under the area. */
  readonly hint = input('Paste or drop PNG, JPEG, GIF or WebP images.');
  /** Show the save button even before anything was typed (note composer). */
  readonly alwaysShowActions = input(false);
  /** Show Cancel even before anything was changed (editing a note). */
  readonly showCancel = input(false);
  /** Empty the area after saving (note composer). */
  readonly clearOnSave = input(false);
  /** Longest HTML accepted. */
  readonly maxLength = input(ITEM_DESCRIPTION_MAX);
  /** Uploads pasted, dropped or picked images; null where images cannot be added. */
  readonly uploadImage = input<ImageUploader | null>(null);
  /** People who can be mentioned with `@`; empty to turn mentions off. */
  readonly mentionables = input<readonly Mentionable[]>([]);
  /** Emits the edited HTML when the user saves. */
  readonly save = output<string>();
  /** Emits when the user cancels. */
  readonly cancelled = output<void>();

  /** True after the text was changed and not yet saved. */
  protected readonly dirty = signal(false);
  /** True when the last save attempt exceeded the length limit. */
  protected readonly tooLong = signal(false);
  /** Images still uploading. */
  protected readonly uploading = signal(0);
  /** Files are being dragged over the area. */
  protected readonly dragging = signal(false);
  /** Images in the area. */
  protected readonly imageCount = signal(0);
  /** The mention being typed, while the listbox is open. */
  protected readonly mention = signal<MentionState | null>(null);
  /** Caret coordinates relative to the editor wrapper. */
  protected readonly caretPosition = signal({ x: 0, y: 0 });
  /** Prefer below the caret, falling back above when space is short. */
  protected readonly mentionPositions: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top' },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom' },
  ];
  /** Accepted image types, for the file picker. */
  protected readonly imageTypes = INLINE_IMAGE_TYPES.join(',');
  /** Element ids of this instance. */
  protected readonly ids = (() => {
    const n = nextId++;
    return { hint: `rte-hint-${n}`, list: `rte-mentions-${n}` };
  })();

  private readonly sanitizer = inject(DomSanitizer);
  private readonly dialogs = inject(Dialogs);
  private readonly toast = inject(ToastService);
  private readonly viewer = inject(ImageViewer);
  private readonly area = viewChild.required<ElementRef<HTMLDivElement>>('area');
  /** Where images being uploaded will go. */
  private insertAt: Range | null = null;

  /**
   * Puts the stored text into the area whenever it changes and nothing is
   * being edited.
   */
  constructor() {
    afterRenderEffect(() => {
      const mention = this.mention();
      if (mention)
        document
          .getElementById(`${this.ids.list}-${mention.active}`)
          ?.scrollIntoView({ block: 'nearest' });
    });
    afterRenderEffect(() => {
      const html = this.html();
      untracked(() => {
        if (!this.dirty()) this.load(html);
      });
    });
  }

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
    this.changed();
  }

  /**
   * Turns the selection into a link after asking for an http(s) or mailto URL.
   *
   * @returns Resolves once the link is added or the dialog cancelled.
   */
  protected async link(): Promise<void> {
    // The dialog takes focus, so the selection is kept and restored after it.
    const range = this.selectionInArea();
    const url =
      (await this.dialogs.prompt({
        title: 'Add a link',
        label: 'Link address (https://… or mailto:…)',
        confirm: 'Add link',
      })) ?? '';
    if (!SAFE_LINK.test(url)) return;
    this.restore(range);
    document.execCommand('createLink', false, url);
    this.changed();
  }

  /** Marks the text as changed and recounts its images. */
  protected changed(): void {
    this.dirty.set(true);
    this.tooLong.set(false);
    this.imageCount.set(this.area().nativeElement.querySelectorAll('img').length);
  }

  /**
   * Keyboard handling: the mention listbox takes the arrow keys, Enter, Tab
   * and Esc while open; otherwise Ctrl/Cmd+Enter saves and Esc cancels.
   *
   * @param event The key event.
   */
  protected keydown(event: KeyboardEvent): void {
    const m = this.mention();
    if (m !== null) {
      const count = m.options.length;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        this.mention.set({ ...m, active: (m.active + step + count) % count });
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        const person = m.options[m.active];
        if (person !== undefined) this.choose(person);
        return;
      }
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.closeMention();
        return;
      }
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.submit();
    } else if (event.key === 'Escape' && this.dirty()) {
      // Without edits, Esc is left to the drawer, which closes.
      event.stopPropagation();
      this.reset();
      this.cancelled.emit();
    }
  }

  /**
   * Opens, updates or closes the mention listbox for the text before the
   * caret.
   *
   * @param event The key event; navigation keys of an open listbox are skipped.
   */
  protected trackMention(event?: KeyboardEvent): void {
    // Escape must not reopen the list on keyup after keydown dismissed it.
    if (event?.key === 'Escape') return;
    if (
      event !== undefined &&
      this.mention() !== null &&
      ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)
    ) {
      return;
    }
    const people = this.mentionables();
    const selection = window.getSelection();
    const node = selection?.anchorNode;
    if (
      people.length === 0 ||
      selection === null ||
      !selection.isCollapsed ||
      !(node instanceof Text) ||
      !this.area().nativeElement.contains(node)
    ) {
      this.closeMention();
      return;
    }
    const found = mentionAt(node.data.slice(0, selection.anchorOffset));
    const options = found === null ? [] : mentionSuggestions(people, found.query);
    if (found === null || options.length === 0) {
      this.closeMention();
      return;
    }
    const active = Math.min(this.mention()?.active ?? 0, options.length - 1);
    const range = selection.getRangeAt(0).cloneRange();
    // A range over the preceding character gives a rectangle even when
    // collapsed caret ranges are empty at a line break.
    range.setStart(node, Math.max(found.start, selection.anchorOffset - 1));
    const rect = range.getBoundingClientRect();
    const wrap = this.area().nativeElement.parentElement?.getBoundingClientRect();
    if (wrap) this.caretPosition.set({ x: rect.right - wrap.left, y: rect.bottom - wrap.top });
    this.mention.set({ node, start: found.start, options, active });
  }

  /**
   * Replaces the typed `@name` with a mention of the chosen person.
   *
   * @param person Who to mention.
   */
  protected choose(person: Mentionable): void {
    const m = this.mention();
    const selection = window.getSelection();
    if (m === null || selection === null) return;
    // From the "@" to the caret: the typed name is replaced by the mention.
    const end = selection.anchorNode === m.node ? selection.anchorOffset : m.node.length;
    const range = document.createRange();
    range.setStart(m.node, m.start);
    range.setEnd(m.node, Math.max(end, m.start));
    range.deleteContents();
    const space = document.createTextNode(' ');
    range.insertNode(space);
    range.insertNode(mentionElement(person));
    range.setStartAfter(space);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    this.closeMention();
    this.changed();
  }

  /** Closes the mention listbox. */
  protected closeMention(): void {
    this.mention.set(null);
  }

  /**
   * A click on an image opens the full-size viewer; any other click may
   * move the caret into or out of a mention being typed.
   *
   * @param event The click.
   */
  protected clicked(event: MouseEvent): void {
    if (this.viewer.openFrom(event, this.area().nativeElement)) return;
    this.trackMention();
  }

  /** Opens the full-size viewer at the first image. */
  protected viewImages(): void {
    const area = this.area().nativeElement;
    const first = area.querySelector('img');
    if (first !== null) this.viewer.openAt(area, first);
  }

  /**
   * Pasted images are uploaded and inserted; pasted HTML is cleaned first so
   * nothing is shown from another host; plain text pastes as usual.
   *
   * @param event The paste event.
   */
  protected paste(event: ClipboardEvent): void {
    const data = event.clipboardData;
    if (data === null) return;
    const files = [...data.files];
    if (files.length > 0) {
      event.preventDefault();
      void this.addImages(files);
      return;
    }
    const html = data.getData('text/html');
    if (html !== '') {
      event.preventDefault();
      document.execCommand(
        'insertHTML',
        false,
        cleanPastedHtml(html, (h) => this.clean(h), this.uploadImage()?.prefix ?? null),
      );
      this.changed();
    }
  }

  /**
   * Lets files be dropped onto the area.
   *
   * @param event The drag event.
   */
  protected dragOver(event: DragEvent): void {
    if (event.dataTransfer?.types.includes('Files') !== true) return;
    event.preventDefault();
    this.dragging.set(true);
  }

  /**
   * Dropped images are uploaded and inserted where they were dropped.
   *
   * @param event The drop event.
   */
  protected drop(event: DragEvent): void {
    this.dragging.set(false);
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    const at = document.caretRangeFromPoint?.(event.clientX, event.clientY) ?? null;
    void this.addImages(files, at);
  }

  /**
   * Uploads the images chosen with the Image button.
   *
   * @param input The file input.
   * @returns Resolves once inserted.
   */
  protected async picked(input: HTMLInputElement): Promise<void> {
    const files = [...(input.files ?? [])];
    input.value = '';
    await this.addImages(files);
  }

  /**
   * Emits the edited HTML, unless it is empty or too long.
   */
  protected submit(): void {
    if (this.uploading() > 0) return;
    const area = this.area().nativeElement;
    const html = area.innerHTML;
    this.tooLong.set(html.length > this.maxLength());
    if (this.tooLong()) return;
    const empty = (area.textContent ?? '').trim() === '' && area.querySelector('img') === null;
    if (empty && this.clearOnSave()) return;
    this.save.emit(html);
    this.dirty.set(false);
    if (this.clearOnSave()) this.load('');
  }

  /**
   * Throws away unsaved edits.
   */
  protected reset(): void {
    this.dirty.set(false);
    this.tooLong.set(false);
    this.closeMention();
    this.load(this.html());
  }

  /**
   * Uploads images one after another and inserts each where the caret was
   * (or where they were dropped). Other files are refused with a hint.
   *
   * @param files Pasted, dropped or picked files.
   * @param at Where to insert; the current caret by default.
   * @returns Resolves once all are handled.
   */
  private async addImages(files: File[], at: Range | null = null): Promise<void> {
    const upload = this.uploadImage();
    const images = files.filter(isInlineImage);
    if (upload === null || images.length < files.length) {
      this.toast.error(
        upload === null
          ? 'Images cannot be added here.'
          : 'Only PNG, JPEG, GIF and WebP images can be added here; attach other files under Attachments.',
      );
    }
    if (upload === null || images.length === 0) return;
    this.insertAt = at ?? this.selectionInArea();
    for (const file of images) {
      this.uploading.update((n) => n + 1);
      try {
        const image = await upload.upload(file);
        this.insertImage(image);
      } catch (error) {
        this.toast.error(error);
      } finally {
        this.uploading.update((n) => n - 1);
      }
    }
  }

  /**
   * Inserts an uploaded image at the remembered place, or at the end.
   *
   * @param image The stored image.
   */
  private insertImage(image: InlineImageDto): void {
    const area = this.area().nativeElement;
    const img = document.createElement('img');
    img.setAttribute('src', image.url);
    img.setAttribute('alt', image.name);
    const range = this.insertAt;
    if (range !== null && area.contains(range.startContainer)) {
      range.collapse(false);
      range.insertNode(img);
      range.setStartAfter(img);
      range.collapse(true);
    } else {
      area.appendChild(img);
    }
    this.changed();
  }

  /**
   * The current selection, if it is inside the area.
   *
   * @returns A copy of the range, or null.
   */
  private selectionInArea(): Range | null {
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    return this.area().nativeElement.contains(range.startContainer) ? range.cloneRange() : null;
  }

  /**
   * Focuses the area and restores a remembered selection.
   *
   * @param range The selection, or null.
   */
  private restore(range: Range | null): void {
    this.area().nativeElement.focus();
    if (range === null) return;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  /**
   * Puts stored HTML into the area, sanitized, with mentions kept whole.
   *
   * @param html Stored HTML.
   */
  private load(html: string): void {
    const area = this.area().nativeElement;
    area.innerHTML = forEditing(html, (h) => this.clean(h));
    this.imageCount.set(area.querySelectorAll('img').length);
  }

  /**
   * Angular's HTML sanitizer.
   *
   * @param html HTML.
   * @returns Safe HTML.
   */
  private clean(html: string): string {
    return this.sanitizer.sanitize(SecurityContext.HTML, html) ?? '';
  }
}
