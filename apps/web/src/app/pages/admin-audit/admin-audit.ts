import { DatePipe, JsonPipe } from '@angular/common';
import { Component, inject, type OnInit, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { AuditAction, type AuditEntryDto } from '@kloister/shared';
import { AdminApiService } from '../../core/admin-api.service';
import { errorMessage } from '../../core/api';

import { EmptyState, Skeleton } from '../../ui/feedback';

/**
 * Audit log viewer (SPEC §6 Admin), newest first, filterable by action.
 *
 * Permissions: route guarded for admins; the API enforces it independently.
 */
@Component({
  selector: 'app-admin-audit',
  host: { class: 'k-page' },
  imports: [
    EmptyState,
    Skeleton,
    DatePipe,
    JsonPipe,
    MatButtonModule,
    MatFormFieldModule,
    MatSelectModule,
  ],
  template: `
    <header class="k-page-head"><h1>Audit log</h1></header>
    <mat-form-field>
      <mat-label>Action</mat-label>
      <mat-select [value]="action()" (valueChange)="filter($event)">
        <mat-option value="">All actions</mat-option>
        @for (a of actions; track a) {
          <mat-option [value]="a">{{ a }}</mat-option>
        }
      </mat-select>
    </mat-form-field>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    @if (loading()) {
      <app-skeleton label="Loading the list" />
    } @else {
      <div class="k-panel k-table-scroll" tabindex="0" role="region" aria-label="Scrollable table">
        <table class="data">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Actor</th>
              <th scope="col">Action</th>
              <th scope="col">Entity</th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody>
            @for (entry of entries(); track entry.id) {
              <tr>
                <td>{{ entry.createdAt | date: 'medium' }}</td>
                <td>{{ entry.actorEmail ?? '—' }}</td>
                <td>{{ entry.action }}</td>
                <td>{{ entry.entityType }} {{ entry.entityId ?? '' }}</td>
                <td>
                  <code>{{ entry.meta | json }}</code>
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="5">
                  <app-empty-state
                    title="No entries match"
                    text="Choose another action to see its history."
                  />
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
    @if (nextCursor()) {
      <button mat-button type="button" (click)="loadMore()">Load more</button>
    }
  `,
})
export class AdminAuditPage implements OnInit {
  private readonly api = inject(AdminApiService);

  /** Actions offered in the filter. */
  protected readonly actions = Object.values(AuditAction);
  /** Selected action filter; empty for all. */
  protected readonly action = signal('');
  /** Loaded entries. */
  protected readonly entries = signal<AuditEntryDto[]>([]);
  /** Cursor for the next page, or null. */
  protected readonly nextCursor = signal<string | null>(null);
  /** Last error message, if any. */
  protected readonly error = signal('');
  /** True while the list is being replaced. */
  protected readonly loading = signal(true);

  /**
   * Loads the first page.
   */
  ngOnInit(): void {
    void this.filter('');
  }

  /**
   * Applies an action filter and reloads from the newest entry.
   *
   * @param action Action to show; empty for all.
   * @returns Resolves once loaded.
   */
  protected async filter(action: string): Promise<void> {
    this.action.set(action);
    await this.load(undefined);
  }

  /**
   * Appends the next page.
   *
   * @returns Resolves once loaded.
   */
  protected async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (cursor !== null) await this.load(cursor);
  }

  /**
   * Fetches a page and replaces or extends the list.
   *
   * @param cursor Cursor to continue from, or undefined for the first page.
   * @returns Resolves once loaded.
   */
  private async load(cursor: string | undefined): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const page = await this.api.listAudit({ action: this.action(), cursor });
      this.entries.update((entries) => (cursor ? [...entries, ...page.items] : page.items));
      this.nextCursor.set(page.nextCursor);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }
}
