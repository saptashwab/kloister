import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import type { ProjectDto, TrashBatchDto } from '@kloister/shared';
import { errorMessage } from '../../core/api';
import { TrashApiService } from '../../core/trash-api.service';
import { ProjectContext } from '../../core/project-context';
import { AppDatePipe } from '../../ui/app-date.pipe';
import { Dialogs } from '../../ui/dialogs';
import { EmptyState } from '../../ui/feedback';
import { TypeIcon } from '../../ui/signals';
import { ToastService } from '../../ui/toast.service';

/**
 * Project › Settings › Trash (M12 plan section 5): deleted items grouped by
 * delete batch, newest first, with who deleted them and when. Restore brings
 * a whole batch back; PMs may delete a batch permanently. The API lists only
 * items the viewer could see and says per batch what they may do. The list
 * reloads when the project's items change, so other people's deletes and
 * restores show live (M10).
 */
@Component({
  selector: 'app-project-trash',
  imports: [AppDatePipe, EmptyState, MatButtonModule, MatCardModule, TypeIcon],
  styles: `
    .batch {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--k-space-2) var(--k-space-4);
      padding: var(--k-space-3) 0;
      border-bottom: var(--k-line) solid var(--k-border);
    }
    .items {
      display: flex;
      flex: 1 1 var(--k-size-280px);
      flex-direction: column;
      gap: var(--k-space-1);
      min-width: 0;
    }
    .item {
      display: flex;
      align-items: center;
      gap: var(--k-space-2);
    }
    .meta {
      font-size: var(--k-small);
      color: var(--k-muted);
    }
  `,
  template: `
    <mat-card>
      <mat-card-header><mat-card-title>Trash</mat-card-title></mat-card-header>
      <mat-card-content>
        <p class="meta">
          Deleted items wait here until the nightly clean-up removes them for good. Restoring brings
          back their notes, files and links.
        </p>
        @if (error()) {
          <p class="k-alert" role="alert">{{ error() }}</p>
        }
        @for (batch of batches(); track batch.id) {
          <div class="batch" data-testid="trash-batch">
            <div class="items">
              @for (item of batch.items; track item.id) {
                <div class="item">
                  <app-type-icon [type]="item.type" />
                  <span class="k-key">{{ item.key }}</span>
                  <span>{{ item.title }}</span>
                </div>
              }
              <span class="meta"
                >Deleted {{ batch.deletedAt | appDate
                }}{{ batch.deletedBy ? ' by ' + batch.deletedBy.displayName : '' }} · removed for
                good after {{ batch.purgeAfter | appDate }}</span
              >
            </div>
            @if (project().archivedAt === null) {
              @if (batch.canRestore) {
                <button mat-stroked-button type="button" (click)="restore(batch)">Restore</button>
              }
              @if (batch.canPurge) {
                <button mat-button type="button" (click)="purge(batch)">Delete permanently</button>
              }
            }
          </div>
        } @empty {
          @if (loaded()) {
            <app-empty-state title="The trash is empty" text="Deleted items appear here." />
          }
        }
      </mat-card-content>
    </mat-card>
  `,
})
export class ProjectTrash {
  /** The project. */
  readonly project = input.required<ProjectDto>();

  private readonly api = inject(TrashApiService);
  private readonly dialogs = inject(Dialogs);
  private readonly toast = inject(ToastService);
  private readonly ctx = inject(ProjectContext, { optional: true });

  /** The delete batches. */
  protected readonly batches = signal<TrashBatchDto[]>([]);
  /** True once the first list arrived. */
  protected readonly loaded = signal(false);
  /** Last error, if any. */
  protected readonly error = signal('');

  /** Loads the list now and again whenever the project's items or board change. */
  constructor() {
    effect(() => {
      const id = this.project().id;
      this.ctx?.items();
      this.ctx?.buckets();
      untracked(() => void this.load(id));
    });
  }

  /**
   * Restores a batch.
   *
   * @param batch The batch.
   * @returns Resolves once restored.
   */
  protected async restore(batch: TrashBatchDto): Promise<void> {
    try {
      const result = await this.api.restore(this.project().id, batch.id);
      const what = batch.items[0]?.key ?? 'Items';
      this.toast.show(
        result.parentDropped
          ? `${what} restored without its parent, which is still in the trash`
          : `${result.restored === 1 ? what : `${result.restored} items`} restored`,
      );
      await this.ctx?.refresh();
      await this.load(this.project().id);
    } catch (error) {
      this.toast.error(error);
    }
  }

  /**
   * Deletes a batch for good after confirmation (PMs).
   *
   * @param batch The batch.
   * @returns Resolves once removed.
   */
  protected async purge(batch: TrashBatchDto): Promise<void> {
    const first = batch.items[0];
    const confirmed = await this.dialogs.confirm({
      title: `Delete ${first?.key ?? 'these items'} permanently?`,
      message:
        batch.items.length > 1
          ? `"${first?.title ?? ''}" and ${batch.items.length - 1} more items are removed with their notes and files. This cannot be undone.`
          : `"${first?.title ?? ''}" is removed with its notes and files. This cannot be undone.`,
      confirm: 'Delete permanently',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await this.api.purge(this.project().id, batch.id);
      this.batches.update((list) => list.filter((b) => b.id !== batch.id));
      this.toast.show('Deleted permanently');
    } catch (error) {
      this.toast.error(error);
    }
  }

  /**
   * Loads the batches.
   *
   * @param projectId Project id.
   * @returns Resolves once loaded.
   */
  private async load(projectId: string): Promise<void> {
    try {
      this.batches.set(await this.api.trash(projectId));
      this.error.set('');
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loaded.set(true);
    }
  }
}
