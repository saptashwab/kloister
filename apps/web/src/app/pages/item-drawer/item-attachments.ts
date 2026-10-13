import { DatePipe } from '@angular/common';
import { Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import type { AttachmentDto } from '@kloister/shared';
import { AnnotationsApiService } from '../../core/annotations-api.service';
import { errorMessage } from '../../core/api';
import { Dialogs } from '../../ui/dialogs';
import { Icon } from '../../ui/icon';
import { ToastService } from '../../ui/toast.service';

/**
 * A file size for people: bytes, KB or MB with one decimal.
 *
 * @param bytes Size in bytes.
 * @returns E.g. "820 bytes", "14.2 KB", "3.1 MB".
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * An item's attachments in the drawer (SPEC §6, DESIGN §10): the list with
 * download links, "Attach files" and dropping files onto the section, and
 * deleting with a confirmation.
 *
 * Downloads come from the API, which serves them only to people who can see
 * the item and always as downloads (SPEC §5). Adding needs the item's
 * `can.annotate` on an unarchived project (`canAdd`); deleting follows each
 * attachment's `can.delete`. The API checks both again and enforces the
 * size limit and the project's quota; its refusals are shown as toasts.
 */
@Component({
  selector: 'app-item-attachments',
  imports: [DatePipe, MatButtonModule, Icon],
  host: {
    class: 'k-files',
    '[class.dragging]': 'dragging()',
    '(dragover)': 'dragOver($event)',
    '(dragleave)': 'dragging.set(false)',
    '(drop)': 'drop($event)',
  },
  template: `
    <div class="files-head">
      <h2 id="d-files">Attachments</h2>
      @if (canAdd()) {
        <button mat-button type="button" (click)="picker.click()">
          <app-icon name="paperclip" />Attach files
        </button>
        <input #picker type="file" hidden multiple (change)="picked(picker)" />
      }
    </div>
    @if (error()) {
      <p class="k-alert" role="alert">{{ error() }}</p>
    }
    <ul class="files" aria-labelledby="d-files">
      @for (a of rows(); track a.id) {
        <li class="file-row">
          <app-icon name="file" [size]="18" />
          <a class="file-name" [href]="a.url" download>{{ a.name }}</a>
          <span class="file-meta"
            >{{ size(a.sizeBytes) }} · {{ a.uploaderName }} ·
            {{ a.createdAt | date: 'mediumDate' }}</span
          >
          @if (a.can.delete && writable()) {
            <button
              type="button"
              class="k-icon-btn sm"
              [attr.aria-label]="'Delete attachment ' + a.name"
              (click)="remove(a)"
            >
              <app-icon name="trash" />
            </button>
          }
        </li>
      } @empty {
        <li class="muted">No attachments.</li>
      }
    </ul>
    @if (cursor()) {
      <button mat-button type="button" (click)="more()">Show more attachments</button>
    }
    @if (uploading() > 0) {
      <p class="hint" role="status">
        Uploading {{ uploading() }} {{ uploading() === 1 ? 'file' : 'files' }}…
      </p>
    } @else if (canAdd()) {
      <p class="hint">Attach files with the button or drop them here.</p>
    }
  `,
})
export class ItemAttachments {
  private readonly api = inject(AnnotationsApiService);
  private readonly dialogs = inject(Dialogs);
  private readonly toast = inject(ToastService);

  /** Project id. */
  readonly projectId = input.required<string>();
  /** Item id. */
  readonly itemId = input.required<string>();
  /** The caller may add files (the item's `can.annotate`, project not archived). */
  readonly canAdd = input(false);
  /** False on archived projects, which are read-only. */
  readonly writable = input(true);
  /** Emits after a file was added or deleted, so the history can reload. */
  readonly changed = output<void>();

  /** Loaded attachments, newest first. */
  protected readonly rows = signal<AttachmentDto[]>([]);
  /** Cursor for more, or null. */
  protected readonly cursor = signal<string | null>(null);
  /** Files still uploading. */
  protected readonly uploading = signal(0);
  /** Files are being dragged over the section. */
  protected readonly dragging = signal(false);
  /** Last load error, if any. */
  protected readonly error = signal('');
  /** Counts first-page loads, so stale answers are dropped. */
  private loadRun = 0;

  /** Loads the first page whenever the item changes. */
  constructor() {
    effect(() => {
      const projectId = this.projectId();
      const itemId = this.itemId();
      untracked(() => void this.load(projectId, itemId, undefined));
    });
  }

  /**
   * A file size for the list.
   *
   * @param bytes Size in bytes.
   * @returns The text.
   */
  protected size(bytes: number): string {
    return formatSize(bytes);
  }

  /**
   * Loads the next page.
   *
   * @returns Resolves once loaded.
   */
  protected more(): Promise<void> {
    return this.load(this.projectId(), this.itemId(), this.cursor() ?? undefined);
  }

  /**
   * Lets files be dropped onto the section when the caller may add them.
   *
   * @param event The drag event.
   */
  protected dragOver(event: DragEvent): void {
    if (!this.canAdd() || event.dataTransfer?.types.includes('Files') !== true) return;
    event.preventDefault();
    this.dragging.set(true);
  }

  /**
   * Uploads dropped files.
   *
   * @param event The drop event.
   * @returns Resolves once uploaded.
   */
  protected async drop(event: DragEvent): Promise<void> {
    this.dragging.set(false);
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!this.canAdd() || files.length === 0) return;
    event.preventDefault();
    await this.upload(files);
  }

  /**
   * Uploads the files chosen with "Attach files".
   *
   * @param input The file input.
   * @returns Resolves once uploaded.
   */
  protected async picked(input: HTMLInputElement): Promise<void> {
    const files = [...(input.files ?? [])];
    input.value = '';
    await this.upload(files);
  }

  /**
   * Deletes an attachment after confirmation.
   *
   * @param attachment The attachment.
   * @returns Resolves once deleted.
   */
  protected async remove(attachment: AttachmentDto): Promise<void> {
    const confirmed = await this.dialogs.confirm({
      title: `Delete ${attachment.name}?`,
      message: 'The file is deleted for everyone. This cannot be undone.',
      confirm: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await this.api.removeAttachment(this.projectId(), this.itemId(), attachment.id);
      this.rows.update((rows) => rows.filter((r) => r.id !== attachment.id));
      this.toast.show(`${attachment.name} deleted`);
      this.changed.emit();
    } catch (error) {
      this.toast.error(error);
    }
  }

  /**
   * Uploads files one after another; each refusal (size, quota) is shown and
   * the others still go up.
   *
   * @param files The files.
   * @returns Resolves once all are handled.
   */
  private async upload(files: File[]): Promise<void> {
    const projectId = this.projectId();
    const itemId = this.itemId();
    const added: string[] = [];
    for (const file of files) {
      this.uploading.update((n) => n + 1);
      try {
        const attachment = await this.api.attach(projectId, itemId, file);
        // Another item was opened meanwhile: its list must not show this file.
        if (itemId === this.itemId()) this.rows.update((rows) => [attachment, ...rows]);
        added.push(attachment.name);
      } catch (error) {
        this.toast.error(error);
      } finally {
        this.uploading.update((n) => n - 1);
      }
    }
    if (added.length > 0) {
      this.toast.show(
        added.length === 1 ? `${added[0] ?? 'File'} attached` : `${added.length} files attached`,
      );
      this.changed.emit();
    }
  }

  /**
   * Loads a page and appends it (or replaces the list for the first page).
   *
   * @param projectId Project id.
   * @param itemId Item id.
   * @param cursor Cursor, or undefined for the first page.
   * @returns Resolves once loaded.
   */
  private async load(projectId: string, itemId: string, cursor: string | undefined): Promise<void> {
    const run = cursor === undefined ? ++this.loadRun : this.loadRun;
    this.error.set('');
    try {
      const page = await this.api.attachments(projectId, itemId, cursor);
      if (run !== this.loadRun) return;
      this.rows.update((rows) => (cursor === undefined ? page.items : [...rows, ...page.items]));
      this.cursor.set(page.nextCursor);
    } catch (error) {
      if (run === this.loadRun) this.error.set(errorMessage(error));
    }
  }
}
