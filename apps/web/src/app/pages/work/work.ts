import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { RouterLink } from '@angular/router';
import type { WorkPersonDto, WorkSummaryDto } from '@kloister/shared';
import { errorMessage } from '../../core/api';
import { isoDate } from '../../core/board-logic';
import { type DueState, dueState, dueText } from '../../core/item-changes';
import { SessionStore } from '../../core/session.store';
import { WorkApiService } from '../../core/work-api.service';
import { StaticAvatar } from '../../ui/avatar';
import { EmptyState, Skeleton } from '../../ui/feedback';
import { PriorityIcon, StatusPill, TypeIcon } from '../../ui/signals';

/**
 * "All their work" (SPEC §6, DESIGN §9) at `/people/:userId`, and "My work"
 * for the signed-in user: the items assigned to a person across every
 * project the viewer belongs to, each limited by the viewer's own access
 * there (the API decides). Open items by default, Done ones on request.
 */
@Component({
  selector: 'app-work',
  imports: [
    RouterLink,
    MatButtonModule,
    MatSlideToggleModule,
    StaticAvatar,
    EmptyState,
    Skeleton,
    TypeIcon,
    StatusPill,
    PriorityIcon,
  ],
  styles: `
    .person {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .person div {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .entry {
      display: grid;
      grid-template-columns: auto auto minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 10px 12px;
      padding: 10px 14px;
      border: 1px solid var(--k-border);
      border-radius: var(--k-radius-md);
      background: var(--k-surface);
      color: inherit;
      text-decoration: none;
    }
    .entry:hover {
      border-color: var(--k-border-strong);
      box-shadow: var(--k-rest);
    }
    .title {
      font-weight: 500;
      overflow-wrap: anywhere;
    }
    .project {
      font-size: var(--k-small);
      color: var(--k-muted);
    }
    .end {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    @media (max-width: 599px) {
      .entry {
        grid-template-columns: auto minmax(0, 1fr);
      }
      .entry > :nth-child(2) {
        display: none;
      }
      .end {
        grid-column: 1 / -1;
      }
    }
  `,
  template: `
    <div class="k-page">
      <div class="k-page-head">
        @if (person(); as p) {
          <div class="person">
            <app-avatar-static [userId]="p.id" [name]="p.displayName" [size]="44" />
            <div>
              <h1>{{ isMe() ? 'My work' : p.displayName }}</h1>
              <span class="muted">{{
                isMe() ? 'Everything assigned to you' : p.email + ' · their items you can see'
              }}</span>
            </div>
          </div>
        } @else {
          <h1>{{ isMe() ? 'My work' : 'Work' }}</h1>
        }
        <span class="spacer"></span>
        <mat-slide-toggle [checked]="includeDone()" (change)="includeDone.set($event.checked)"
          >Show done</mat-slide-toggle
        >
      </div>

      @if (error()) {
        <p class="k-alert" role="alert">{{ error() }}</p>
      } @else if (loading() && items().length === 0) {
        <app-skeleton label="Loading work" />
      } @else {
        <ul class="plain list" aria-label="Assigned items">
          @for (i of items(); track i.id) {
            <li>
              <a class="entry" [routerLink]="['/p', i.projectKey, 'items', i.number]">
                <app-type-icon [type]="i.type" />
                <span class="k-key">{{ i.key }}</span>
                <span>
                  <span class="title">{{ i.title }}</span
                  ><br />
                  <span class="project">{{ i.projectName }}</span>
                </span>
                <span class="end">
                  @if (i.dueDate) {
                    <span
                      class="k-pill"
                      [class.danger]="dueStateOf(i) === 'overdue'"
                      [class.warn]="dueStateOf(i) === 'soon'"
                      >{{ dueTextOf(i) }}</span
                    >
                  }
                  <app-status-pill [status]="i.status" />
                </span>
                <app-priority-icon [priority]="i.priority" />
              </a>
            </li>
          } @empty {
            <li>
              <app-empty-state
                [title]="isMe() ? 'Nothing assigned to you' : 'Nothing to show'"
                [text]="
                  includeDone()
                    ? 'No items are assigned in the projects you can open.'
                    : 'No open items. Turn on “Show done” to see finished ones.'
                "
              />
            </li>
          }
        </ul>
        @if (cursor()) {
          <button mat-stroked-button type="button" (click)="more()">Show more</button>
        }
      }
    </div>
  `,
})
export class WorkPage {
  private readonly api = inject(WorkApiService);
  private readonly session = inject(SessionStore);

  /** The person, from the route (`/people/:userId`). */
  readonly userId = input.required<string>();

  /** Include Done items. */
  protected readonly includeDone = signal(false);
  /** The person, once loaded. */
  protected readonly person = signal<WorkPersonDto | null>(null);
  /** Loaded items. */
  protected readonly items = signal<WorkSummaryDto[]>([]);
  /** Cursor for the next page. */
  protected readonly cursor = signal<string | null>(null);
  /** True while a page loads. */
  protected readonly loading = signal(false);
  /** Load error. */
  protected readonly error = signal('');
  /** True on the signed-in user's own page. */
  protected readonly isMe = computed(() => this.session.user()?.id === this.userId());

  private readonly today = isoDate(new Date());
  /** Counts loads, so answers for an older query are dropped. */
  private run = 0;

  /**
   * Reloads whenever the person or the Done filter changes.
   */
  constructor() {
    effect(() => {
      const userId = this.userId();
      const includeDone = this.includeDone();
      untracked(() => void this.load(userId, includeDone, null));
    });
  }

  /**
   * How urgent an item's due date is (DESIGN §3.4).
   *
   * @param item The item.
   * @returns Overdue, soon, later, or null without a due date.
   */
  protected dueStateOf(item: WorkSummaryDto): DueState | null {
    return dueState(item, this.today);
  }

  /**
   * The due date in words, e.g. "2 days overdue" or "Fri 17 Oct".
   *
   * @param item The item.
   * @returns The text.
   */
  protected dueTextOf(item: WorkSummaryDto): string {
    const text = dueText(item, this.today);
    return dueState(item, this.today) === 'later' ? `Due ${text}` : text;
  }

  /**
   * Loads the next page.
   *
   * @returns Resolves once loaded.
   */
  protected more(): Promise<void> {
    return this.load(this.userId(), this.includeDone(), this.cursor());
  }

  /**
   * Loads one page; the first page replaces the list.
   *
   * @param userId The person.
   * @param includeDone Include Done items.
   * @param cursor Cursor, or null for the first page.
   * @returns Resolves once loaded.
   */
  private async load(userId: string, includeDone: boolean, cursor: string | null): Promise<void> {
    const run = ++this.run;
    this.loading.set(true);
    this.error.set('');
    if (cursor === null) {
      this.items.set([]);
      // Another person's name must not show while this one loads or fails.
      if (this.person()?.id !== userId) this.person.set(null);
    }
    try {
      const page = await this.api.list(userId, {
        includeDone,
        ...(cursor === null ? {} : { cursor }),
      });
      if (run !== this.run) return;
      this.person.set(page.user);
      this.items.update((items) => (cursor === null ? page.items : [...items, ...page.items]));
      this.cursor.set(page.nextCursor);
    } catch (error) {
      if (run === this.run) {
        this.person.set(null);
        this.error.set(errorMessage(error));
      }
    } finally {
      if (run === this.run) this.loading.set(false);
    }
  }
}
