import {
  ChangeDetectionStrategy,
  Component,
  computed,
  Directive,
  ElementRef,
  inject,
  Injectable,
  signal,
} from '@angular/core';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule } from '@angular/material/dialog';
import { imagesIn, type ViewerImage } from '../core/rich-text';
import { Icon } from './icon';

/** What the viewer shows. */
export interface ImageViewerData {
  /** Every image of the description or note, in order. */
  images: ViewerImage[];
  /** The one to show first. */
  index: number;
}

/**
 * Full-size image viewer (DESIGN §10): one image of a description or note,
 * scaled to fit the window but never above its natural size, named by its
 * alternative text. Left and right arrow keys (and the arrow buttons) step
 * through the other images. Esc, Close or a click on the backdrop close it,
 * and focus returns to the image that opened it (Material's dialog traps
 * and restores focus). It shows the same app-served image and offers no
 * download or link elsewhere.
 */
@Component({
  selector: 'app-image-viewer',
  imports: [MatDialogModule, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(keydown.arrowleft)': 'step(-1)',
    '(keydown.arrowright)': 'step(1)',
  },
  template: `
    <div class="iv-top">
      <h2 mat-dialog-title class="iv-name">{{ current().alt || 'Image' }}</h2>
      @if (many) {
        <span class="iv-count" aria-live="polite"
          >{{ index() + 1 }} of {{ data.images.length }}</span
        >
      }
      <button type="button" class="k-icon-btn" mat-dialog-close aria-label="Close">
        <app-icon name="close" [size]="18" [stroke]="2.2" />
      </button>
    </div>
    <div class="iv-stage">
      @if (many) {
        <button
          type="button"
          class="k-icon-btn iv-step"
          aria-label="Previous image"
          (click)="step(-1)"
        >
          <app-icon name="arrowLeft" [size]="20" />
        </button>
      }
      <img [src]="current().src" [alt]="current().alt" />
      @if (many) {
        <button type="button" class="k-icon-btn iv-step" aria-label="Next image" (click)="step(1)">
          <app-icon name="arrowRight" [size]="20" />
        </button>
      }
    </div>
  `,
})
export class ImageViewerDialog {
  /** The images and the first one to show. */
  protected readonly data = inject<ImageViewerData>(MAT_DIALOG_DATA);
  /** True when there is more than one image to step through. */
  protected readonly many = this.data.images.length > 1;
  /** Index of the image shown. */
  protected readonly index = signal(this.data.index);
  /** The image shown. */
  protected readonly current = computed(
    () => this.data.images[this.index()] ?? { src: '', alt: '' },
  );

  /**
   * Shows the previous or next image, wrapping around at either end.
   *
   * @param delta -1 for the previous image, 1 for the next.
   */
  protected step(delta: number): void {
    const count = this.data.images.length;
    if (count < 2) return;
    this.index.update((i) => (i + delta + count) % count);
  }
}

/**
 * Opens the full-size image viewer.
 */
@Injectable({ providedIn: 'root' })
export class ImageViewer {
  private readonly dialog = inject(MatDialog);

  /**
   * Shows one image of a description or note at full size.
   *
   * @param images Every image of that text, in order.
   * @param index The image clicked.
   */
  open(images: ViewerImage[], index: number): void {
    if (images.length === 0) return;
    this.dialog.open<ImageViewerDialog, ImageViewerData>(ImageViewerDialog, {
      data: { images, index: Math.min(Math.max(index, 0), images.length - 1) },
      panelClass: 'k-image-viewer',
      maxWidth: 'calc(100vw - 32px)',
      maxHeight: 'calc(100vh - 32px)',
    });
  }

  /**
   * Opens the viewer for an image clicked (or chosen with Enter) inside a
   * rendered description or note. Does nothing for other targets.
   *
   * @param event The click or key event.
   * @param container The element holding the rich text.
   * @returns True when the viewer opened.
   */
  openFrom(event: Event, container: Element): boolean {
    const target = event.target;
    if (!(target instanceof HTMLImageElement) || !container.contains(target)) return false;
    event.preventDefault();
    this.openAt(container, target);
    return true;
  }

  /**
   * Opens the viewer at one image of a rendered description or note, with
   * every image of that text to step through.
   *
   * @param container The element holding the rich text.
   * @param image The image to show first.
   */
  openAt(container: Element, image: HTMLImageElement): void {
    this.open(imagesIn(container), [...container.querySelectorAll('img')].indexOf(image));
  }
}

/**
 * Opens the full-size viewer for images inside rendered rich text (a
 * description or note): a click on an image, or Enter while an image has
 * focus (`forDisplay` makes them focusable). The element itself is not
 * interactive; it only passes on events from its images.
 */
@Directive({
  selector: '[appViewImages]',
  host: {
    '(click)': 'open($event)',
    '(keydown.enter)': 'open($event)',
  },
})
export class ViewImages {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly viewer = inject(ImageViewer);

  /**
   * Opens the viewer when the event came from an image.
   *
   * @param event The click or key event.
   */
  protected open(event: Event): void {
    this.viewer.openFrom(event, this.element.nativeElement);
  }
}
