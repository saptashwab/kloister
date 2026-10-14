import { CdkDrag, CdkDropList, CdkDropListGroup, type CdkDragDrop } from '@angular/cdk/drag-drop';
import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { RouterLink } from '@angular/router';
import { ItemStatus, ItemType, type WorkPersonDto, type WorkSummaryDto } from '@kloister/shared';
import { errorMessage } from '../../core/api';
import { isoDate } from '../../core/board-logic';
import { dueState, dueText } from '../../core/item-changes';
import { ItemsApiService } from '../../core/items-api.service';
import { STATUS_LABELS, TYPE_LABELS } from '../../core/labels';
import { Shortcuts } from '../../core/shortcuts';
import { SessionStore } from '../../core/session.store';
import { WorkApiService } from '../../core/work-api.service';
import { filterWork, groupWork, type WorkFilter } from '../../core/work-logic';
import { EmptyState, Skeleton } from '../../ui/feedback';
import { LabelPill } from '../../ui/label-pill';
import { StatusPill, TypeIcon } from '../../ui/signals';
import { ToastService } from '../../ui/toast.service';

/** My work and all their work share readable list/status-board views (SPEC §6). */
@Component({
  selector: 'app-work',
  imports: [
    RouterLink,
    MatButtonModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatSelectModule,
    MatSlideToggleModule,
    CdkDrag,
    CdkDropList,
    CdkDropListGroup,
    EmptyState,
    Skeleton,
    LabelPill,
    TypeIcon,
    StatusPill,
  ],
  styleUrl: './work.scss',
  template: `
    <div class="k-page">
      <div class="k-page-head">
        <div>
          <h1>{{ isMe() ? 'My work' : (person()?.displayName ?? 'Work') }}</h1>
          <p class="muted">
            {{
              isMe()
                ? 'Your project work and private personal tasks'
                : (person()?.email ?? '') + ' · their items you can see'
            }}
          </p>
        </div>
      </div>
      <div class="row controls" aria-label="Work views and filters">
        <mat-button-toggle-group
          aria-label="Work view"
          [value]="view()"
          (change)="view.set($event.value)"
        >
          <mat-button-toggle value="list">List</mat-button-toggle
          ><mat-button-toggle value="board">Board</mat-button-toggle>
        </mat-button-toggle-group>
        @if (isMe()) {
          <mat-form-field
            ><mat-label>Source</mat-label
            ><mat-select [value]="filter().source" (valueChange)="setFilter({ source: $event })"
              ><mat-option value="ALL">All</mat-option
              ><mat-option value="PROJECTS">Projects</mat-option
              ><mat-option value="PERSONAL">Personal</mat-option></mat-select
            ></mat-form-field
          >
        }
        <mat-form-field
          ><mat-label>Project</mat-label
          ><mat-select [value]="filter().projectId" (valueChange)="setFilter({ projectId: $event })"
            ><mat-option value="">All projects</mat-option>
            @for (p of projects(); track p.id) {
              <mat-option [value]="p.id">{{ p.name }}</mat-option>
            }
          </mat-select></mat-form-field
        >
        <mat-form-field
          ><mat-label>Type</mat-label
          ><mat-select [value]="filter().type" (valueChange)="setFilter({ type: $event })"
            ><mat-option value="">Any type</mat-option>
            @for (t of types; track t) {
              <mat-option [value]="t">{{ typeLabels[t] }}</mat-option>
            }
          </mat-select></mat-form-field
        >
        <mat-form-field
          ><mat-label>Label</mat-label
          ><mat-select [value]="filter().labelId" (valueChange)="setFilter({ labelId: $event })"
            ><mat-option value="">Any label</mat-option>
            @for (l of labels(); track l.id) {
              <mat-option [value]="l.id">{{ l.project }} · {{ l.name }}</mat-option>
            }
          </mat-select></mat-form-field
        >
        <mat-form-field
          ><mat-label>Due</mat-label
          ><mat-select [value]="filter().due" (valueChange)="setFilter({ due: $event })"
            ><mat-option value="">Any date</mat-option>
            @for (d of dueGroups; track d) {
              <mat-option [value]="d">{{ d }}</mat-option>
            }
          </mat-select></mat-form-field
        >
        <mat-slide-toggle
          [checked]="includeCreated()"
          (change)="includeCreated.set($event.checked)"
          >{{ isMe() ? 'Also items I created' : 'Also items they created' }}</mat-slide-toggle
        >
        <mat-slide-toggle [checked]="includeDone()" (change)="includeDone.set($event.checked)"
          >Show done</mat-slide-toggle
        >
        <mat-slide-toggle [checked]="byProject()" (change)="byProject.set($event.checked)"
          >Group by project</mat-slide-toggle
        >
        <button mat-button type="button" (click)="clear()">Clear filters</button>
      </div>
      @if (error()) {
        <p class="k-alert" role="alert">{{ error() }}</p>
      } @else if (loading()) {
        <app-skeleton label="Loading work" />
      } @else if (filtered().length === 0 && view() === 'list') {
        <app-empty-state
          [title]="isMe() ? 'No matching work' : 'Nothing to show'"
          text="Try clearing filters or turn on Show done to see finished items."
        />
      } @else {
        @if (filtered().length === 0) {
          <app-empty-state
            [title]="isMe() ? 'No matching work' : 'Nothing to show'"
            text="Try clearing filters or turn on Show done."
          />
        }
        <p class="muted" role="status">{{ filtered().length }} items</p>
        @for (section of sections(); track section.id) {
          <section [attr.aria-label]="section.name">
            @if (section.name) {
              <h2>{{ section.name }}</h2>
            }
            @if (view() === 'list') {
              <ul class="plain list" aria-label="Work items">
                @for (i of section.items; track i.id) {
                  <li
                    class="card"
                    [class.cover]="i.labelStyle === 'COVER' && i.labels.length > 0"
                    [style.--k-work-cover]="i.labels[0]?.colour"
                  >
                    <a class="entry" [routerLink]="link(i)"
                      ><app-type-icon [type]="i.type" /><span class="k-key">{{ i.key }}</span
                      ><span class="title">{{ i.title }}</span
                      ><app-status-pill [status]="i.status"
                    /></a>
                    <div class="meta">
                      <span class="k-pill">{{ i.projectName }}</span>
                      @if (i.bucket) {
                        <span class="k-pill">{{ i.bucket.name }}</span>
                      }
                      @if (i.dueDate) {
                        <span class="k-pill" [class.danger]="overdue(i)">{{ dateText(i) }}</span>
                      }
                      @for (l of i.labels; track l.id) {
                        <app-label-pill
                          [name]="l.name"
                          [colour]="l.colour"
                          [labelStyle]="i.labelStyle"
                        />
                      }
                    </div>
                  </li>
                }
              </ul>
            } @else {
              <div
                class="columns"
                cdkDropListGroup
                tabindex="0"
                role="region"
                [attr.aria-label]="(section.name || 'Work') + ' status board'"
              >
                @for (status of statuses; track status) {
                  <div class="column">
                    <h3>
                      {{ statusLabels[status] }}
                      <span class="k-pill">{{ inStatus(section.items, status).length }}</span>
                    </h3>
                    <div
                      class="list"
                      cdkDropList
                      [cdkDropListData]="status"
                      [cdkDropListSortingDisabled]="true"
                      (cdkDropListDropped)="drop($event)"
                    >
                      @for (i of inStatus(section.items, status); track i.id) {
                        <article
                          class="card"
                          [class.cover]="i.labelStyle === 'COVER' && i.labels.length > 0"
                          [style.--k-work-cover]="i.labels[0]?.colour"
                          cdkDrag
                          [cdkDragData]="i"
                          [cdkDragDisabled]="!i.canEdit || busy().has(i.id)"
                        >
                          <a class="entry" [routerLink]="link(i)"
                            ><app-type-icon [type]="i.type" /><span class="k-key">{{ i.key }}</span
                            ><span class="title">{{ i.title }}</span></a
                          >
                          <div class="meta">
                            <span class="k-pill">{{ i.projectName }}</span>
                            @if (i.bucket) {
                              <span class="k-pill">{{ i.bucket.name }}</span>
                            }
                            @if (i.dueDate) {
                              <span class="k-pill" [class.danger]="overdue(i)">{{
                                dateText(i)
                              }}</span>
                            }
                            @for (l of i.labels; track l.id) {
                              <app-label-pill
                                [name]="l.name"
                                [colour]="l.colour"
                                [labelStyle]="i.labelStyle"
                              />
                            }
                          </div>
                          @if (i.canEdit) {
                            <mat-form-field
                              ><mat-label>Status for {{ i.title }}</mat-label
                              ><mat-select
                                [value]="i.status"
                                [disabled]="busy().has(i.id)"
                                (valueChange)="changeStatus(i, $event)"
                              >
                                @for (s of statuses; track s) {
                                  <mat-option [value]="s">{{ statusLabels[s] }}</mat-option>
                                }
                              </mat-select></mat-form-field
                            >
                          }
                        </article>
                      } @empty {
                        <p class="muted">No matching cards</p>
                      }
                    </div>
                  </div>
                }
              </div>
            }
          </section>
        }
      }
    </div>
  `,
})
export class WorkPage {
  private readonly api = inject(WorkApiService);
  private readonly itemsApi = inject(ItemsApiService);
  private readonly session = inject(SessionStore);
  private readonly toast = inject(ToastService);
  /** Optional person route parameter; /work uses the session identity. */
  readonly userId = input('');
  /** Default list, with an optional status board. */
  protected readonly view = signal<'list' | 'board'>('list');
  /** Include finished tasks on request. */
  protected readonly includeDone = signal(false);
  /** Add tasks created by the selected person. */
  protected readonly includeCreated = signal(false);
  /** Group either view by project. */
  protected readonly byProject = signal(false);
  /** Narrowing controls never change the readable scope. */
  protected readonly filter = signal<WorkFilter>({
    source: 'ALL',
    projectId: '',
    type: '',
    labelId: '',
    due: '',
  });
  /** The selected person's safe public identity. */
  protected readonly person = signal<WorkPersonDto | null>(null);
  /** Complete readable result across all pages. */
  protected readonly items = signal<WorkSummaryDto[]>([]);
  /** Pending status writes, by item id. */
  protected readonly busy = signal(new Set<string>());
  /** Load state. */
  protected readonly loading = signal(false);
  /** Load error. */
  protected readonly error = signal('');
  /** True only for the signed-in person's work. */
  protected readonly isMe = computed(
    () => !this.userId() || this.session.user()?.id === this.userId(),
  );
  private readonly today = isoDate(new Date());
  private run = 0;
  /** Semantic statuses in SPEC order. */
  protected readonly statuses = Object.values(ItemStatus);
  /** Item types. */
  protected readonly types = Object.values(ItemType);
  /** Human-readable status names. */
  protected readonly statusLabels = STATUS_LABELS;
  /** Human-readable type names. */
  protected readonly typeLabels = TYPE_LABELS;
  /** Date groups in order. */
  protected readonly dueGroups = ['Overdue', 'Today', 'This week', 'Later', 'No date'];
  /** Narrowed results. */
  protected readonly filtered = computed(() =>
    filterWork(
      this.items().filter((i) => this.includeDone() || i.status !== 'DONE'),
      this.filter(),
      this.today,
    ),
  );
  /** Named list sections or project boards. */
  protected readonly sections = computed(() =>
    this.view() === 'board' && !this.byProject()
      ? [{ id: 'all', name: '', items: this.filtered() }]
      : groupWork(this.filtered(), this.byProject(), this.today),
  );
  /** Readable projects present in eligible work. */
  protected readonly projects = computed(() => [
    ...new Map(
      this.items().map((i) => [i.projectId, { id: i.projectId, name: i.projectName }]),
    ).values(),
  ]);
  /** Labels keep project identity even when names match. */
  protected readonly labels = computed(() => [
    ...new Map(
      this.items().flatMap((i) =>
        i.labels.map((l) => [l.id, { ...l, project: i.projectName }] as const),
      ),
    ).values(),
  ]);

  /** Reloads when the person or inclusion rules change; local filters retain all pages. */
  constructor() {
    const destroy = inject(DestroyRef);
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    destroy.onDestroy(() => {
      ++this.run;
    });
    inject(Shortcuts).register((key) => {
      if (key !== 'j' && key !== 'k') return false;
      const links = [...host.querySelectorAll<HTMLAnchorElement>('a.entry')];
      if (links.length === 0) return false;
      const current = links.indexOf(document.activeElement as HTMLAnchorElement);
      const next =
        current < 0 ? 0 : Math.max(0, Math.min(links.length - 1, current + (key === 'j' ? 1 : -1)));
      links[next]?.focus();
      return true;
    }, destroy);
    effect(() => {
      const id = this.userId() || this.session.user()?.id;
      const done = this.includeDone();
      const created = this.includeCreated();
      if (id) untracked(() => void this.load(id, done, created));
    });
  }

  /**
   * Changes a narrowing control.
   * @param patch Changed filters.
   */
  protected setFilter(patch: Partial<WorkFilter>): void {
    this.filter.update((f) => ({ ...f, ...patch }));
  }
  /** Clears narrowing controls while retaining explicit Done/created choices. */
  protected clear(): void {
    this.filter.set({ source: 'ALL', projectId: '', type: '', labelId: '', due: '' });
  }
  /**
   * Builds a deep link inside the item's own space.
   * @param item Readable work item.
   * @returns Router commands.
   */
  protected link(item: WorkSummaryDto): (string | number)[] {
    return ['/p', item.projectKey ?? 'personal', 'items', item.number];
  }
  /**
   * Selects cards of one status without changing their bucket.
   * @param items Section items.
   * @param status Column status.
   * @returns Cards of that status.
   */
  protected inStatus(items: WorkSummaryDto[], status: ItemStatus): WorkSummaryDto[] {
    return items.filter((i) => i.status === status);
  }
  /**
   * Formats a due date.
   * @param item The item.
   * @returns Accessible due text.
   */
  protected dateText(item: WorkSummaryDto): string {
    return dueText(item, this.today);
  }
  /**
   * Identifies overdue open work.
   * @param item The item.
   * @returns True when overdue.
   */
  protected overdue(item: WorkSummaryDto): boolean {
    return dueState(item, this.today) === 'overdue';
  }
  /**
   * Applies the same status edit as the keyboard select.
   * @param event A drag into a status column.
   */
  protected drop(event: CdkDragDrop<ItemStatus, ItemStatus, WorkSummaryDto>): void {
    void this.changeStatus(event.item.data, event.container.data);
  }
  /**
   * Optimistically edits status through the ordinary guarded project endpoint.
   * @param item The readable card with API-provided edit capability.
   * @param status New status; server applies that project's statusToBucket rule.
   * @returns Resolves after confirmation or rollback.
   */
  protected async changeStatus(item: WorkSummaryDto, status: ItemStatus): Promise<void> {
    if (!item.canEdit || item.status === status || this.busy().has(item.id)) return;
    const run = this.run;
    this.busy.update((ids) => new Set([...ids, item.id]));
    this.items.update((rows) => rows.map((i) => (i.id === item.id ? { ...i, status } : i)));
    try {
      const changed = await this.itemsApi.update(item.projectId, item.id, { status });
      if (run !== this.run) return;
      let bucketName = item.bucket?.name;
      let detailError = '';
      if (changed.bucketId !== null && changed.bucketId !== item.bucket?.id) {
        try {
          bucketName = (await this.itemsApi.buckets(item.projectId)).find(
            (b) => b.id === changed.bucketId,
          )?.name;
        } catch (error) {
          // The write succeeded. A subsequent metadata read must never make
          // the card falsely appear rolled back to its former status.
          detailError = errorMessage(error);
          bucketName = 'Bucket details unavailable';
        }
      }
      if (run !== this.run) return;
      this.items.update((rows) =>
        rows.map((i) =>
          i.id === item.id
            ? {
                ...i,
                status: changed.status,
                canEdit: changed.can.edit,
                bucket:
                  changed.bucketId === null
                    ? null
                    : { id: changed.bucketId, name: bucketName ?? 'Bucket' },
              }
            : i,
        ),
      );
      this.toast.show(
        `${item.key} · ${STATUS_LABELS[changed.status]}${detailError ? ' · ' + detailError : ''}`,
        async () => {
          // Status and bucket are independent. Restore status first, so its
          // mapping cannot undo the subsequent return to the original bucket.
          let restored = await this.itemsApi.update(item.projectId, item.id, {
            status: item.status,
          });
          if (restored.bucketId !== (item.bucket?.id ?? null))
            restored = await this.itemsApi.move(item.projectId, item.id, {
              bucketId: item.bucket?.id ?? null,
              afterId: null,
            });
          // An entry rule may have changed status; its ordinary edit can put
          // it back when the current mapping permits that independent pair.
          if (restored.status !== item.status)
            restored = await this.itemsApi.update(item.projectId, item.id, { status: item.status });
          if (run === this.run)
            await this.load(
              this.userId() || this.session.user()?.id || '',
              this.includeDone(),
              this.includeCreated(),
            );
          if (restored.status !== item.status || restored.bucketId !== (item.bucket?.id ?? null))
            throw new Error(
              'The current bucket rules prevent restoring both the previous status and bucket. The saved item has been refreshed.',
            );
        },
      );
    } catch (error) {
      if (run === this.run)
        this.items.update((rows) => rows.map((i) => (i.id === item.id ? item : i)));
      this.toast.error(error);
    } finally {
      this.busy.update((ids) => {
        const next = new Set(ids);
        next.delete(item.id);
        return next;
      });
    }
  }
  /**
   * Reads every matching page before grouping/filtering; stale answers are ignored.
   * @param id Selected person.
   * @param done Include Done.
   * @param created Include created items.
   * @returns Resolves once loaded.
   */
  private async load(id: string, done: boolean, created: boolean): Promise<void> {
    const run = ++this.run;
    this.loading.set(true);
    this.error.set('');
    this.items.set([]);
    if (this.person()?.id !== id) {
      this.person.set(null);
      this.clear();
    }
    try {
      const rows: WorkSummaryDto[] = [];
      let cursor: string | null = null;
      do {
        const page = await this.api.list(this.userId() ? id : 'me', {
          includeDone: done,
          ...(created ? { includeCreated: true } : {}),
          ...(cursor ? { cursor } : {}),
        });
        if (run !== this.run) return;
        this.person.set(page.user);
        rows.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== null);
      this.items.set(rows);
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
