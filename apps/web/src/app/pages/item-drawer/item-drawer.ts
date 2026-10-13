import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Router } from '@angular/router';
import {
  ALLOWED_PARENT_TYPES,
  ItemStatus,
  ItemType,
  ITEM_TITLE_MAX,
  PRIORITY_MAX,
  PRIORITY_MIN,
  requiresBucket,
  SprintState,
  type UpdateItemRequest,
  type WorkItemDetailDto,
  type WorkItemDto,
} from '@kloister/shared';
import { errorMessage } from '../../core/api';
import { NONE } from '../../core/board-logic';
import { ItemsApiService } from '../../core/items-api.service';
import { PRIORITY_LABELS, STATUS_LABELS, TYPE_BADGES, TYPE_LABELS } from '../../core/labels';
import { ProjectContext } from '../../core/project-context';
import { SessionStore } from '../../core/session.store';
import { DescriptionEditor } from './description-editor';
import { ItemActivity } from './item-activity';
import { ItemChecklist } from './item-checklist';

/**
 * The item detail drawer (SPEC §6), deep-linkable at `/p/:key/items/:number`
 * and also opened beside the backlog.
 *
 * Every field is shown; editing controls are enabled only where the item's
 * `can` capabilities allow (`edit` for fields, checklist and dependencies,
 * `move` for the bucket, `delete`/`deleteCascade` for deleting) and the
 * project is not archived. Assigning anyone but yourself also needs
 * `ASSIGN_OTHERS` or leading the item's team. The API checks every change
 * again; its answer (e.g. the bucket chosen by `statusToBucket`, or the
 * status set by a bucket's entry rule) replaces what is shown.
 *
 * Ancestors outside the caller's scope are shown as read-only titles
 * (SPEC §3.3). Notes and attachments arrive in M5.
 */
@Component({
  selector: 'app-item-drawer',
  imports: [
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    DescriptionEditor,
    ItemChecklist,
    ItemActivity,
  ],
  host: {
    class: 'drawer',
    role: 'complementary',
    'aria-label': 'Item details',
    '(keydown.escape)': 'close()',
  },
  styles: `
    :host {
      position: fixed;
      top: 64px;
      right: 0;
      bottom: 0;
      z-index: 10;
      width: min(600px, 100vw);
      box-sizing: border-box;
      padding: 12px 16px;
      overflow-y: auto;
      background: var(--mat-sys-surface);
      border-left: 1px solid var(--mat-sys-outline-variant);
      box-shadow: var(--mat-sys-level3);
    }
    .head {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .crumbs {
      font-size: 0.85rem;
      color: var(--mat-sys-on-surface-variant);
    }
    .full {
      width: 100%;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
      column-gap: 12px;
    }
    .refs {
      margin: 0 0 8px;
      padding-left: 20px;
    }
    section {
      margin-top: 16px;
    }
  `,
  template: `
    <div class="head">
      @if (detail(); as d) {
        <span class="badge" [attr.data-type]="d.type">{{ badges[d.type] }}</span>
        <strong>{{ d.key }}</strong>
      }
      <span class="spacer"></span>
      <button mat-button type="button" (click)="close()">Close</button>
    </div>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    <!-- Re-created after a refused change, so every control shows the stored value again. -->
    @for (view of views(); track view.key) {
      @let d = view.item;
      @if (d.ancestors.length > 0) {
        <nav class="crumbs" aria-label="Parents">
          @for (a of d.ancestors; track a.id; let last = $last) {
            @if (isVisible(a.id)) {
              <a href="" (click)="openItem($event, a.number)">{{ a.key }} {{ a.title }}</a>
            } @else {
              <span title="Outside your view: shown as a title only"
                >{{ a.key }} {{ a.title }}</span
              >
            }
            @if (!last) {
              ›
            }
          }
        </nav>
      }

      @if (canEdit()) {
        <mat-form-field class="full">
          <mat-label>Title</mat-label>
          <input
            matInput
            [value]="d.title"
            [attr.maxlength]="titleMax"
            (change)="saveTitle($any($event.target))"
          />
        </mat-form-field>
      } @else {
        <h3>{{ d.title }}</h3>
      }

      <div class="grid">
        <mat-form-field>
          <mat-label>Type</mat-label>
          <mat-select
            [value]="d.type"
            [disabled]="!canEdit()"
            (valueChange)="save({ type: $event })"
          >
            @for (t of types; track t) {
              <mat-option [value]="t">{{ typeLabels[t] }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>Status</mat-label>
          <mat-select
            [value]="d.status"
            [disabled]="!canEdit()"
            (valueChange)="save({ status: $event })"
          >
            @for (s of statuses; track s) {
              <mat-option [value]="s">{{ statusLabels[s] }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>Bucket</mat-label>
          <mat-select
            [value]="d.bucketId ?? none"
            [disabled]="!canMove()"
            (valueChange)="moveTo($event)"
          >
            @if (!needsBucket()) {
              <mat-option [value]="none">Off the board</mat-option>
            }
            @for (b of ctx.buckets(); track b.id) {
              <mat-option [value]="b.id">{{ b.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>Sprint</mat-label>
          <mat-select
            [value]="d.sprintId ?? none"
            [disabled]="!canEdit()"
            (valueChange)="save({ sprintId: orNull($event) })"
          >
            <mat-option [value]="none">No sprint</mat-option>
            @for (s of ctx.sprints(); track s.id) {
              @if (s.state !== closed || s.id === d.sprintId) {
                <mat-option [value]="s.id" [disabled]="s.state === closed">{{ s.name }}</mat-option>
              }
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>Priority</mat-label>
          <mat-select
            [value]="d.priority"
            [disabled]="!canEdit()"
            (valueChange)="save({ priority: $event })"
          >
            @for (p of priorities; track p) {
              <mat-option [value]="p">{{ priorityLabels[p] }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        @if (ctx.teams().length > 0 || d.teamId) {
          <mat-form-field>
            <mat-label>Team</mat-label>
            <mat-select
              [value]="d.teamId ?? none"
              [disabled]="!canEdit()"
              (valueChange)="save({ teamId: orNull($event) })"
            >
              <mat-option [value]="none">No team</mat-option>
              @for (t of ctx.teams(); track t.id) {
                <mat-option [value]="t.id" [disabled]="!ctx.canPickTeam(t.id)">{{
                  t.name
                }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        }
        <mat-form-field>
          <mat-label>Start date</mat-label>
          <input
            matInput
            type="date"
            [value]="d.startDate ?? ''"
            [disabled]="!canEdit()"
            (change)="save({ startDate: $any($event.target).value || null })"
          />
        </mat-form-field>
        <mat-form-field>
          <mat-label>Due date</mat-label>
          <input
            matInput
            type="date"
            [value]="d.dueDate ?? ''"
            [disabled]="!canEdit()"
            (change)="save({ dueDate: $any($event.target).value || null })"
          />
        </mat-form-field>
      </div>

      <mat-form-field class="full">
        <mat-label>Parent</mat-label>
        <mat-select
          [value]="d.parentId ?? none"
          [disabled]="!canEdit() || d.type === epic"
          (valueChange)="save({ parentId: orNull($event) })"
        >
          <mat-option [value]="none">No parent</mat-option>
          @if (hiddenParent(); as p) {
            <mat-option [value]="p.id" disabled>{{ p.key }} {{ p.title }}</mat-option>
          }
          @for (p of parentOptions(); track p.id) {
            <mat-option [value]="p.id">{{ p.key }} {{ p.title }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      <mat-form-field class="full">
        <mat-label>Assignees</mat-label>
        <mat-select
          multiple
          [value]="d.assigneeIds"
          [disabled]="!canEdit()"
          (valueChange)="save({ assigneeIds: $event })"
        >
          @for (m of assignable(); track m.userId) {
            <mat-option [value]="m.userId" [disabled]="!canAssign(m.userId)">{{
              m.displayName
            }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      <mat-form-field class="full">
        <mat-label>Labels</mat-label>
        <mat-select
          multiple
          [value]="d.labelIds"
          [disabled]="!canEdit()"
          (valueChange)="save({ labelIds: $event })"
        >
          @for (l of ctx.labels(); track l.id) {
            <mat-option [value]="l.id">{{ l.name }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      <section>
        <h4>Description</h4>
        @if (canEdit()) {
          <app-description-editor [html]="d.description" (save)="save({ description: $event })" />
        } @else if (d.description) {
          <div [innerHTML]="d.description"></div>
        } @else {
          <p>No description.</p>
        }
      </section>

      <section>
        <app-item-checklist
          [projectId]="projectId()"
          [itemId]="d.id"
          [items]="d.checklistItems"
          [canEdit]="canEdit()"
          (changed)="reload()"
        />
      </section>

      <section>
        <h4>Blocked by</h4>
        <ul class="refs">
          @for (r of d.blockedBy; track r.id) {
            <li>
              <a href="" (click)="openItem($event, r.number)">{{ r.key }} {{ r.title }}</a>
              @if (canEdit()) {
                <button mat-button type="button" (click)="removeBlocker(r.id)">Remove</button>
              }
            </li>
          } @empty {
            <li>Nothing.</li>
          }
        </ul>
        @if (canEdit()) {
          <mat-form-field class="full">
            <mat-label>Add a blocking item</mat-label>
            <mat-select (valueChange)="addBlocker($event)">
              @for (i of blockerOptions(); track i.id) {
                <mat-option [value]="i.id">{{ i.key }} {{ i.title }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        }
        <h4>Blocks</h4>
        <ul class="refs">
          @for (r of d.blocks; track r.id) {
            <li>
              <a href="" (click)="openItem($event, r.number)">{{ r.key }} {{ r.title }}</a>
            </li>
          } @empty {
            <li>Nothing.</li>
          }
        </ul>
      </section>

      <section>
        <h4>Children</h4>
        <ul class="refs">
          @for (c of children(); track c.id) {
            <li>
              <a href="" (click)="openItem($event, c.number)">{{ c.key }} {{ c.title }}</a>
              · {{ statusLabels[c.status] }}
            </li>
          } @empty {
            <li>None.</li>
          }
        </ul>
        @if (childCursor()) {
          <button mat-button type="button" (click)="moreChildren()">Show more children</button>
        }
      </section>

      <section>
        <app-item-activity [projectId]="projectId()" [itemId]="d.id" [version]="version()" />
      </section>

      @if (canDelete()) {
        <section>
          <button mat-stroked-button type="button" (click)="remove()">Delete item</button>
        </section>
      }
    } @empty {
      @if (!error()) {
        <p>Loading…</p>
      }
    }
  `,
})
export class ItemDrawer {
  /** Shared project state. */
  protected readonly ctx = inject(ProjectContext);
  private readonly api = inject(ItemsApiService);
  private readonly router = inject(Router);
  private readonly session = inject(SessionStore);

  /** Item number from the route (`items/:number`). */
  readonly number = input.required<string>();

  /** "None" select value for the template. */
  protected readonly none = NONE;
  /** Closed sprint state for the template. */
  protected readonly closed = SprintState.CLOSED;
  /** Epic type for the template. */
  protected readonly epic = ItemType.EPIC;
  /** Types for the template. */
  protected readonly types = Object.values(ItemType);
  /** Statuses for the template. */
  protected readonly statuses = Object.values(ItemStatus);
  /** Priorities, highest first. */
  protected readonly priorities = Array.from(
    { length: PRIORITY_MAX - PRIORITY_MIN + 1 },
    (_, i) => PRIORITY_MIN + i,
  );
  /** Type names. */
  protected readonly typeLabels = TYPE_LABELS;
  /** Type badges. */
  protected readonly badges = TYPE_BADGES;
  /** Status names. */
  protected readonly statusLabels = STATUS_LABELS;
  /** Priority names. */
  protected readonly priorityLabels = PRIORITY_LABELS;
  /** Longest title accepted. */
  protected readonly titleMax = ITEM_TITLE_MAX;

  /** The item, or null while loading or after an error. */
  protected readonly detail = signal<WorkItemDetailDto | null>(null);
  /** Loaded children. */
  protected readonly children = signal<WorkItemDto[]>([]);
  /** Cursor for more children, or null. */
  protected readonly childCursor = signal<string | null>(null);
  /** Bumped after each change so the activity history reloads. */
  protected readonly version = signal(0);
  /** Last error, if any. */
  protected readonly error = signal('');
  /** Counts item loads, so answers for an item no longer open are dropped. */
  private loadRun = 0;
  /** Bumped when a change is refused, to rebuild the controls. */
  private readonly resets = signal(0);

  /** The item as a one-element list keyed by {@link resets}, for the template. */
  protected readonly views = computed(() => {
    const item = this.detail();
    return item === null ? [] : [{ item, key: this.resets() }];
  });

  /** Project id. */
  protected readonly projectId = computed(() => this.ctx.project()?.id ?? '');

  /** Field, checklist and dependency controls are enabled. */
  protected readonly canEdit = computed(() => {
    const d = this.detail();
    return d !== null && this.ctx.canEdit(d);
  });
  /** The bucket control is enabled. */
  protected readonly canMove = computed(() => {
    const d = this.detail();
    return d !== null && this.ctx.canMove(d);
  });
  /** The delete button is shown. */
  protected readonly canDelete = computed(() => {
    const d = this.detail();
    // With children, only a cascade can succeed (SPEC §4.1).
    return (
      d !== null && this.ctx.writable() && (d.childCount > 0 ? d.can.deleteCascade : d.can.delete)
    );
  });
  /** Stories, Tasks and Bugs must stay on the board. */
  protected readonly needsBucket = computed(() => {
    const d = this.detail();
    return d !== null && requiresBucket(d.type);
  });

  /** Visible items that may be this item's parent (SPEC §4.1), minus its own subtree. */
  protected readonly parentOptions = computed(() => {
    const d = this.detail();
    if (d === null) return [];
    const allowed = ALLOWED_PARENT_TYPES[d.type];
    return this.ctx
      .items()
      .filter(
        (i) => allowed.includes(i.type) && i.id !== d.id && !i.ancestors.some((a) => a.id === d.id),
      )
      .sort((a, b) => a.number - b.number);
  });

  /** The current parent when it is outside the caller's scope (title only). */
  protected readonly hiddenParent = computed(() => {
    const d = this.detail();
    const parent = d?.ancestors.at(-1);
    return parent !== undefined && !this.isVisible(parent.id) ? parent : null;
  });

  /** Active members, plus deactivated ones still assigned to the item. */
  protected readonly assignable = computed(() => {
    const assigned = this.detail()?.assigneeIds ?? [];
    return this.ctx.members().filter((m) => m.isActive || assigned.includes(m.userId));
  });

  /** Visible items that could be added as blockers. */
  protected readonly blockerOptions = computed(() => {
    const d = this.detail();
    if (d === null) return [];
    const taken = new Set(d.blockedBy.map((r) => r.id));
    return this.ctx
      .items()
      .filter((i) => i.id !== d.id && !taken.has(i.id))
      .sort((a, b) => a.number - b.number);
  });

  /**
   * Loads the item whenever the number in the URL (or the project) changes.
   */
  constructor() {
    effect(() => {
      const projectId = this.projectId();
      const number = this.number();
      if (projectId === '') return;
      untracked(() => void this.load(projectId, number));
    });
  }

  /**
   * Reports whether an item is visible to the caller (loaded on the board).
   *
   * @param id Item id.
   * @returns True if visible.
   */
  protected isVisible(id: string): boolean {
    return this.ctx.itemsById().has(id);
  }

  /**
   * Reports whether a member may be ticked or unticked in the assignee list:
   * yourself always, others with `ASSIGN_OTHERS` or as the item's team Lead.
   *
   * @param userId Member's user id.
   * @returns True if the option is enabled.
   */
  protected canAssign(userId: string): boolean {
    const d = this.detail();
    return userId === this.session.user()?.id || this.ctx.canAssignOthers(d?.teamId ?? null);
  }

  /**
   * Maps the "none" select value to null.
   *
   * @param value Select value.
   * @returns The id, or null.
   */
  protected orNull(value: string): string | null {
    return value === NONE ? null : value;
  }

  /**
   * Saves a new title; an emptied title is put back.
   *
   * @param input The title field.
   * @returns Resolves once saved.
   */
  protected async saveTitle(input: HTMLInputElement): Promise<void> {
    const title = input.value.trim();
    const d = this.detail();
    if (d === null) return;
    if (title === '' || title === d.title) {
      input.value = d.title;
      return;
    }
    await this.save({ title });
  }

  /**
   * Saves field changes and shows the item the API returns, whose bucket
   * may have moved through the project's `statusToBucket` map.
   *
   * @param change Fields to change.
   * @returns Resolves once saved.
   */
  protected async save(change: UpdateItemRequest): Promise<void> {
    const d = this.detail();
    if (d === null) return;
    await this.apply(() => this.api.update(this.projectId(), d.id, change));
  }

  /**
   * Moves the card to another bucket, or off the board (Epics and Features),
   * and shows the status the bucket's entry rule produced.
   *
   * @param value Bucket id or the "none" value.
   * @returns Resolves once moved.
   */
  protected async moveTo(value: string): Promise<void> {
    const d = this.detail();
    if (d === null) return;
    await this.apply(() => this.api.move(this.projectId(), d.id, { bucketId: this.orNull(value) }));
  }

  /**
   * Adds a blocking item.
   *
   * @param blockingItemId The blocker.
   * @returns Resolves once added.
   */
  protected async addBlocker(blockingItemId: string): Promise<void> {
    const d = this.detail();
    if (d === null) return;
    await this.apply(() => this.api.addDependency(this.projectId(), d.id, { blockingItemId }));
  }

  /**
   * Removes a blocking item.
   *
   * @param blockingItemId The blocker.
   * @returns Resolves once removed.
   */
  protected async removeBlocker(blockingItemId: string): Promise<void> {
    const d = this.detail();
    if (d === null) return;
    await this.apply(() => this.api.removeDependency(this.projectId(), d.id, blockingItemId));
  }

  /**
   * Reloads the item after a checklist change (for its progress and history).
   *
   * @returns Resolves once reloaded.
   */
  protected async reload(): Promise<void> {
    const d = this.detail();
    if (d === null) return;
    await this.apply(() => this.api.get(this.projectId(), d.id));
  }

  /**
   * Deletes the item after confirmation; items with children are deleted
   * with their subtree when the caller may cascade (PM, Lead).
   *
   * @returns Resolves once deleted.
   */
  protected async remove(): Promise<void> {
    const d = this.detail();
    if (d === null) return;
    const cascade = d.childCount > 0 && d.can.deleteCascade;
    const question = cascade
      ? `Delete ${d.key} and everything under it?`
      : `Delete ${d.key}? This cannot be undone.`;
    if (!confirm(question)) return;
    this.error.set('');
    try {
      await this.api.remove(this.projectId(), d.id, cascade);
      const gone = this.ctx
        .items()
        .filter((i) => i.id === d.id || i.ancestors.some((a) => a.id === d.id))
        .map((i) => i.id);
      this.ctx.forget(gone);
      this.close();
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }

  /**
   * Loads the next page of children.
   *
   * @returns Resolves once loaded.
   */
  protected async moreChildren(): Promise<void> {
    const d = this.detail();
    const cursor = this.childCursor();
    if (d === null || cursor === null) return;
    await this.guard(async () => {
      const page = await this.api.children(this.projectId(), d.id, cursor);
      this.children.update((c) => [...c, ...page.items]);
      this.childCursor.set(page.nextCursor);
    });
  }

  /**
   * Opens another item in the drawer.
   *
   * @param event The click, whose default navigation is cancelled.
   * @param number The item number.
   */
  protected openItem(event: Event, number: number): void {
    event.preventDefault();
    void this.router.navigateByUrl(this.router.url.replace(/\/items\/[^/?#]+/, `/items/${number}`));
  }

  /**
   * Closes the drawer, returning to the board or backlog beneath it.
   */
  protected close(): void {
    void this.router.navigateByUrl(this.router.url.replace(/\/items\/[^/?#]+/, ''));
  }

  /**
   * Loads the item and its first page of children.
   *
   * @param projectId Project id.
   * @param number Item number.
   * @returns Resolves once loaded.
   */
  private async load(projectId: string, number: string): Promise<void> {
    const run = ++this.loadRun;
    this.detail.set(null);
    this.children.set([]);
    await this.guard(async () => {
      const [detail, children] = await Promise.all([
        this.api.get(projectId, number),
        this.api.children(projectId, number),
      ]);
      // A newer item was opened meanwhile; its answer wins.
      if (run !== this.loadRun) return;
      this.detail.set(detail);
      this.children.set(children.items);
      this.childCursor.set(children.nextCursor);
    });
  }

  /**
   * Runs a change, then shows and shares the item the API returned.
   *
   * @param change The request.
   * @returns Resolves once done.
   */
  private async apply(change: () => Promise<WorkItemDetailDto>): Promise<void> {
    const run = this.loadRun;
    const ok = await this.guard(async () => {
      const updated = await change();
      this.ctx.upsert(updated);
      // Another item was opened meanwhile: keep showing that one.
      if (run !== this.loadRun) return;
      this.detail.set(updated);
      this.version.update((v) => v + 1);
    });
    // A refused change leaves the controls showing the rejected value; build
    // them again from the stored item.
    if (!ok) this.resets.update((n) => n + 1);
  }

  /**
   * Runs an action, showing any error instead of throwing.
   *
   * @param action The work to do.
   * @returns True if it succeeded.
   */
  private async guard(action: () => Promise<void>): Promise<boolean> {
    this.error.set('');
    try {
      await action();
      return true;
    } catch (error) {
      this.error.set(errorMessage(error));
      return false;
    }
  }
}
