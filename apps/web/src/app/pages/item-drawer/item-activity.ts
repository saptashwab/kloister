import { DatePipe } from '@angular/common';
import { Component, effect, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import type { AuditEntryDto } from '@kloister/shared';
import { describeActivity } from '../../core/activity';
import { errorMessage } from '../../core/api';
import { ItemsApiService } from '../../core/items-api.service';
import { ProjectContext } from '../../core/project-context';
import { StaticAvatar } from '../../ui/avatar';

/** One entry ready for display. */
interface ActivityRow {
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
}

/**
 * An item's activity history (SPEC §6), read from
 * `GET …/items/:item/activity` (the audit log), newest first, a page at a
 * time. The API replaces references to items outside the caller's scope with
 * null; they are shown as "another item".
 */
@Component({
  selector: 'app-item-activity',
  imports: [DatePipe, MatButtonModule, StaticAvatar],
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    h2 {
      font-size: var(--k-body-sm);
      font-weight: 700;
    }
    ol {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    li {
      display: flex;
      gap: 10px;
      font-size: var(--k-body-sm);
      line-height: 1.45;
    }
    .when {
      color: var(--k-muted);
      font-size: var(--k-small);
    }
  `,
  template: `
    <h2>Activity</h2>
    @if (error()) {
      <p class="k-alert" role="alert">{{ error() }}</p>
    }
    <ol>
      @for (row of rows(); track row.id) {
        <li>
          <app-avatar-static [userId]="row.actorKey" [name]="row.actor" />
          <div>
            <strong>{{ row.actor }}</strong> {{ row.lines.join('; ') }}
            <div class="when">{{ row.at | date: 'medium' }}</div>
          </div>
        </li>
      } @empty {
        <li class="muted">No activity yet.</li>
      }
    </ol>
    @if (cursor()) {
      <button mat-button type="button" (click)="more()">Show older activity</button>
    }
  `,
})
export class ItemActivity {
  private readonly api = inject(ItemsApiService);
  private readonly ctx = inject(ProjectContext);

  /** Project id. */
  readonly projectId = input.required<string>();
  /** Item id. */
  readonly itemId = input.required<string>();
  /** Bumped by the drawer after each change, to reload the history. */
  readonly version = input(0);

  /** Loaded entries. */
  protected readonly rows = signal<ActivityRow[]>([]);
  /** Cursor for older entries, or null. */
  protected readonly cursor = signal<string | null>(null);
  /** Last error, if any. */
  protected readonly error = signal('');
  /** Counts first-page loads, so stale answers are dropped. */
  private loadRun = 0;

  /**
   * Reloads the first page whenever the item or its version changes.
   */
  constructor() {
    effect(() => {
      const projectId = this.projectId();
      const itemId = this.itemId();
      this.version();
      void this.load(projectId, itemId, undefined);
    });
  }

  /**
   * Loads the next page of older entries.
   *
   * @returns Resolves once loaded.
   */
  protected more(): Promise<void> {
    return this.load(this.projectId(), this.itemId(), this.cursor() ?? undefined);
  }

  /**
   * Loads a page and appends it (or replaces the list for the first page).
   *
   * @param projectId Project id.
   * @param itemId Item id.
   * @param cursor Cursor, or undefined for the newest page.
   * @returns Resolves once loaded.
   */
  private async load(projectId: string, itemId: string, cursor: string | undefined): Promise<void> {
    const run = cursor === undefined ? ++this.loadRun : this.loadRun;
    this.error.set('');
    try {
      const page = await this.api.activity(projectId, itemId, cursor);
      // A newer first page was requested meanwhile; drop this answer.
      if (run !== this.loadRun) return;
      const rows = page.items.map((e) => this.toRow(e));
      this.rows.update((existing) => (cursor === undefined ? rows : [...existing, ...rows]));
      this.cursor.set(page.nextCursor);
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  /**
   * Prepares an entry for display.
   *
   * @param entry The audit entry.
   * @returns The row.
   */
  private toRow(entry: AuditEntryDto): ActivityRow {
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
    };
  }
}
