import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { type AuditEntryDto, AuditAction, NOTE_BODY_MAX, type NoteDto } from '@kloister/shared';
import { describeActivity } from '../../core/activity';
import { AnnotationsApiService } from '../../core/annotations-api.service';
import { errorMessage } from '../../core/api';
import { ItemsApiService } from '../../core/items-api.service';
import { ProjectContext } from '../../core/project-context';
import type { Mentionable } from '../../core/rich-text';
import { StaticAvatar } from '../../ui/avatar';
import { ToastService } from '../../ui/toast.service';
import { ItemNote } from './item-note';
import { type ImageUploader, RichTextEditor } from './rich-text-editor';
import { AppDatePipe } from '../../ui/app-date.pipe';

/** One history entry ready for display. */
interface HistoryRow {
  /** Entry id. */
  id: string;
  /** Who did it. */
  actor: string;
  /** Their user id, for the avatar colour (the email when the account is gone). */
  actorKey: string;
  /** ISO timestamp. */
  at: string;
  /** What happened. */
  lines: string[];
  /** The audit action, to leave note entries out where the notes show. */
  action: string;
}

/** One entry of the merged timeline. */
type Entry =
  { kind: 'note'; at: string; note: NoteDto } | { kind: 'history'; at: string; row: HistoryRow };

/** What the activity section shows. */
type Filter = 'all' | 'notes' | 'history';

/**
 * An item's activity (SPEC §6, DESIGN §10): its notes thread and its
 * history, newest first, filtered by All, Notes or History, with the note
 * composer on top ("type @ to mention someone, paste or drop an image").
 *
 * Notes come from `GET …/notes`, the history from `GET …/activity` (the
 * audit log), each a page at a time; "Show older" loads the next pages.
 * References to items outside the caller's scope arrive as null and are
 * shown as "another item". The composer is shown only with the item's
 * `can.annotate` on an unarchived project; the API checks again.
 */
@Component({
  selector: 'app-item-activity',
  imports: [
    AppDatePipe,
    MatButtonModule,
    MatButtonToggleModule,
    ItemNote,
    RichTextEditor,
    StaticAvatar,
  ],
  host: { class: 'k-activity' },
  template: `
    <div class="activity-head">
      <h2 id="d-activity">Activity</h2>
      <mat-button-toggle-group
        class="k-segmented"
        aria-label="Show"
        hideSingleSelectionIndicator
        [value]="filter()"
        (change)="filter.set($event.value)"
      >
        <mat-button-toggle value="all">All</mat-button-toggle>
        <mat-button-toggle value="notes">Notes</mat-button-toggle>
        <mat-button-toggle value="history">History</mat-button-toggle>
      </mat-button-toggle-group>
    </div>
    @if (canAnnotate() && filter() !== 'history') {
      <app-rich-text-editor
        class="composer"
        html=""
        label="New note"
        saveLabel="Add note"
        placeholder="Write a note…"
        [hint]="
          mentionables().length
            ? 'Type @ to mention someone, paste or drop an image.'
            : 'Paste or drop an image.'
        "
        [alwaysShowActions]="true"
        [clearOnSave]="true"
        [maxLength]="noteMax"
        [mentionables]="mentionables()"
        [uploadImage]="uploadImage()"
        (save)="post($event)"
      />
    }
    @if (error()) {
      <p class="k-alert" role="alert">{{ error() }}</p>
    }
    <ol class="timeline" aria-labelledby="d-activity">
      @for (
        entry of entries();
        track entry.kind + (entry.kind === 'note' ? entry.note.id : entry.row.id)
      ) {
        <li>
          @if (entry.kind === 'note') {
            <app-item-note
              [note]="entry.note"
              [projectId]="projectId()"
              [itemId]="itemId()"
              [writable]="writable()"
              [mentionables]="mentionables()"
              [uploadImage]="uploadImage()"
              (updated)="replace($event)"
              (removed)="forget($event)"
            />
          } @else {
            <div class="history">
              <app-avatar-static [userId]="entry.row.actorKey" [name]="entry.row.actor" />
              <div>
                <strong>{{ entry.row.actor }}</strong> {{ entry.row.lines.join('; ') }}
                <div class="when">{{ entry.row.at | appDate }}</div>
              </div>
            </div>
          }
        </li>
      } @empty {
        <li class="muted">{{ emptyText() }}</li>
      }
    </ol>
    @if (noteCursor() || historyCursor()) {
      <button mat-button type="button" (click)="more()">Show older activity</button>
    }
  `,
})
export class ItemActivity {
  private readonly items = inject(ItemsApiService);
  private readonly annotations = inject(AnnotationsApiService);
  private readonly ctx = inject(ProjectContext);
  private readonly toast = inject(ToastService);

  /** Project id. */
  readonly projectId = input.required<string>();
  /** Item id. */
  readonly itemId = input.required<string>();
  /** Bumped by the drawer after each change, to reload. */
  readonly version = input(0);
  /** The caller may add notes (the item's `can.annotate`, project not archived). */
  readonly canAnnotate = input(false);
  /** False on archived projects, which are read-only. */
  readonly writable = input(true);
  /** People who can be mentioned. */
  readonly mentionables = input<readonly Mentionable[]>([]);
  /** Uploads images pasted or dropped into notes. */
  readonly uploadImage = input<ImageUploader | null>(null);

  /** Longest note accepted. */
  protected readonly noteMax = NOTE_BODY_MAX;
  /** What is shown. */
  protected readonly filter = signal<Filter>('all');
  /** Loaded notes, newest first. */
  protected readonly notes = signal<NoteDto[]>([]);
  /** Loaded history entries, newest first. */
  protected readonly history = signal<HistoryRow[]>([]);
  /** Cursor for older notes, or null. */
  protected readonly noteCursor = signal<string | null>(null);
  /** Cursor for older history, or null. */
  protected readonly historyCursor = signal<string | null>(null);
  /** Last error, if any. */
  protected readonly error = signal('');
  /** Counts first-page loads, so stale answers are dropped. */
  private loadRun = 0;

  /**
   * The timeline for the chosen filter. In "All", history entries about
   * notes being added or edited are left out, since the notes themselves show.
   */
  protected readonly entries = computed<Entry[]>(() => {
    const filter = this.filter();
    const notes: Entry[] =
      filter === 'history'
        ? []
        : this.notes().map((note) => ({ kind: 'note', at: note.createdAt, note }));
    const history: Entry[] =
      filter === 'notes'
        ? []
        : this.history()
            .filter(
              (row) =>
                filter === 'history' ||
                (row.action !== AuditAction.NOTE_ADDED && row.action !== AuditAction.NOTE_UPDATED),
            )
            .map((row) => ({ kind: 'history', at: row.at, row }));
    return [...notes, ...history].sort((a, b) => b.at.localeCompare(a.at));
  });

  /** What an empty timeline says. */
  protected readonly emptyText = computed(() => {
    switch (this.filter()) {
      case 'notes':
        return 'No notes yet.';
      case 'history':
        return 'No changes yet.';
      default:
        return 'No activity yet.';
    }
  });

  /**
   * Reloads the first pages whenever the item or its version changes.
   */
  constructor() {
    effect(() => {
      const projectId = this.projectId();
      const itemId = this.itemId();
      this.version();
      untracked(() => void this.load(projectId, itemId, true));
    });
  }

  /**
   * Posts a note from the composer and reloads the timeline.
   *
   * @param html The note's HTML.
   * @returns Resolves once posted.
   */
  protected async post(html: string): Promise<void> {
    const projectId = this.projectId();
    const itemId = this.itemId();
    try {
      await this.annotations.addNote(projectId, itemId, { body: html });
      this.toast.show('Note added');
      await this.load(projectId, itemId, true);
    } catch (error) {
      this.toast.error(error);
    }
  }

  /**
   * Shows an edited note and reloads the history.
   *
   * @param note The note as saved.
   * @returns Resolves once reloaded.
   */
  protected async replace(note: NoteDto): Promise<void> {
    this.notes.update((notes) => notes.map((n) => (n.id === note.id ? note : n)));
    await this.load(this.projectId(), this.itemId(), true);
  }

  /**
   * Drops a deleted note and reloads the history.
   *
   * @param id The note's id.
   * @returns Resolves once reloaded.
   */
  protected async forget(id: string): Promise<void> {
    this.notes.update((notes) => notes.filter((n) => n.id !== id));
    await this.load(this.projectId(), this.itemId(), true);
  }

  /**
   * Loads the next pages of notes and history.
   *
   * @returns Resolves once loaded.
   */
  protected more(): Promise<void> {
    return this.load(this.projectId(), this.itemId(), false);
  }

  /**
   * Loads notes and history: the first pages (replacing what is shown), or
   * the next pages of whichever has more.
   *
   * @param projectId Project id.
   * @param itemId Item id.
   * @param first True for the first pages.
   * @returns Resolves once loaded.
   */
  private async load(projectId: string, itemId: string, first: boolean): Promise<void> {
    const run = first ? ++this.loadRun : this.loadRun;
    const noteCursor = first ? undefined : (this.noteCursor() ?? null);
    const historyCursor = first ? undefined : (this.historyCursor() ?? null);
    this.error.set('');
    try {
      const [notes, history] = await Promise.all([
        noteCursor === null ? null : this.annotations.notes(projectId, itemId, noteCursor),
        historyCursor === null ? null : this.items.activity(projectId, itemId, historyCursor),
      ]);
      // A newer first page was requested meanwhile; drop this answer.
      if (run !== this.loadRun) return;
      if (notes !== null) {
        this.notes.update((existing) => (first ? notes.items : [...existing, ...notes.items]));
        this.noteCursor.set(notes.nextCursor);
      }
      if (history !== null) {
        const rows = history.items.map((e) => this.toRow(e));
        this.history.update((existing) => (first ? rows : [...existing, ...rows]));
        this.historyCursor.set(history.nextCursor);
      }
    } catch (error) {
      if (run === this.loadRun) this.error.set(errorMessage(error));
    }
  }

  /**
   * Prepares a history entry for display.
   *
   * @param entry The audit entry.
   * @returns The row.
   */
  private toRow(entry: AuditEntryDto): HistoryRow {
    const actor =
      (entry.actorId === null ? null : this.ctx.names.member(entry.actorId)) ??
      entry.actorEmail ??
      'Someone';
    return {
      id: entry.id,
      actor,
      actorKey: entry.actorId ?? entry.actorEmail ?? 'someone',
      at: entry.createdAt,
      lines: describeActivity(entry, this.ctx.names),
      action: entry.action,
    };
  }
}
