import { Component, computed, inject, input, output, signal } from '@angular/core';
import { NOTE_BODY_MAX, type NoteDto } from '@kloister/shared';
import { AnnotationsApiService } from '../../core/annotations-api.service';
import { forDisplay, type Mentionable } from '../../core/rich-text';
import { StaticAvatar } from '../../ui/avatar';
import { Dialogs } from '../../ui/dialogs';
import { Icon } from '../../ui/icon';
import { ViewImages } from '../../ui/image-viewer';
import { ToastService } from '../../ui/toast.service';
import { type ImageUploader, RichTextEditor } from './rich-text-editor';
import { AppDatePipe } from '../../ui/app-date.pipe';

/**
 * One note in an item's thread (SPEC §6): author, time, the sanitized body
 * with its mentions and images (click or Enter opens the full-size viewer),
 * and Edit and Delete where the note's `can` allows them on an unarchived
 * project. Only the author edits; the author or a moderator deletes, after
 * a confirmation. The API checks both again.
 */
@Component({
  selector: 'app-item-note',
  imports: [AppDatePipe, Icon, RichTextEditor, StaticAvatar, ViewImages],
  host: { class: 'note' },
  template: `
    @let n = note();
    <app-avatar-static [userId]="n.authorId" [name]="n.authorName" />
    <article class="note-main" [attr.aria-label]="'Note by ' + n.authorName">
      <div class="note-head">
        <strong>{{ n.authorName }}</strong>
        <span class="when">{{ n.createdAt | appDate }}</span>
        @if (n.editedAt) {
          <span class="when">(edited)</span>
        }
        <span class="spacer"></span>
        @if (writable() && n.can.edit && !editing()) {
          <button
            type="button"
            class="k-icon-btn sm"
            aria-label="Edit note"
            (click)="editing.set(true)"
          >
            <app-icon name="edit" />
          </button>
        }
        @if (writable() && n.can.delete) {
          <button type="button" class="k-icon-btn sm" aria-label="Delete note" (click)="remove()">
            <app-icon name="trash" />
          </button>
        }
      </div>
      @if (editing()) {
        <app-rich-text-editor
          [html]="n.body"
          label="Note"
          saveLabel="Save note"
          hint="Type @ to mention someone, paste or drop an image."
          [alwaysShowActions]="true"
          [showCancel]="true"
          [maxLength]="noteMax"
          [mentionables]="mentionables()"
          [uploadImage]="uploadImage()"
          (save)="saveEdit($event)"
          (cancelled)="editing.set(false)"
        />
      } @else {
        <div class="note-body k-rich" appViewImages [innerHTML]="display()"></div>
      }
    </article>
  `,
})
export class ItemNote {
  private readonly api = inject(AnnotationsApiService);
  private readonly dialogs = inject(Dialogs);
  private readonly toast = inject(ToastService);

  /** The note. */
  readonly note = input.required<NoteDto>();
  /** Project id. */
  readonly projectId = input.required<string>();
  /** Item id. */
  readonly itemId = input.required<string>();
  /** False on archived projects, which are read-only. */
  readonly writable = input(true);
  /** People who can be mentioned while editing. */
  readonly mentionables = input<readonly Mentionable[]>([]);
  /** Uploads images pasted into the note while editing. */
  readonly uploadImage = input<ImageUploader | null>(null);
  /** Emits the note after an edit. */
  readonly updated = output<NoteDto>();
  /** Emits the note's id after it was deleted. */
  readonly removed = output<string>();

  /** Longest note accepted. */
  protected readonly noteMax = NOTE_BODY_MAX;
  /** True while the note is being edited. */
  protected readonly editing = signal(false);
  /** The body prepared for display. */
  protected readonly display = computed(() => forDisplay(this.note().body));

  /**
   * Saves an edit.
   *
   * @param html The edited HTML.
   * @returns Resolves once saved.
   */
  protected async saveEdit(html: string): Promise<void> {
    try {
      const note = await this.api.updateNote(this.projectId(), this.itemId(), this.note().id, {
        body: html,
      });
      this.editing.set(false);
      this.updated.emit(note);
      this.toast.show('Note saved');
    } catch (error) {
      this.toast.error(error);
    }
  }

  /**
   * Deletes the note after confirmation.
   *
   * @returns Resolves once deleted.
   */
  protected async remove(): Promise<void> {
    const n = this.note();
    const confirmed = await this.dialogs.confirm({
      title: 'Delete this note?',
      message: `The note by ${n.authorName} is deleted for everyone. This cannot be undone.`,
      confirm: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await this.api.removeNote(this.projectId(), this.itemId(), n.id);
      this.removed.emit(n.id);
      this.toast.show('Note deleted');
    } catch (error) {
      this.toast.error(error);
    }
  }
}
