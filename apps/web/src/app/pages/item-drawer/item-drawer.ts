import {
  afterNextRender,
  Component,
  computed,
  effect,
  type ElementRef,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MatMenuModule } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';
import { Router } from '@angular/router';
import {
  ALLOWED_PARENT_TYPES,
  ItemStatus,
  ItemType,
  inlineImagePath,
  ITEM_TITLE_MAX,
  LabelStyle,
  type MoveItemRequest,
  PRIORITY_MAX,
  PRIORITY_MIN,
  requiresBucket,
  SprintState,
  type UpdateItemRequest,
  type WorkItemDetailDto,
  type WorkItemDto,
} from '@kloister/shared';
import { AnnotationsApiService } from '../../core/annotations-api.service';
import { errorMessage } from '../../core/api';
import { isoDate, NONE } from '../../core/board-logic';
import { dueState, dueText, revertMove, shortDate, undoFields } from '../../core/item-changes';
import { ItemsApiService } from '../../core/items-api.service';
import { PRIORITY_LABELS, SPRINT_STATE_LABELS, TYPE_LABELS } from '../../core/labels';
import { ProjectContext } from '../../core/project-context';
import { forDisplay, type Mentionable } from '../../core/rich-text';
import { SessionStore } from '../../core/session.store';
import { Avatar, PERSON_FILTER, StaticAvatar } from '../../ui/avatar';
import { Dialogs } from '../../ui/dialogs';
import { Skeleton } from '../../ui/feedback';
import { Icon } from '../../ui/icon';
import { ViewImages } from '../../ui/image-viewer';
import { LabelPill } from '../../ui/label-pill';
import { PriorityIcon, StatusPill, TypeIcon } from '../../ui/signals';
import { ToastService } from '../../ui/toast.service';
import { ItemActivity } from './item-activity';
import { ItemAttachments } from './item-attachments';
import { ItemChecklist } from './item-checklist';
import { type ImageUploader, RichTextEditor } from './rich-text-editor';

/** Display names of the fields, for toasts. */
const FIELD_NAMES: Record<string, string> = {
  type: 'Type',
  title: 'Title',
  description: 'Description',
  parentId: 'Parent',
  status: 'Status',
  priority: 'Priority',
  sprintId: 'Sprint',
  teamId: 'Team',
  startDate: 'Start date',
  dueDate: 'Due date',
  assigneeIds: 'Assignees',
  labelIds: 'Labels',
};

/**
 * The item detail drawer (SPEC §6, DESIGN §10), deep-linkable at
 * `/p/:key/items/:number` and also opened beside the backlog.
 *
 * Every value is edited in place: a click opens a select, date field or text
 * field, the change is saved at once and a toast offers Undo (the reverse
 * PATCH or move). Values the caller cannot change are plain text: editing
 * needs the item's `can.edit` (fields, checklist, dependencies), `can.move`
 * (bucket) or `can.delete`/`deleteCascade`, on an unarchived project.
 * Assigning anyone but yourself also needs `ASSIGN_OTHERS` or leading the
 * item's team. The API checks every change again; its answer (e.g. the
 * bucket chosen by `statusToBucket`, or the status set by a bucket's entry
 * rule) replaces what is shown.
 *
 * Ancestors outside the caller's scope are shown as read-only titles
 * (SPEC §3.3). Notes, attachments and images pasted or dropped into the
 * description or notes need the item's `can.annotate` (SPEC §3.2 "Notes and
 * attachments"); images open in the full-size viewer (DESIGN §10).
 */
@Component({
  selector: 'app-item-drawer',
  imports: [
    MatMenuModule,
    MatSelectModule,
    Avatar,
    Icon,
    ItemActivity,
    ItemAttachments,
    ItemChecklist,
    LabelPill,
    PriorityIcon,
    RichTextEditor,
    Skeleton,
    StaticAvatar,
    StatusPill,
    TypeIcon,
    ViewImages,
  ],
  // Avatars here show their hover card on click; they do not filter the
  // board behind the drawer.
  providers: [{ provide: PERSON_FILTER, useValue: null }],
  host: {
    '(keydown.escape)': 'onEscape($event)',
  },
  template: `
    <div class="drawer-scrim" aria-hidden="true" (click)="close()"></div>
    <div #panel class="d-panel" role="complementary" aria-label="Item details" tabindex="-1">
      <div class="d-top">
        <nav class="crumbs" aria-label="Parents">
          @if (detail(); as d) {
            @for (a of d.ancestors; track a.id; let last = $last) {
              @if (isVisible(a.id)) {
                <a href="" (click)="openItem($event, a.number)"
                  ><app-type-icon [type]="a.type" /><span class="k-key">{{ a.key }}</span
                  >{{ a.title }}</a
                >
              } @else {
                <span class="ref" title="Outside your view: shown as a title only"
                  ><app-type-icon [type]="a.type" /><span class="k-key">{{ a.key }}</span
                  >{{ a.title }}</span
                >
              }
              @if (!last) {
                <span aria-hidden="true">›</span>
              }
            }
          }
        </nav>
        <span class="spacer"></span>
        <button type="button" class="k-icon-btn" aria-label="Copy link" (click)="copyLink()">
          <app-icon name="link" [size]="17" />
        </button>
        @if (canDelete()) {
          <button
            type="button"
            class="k-icon-btn"
            aria-label="More actions"
            [matMenuTriggerFor]="more"
          >
            <app-icon name="more" [size]="17" [stroke]="3" />
          </button>
          <mat-menu #more="matMenu">
            <button mat-menu-item type="button" (click)="remove()">
              <app-icon name="trash" />&nbsp;Delete item
            </button>
          </mat-menu>
        }
        <button type="button" class="k-icon-btn" aria-label="Close" (click)="close()">
          <app-icon name="close" [size]="18" [stroke]="2.2" />
        </button>
      </div>

      <div class="d-body">
        @if (error()) {
          <p class="k-alert" role="alert">{{ error() }}</p>
        }

        <!-- Re-created after a refused change, so every control shows the stored value again. -->
        @for (view of views(); track view.key) {
          @let d = view.item;
          <div class="d-head">
            <div class="d-kind">
              <app-type-icon [type]="d.type" [large]="true" />
              <span class="k-key">{{ d.key }} · {{ typeLabels[d.type] }}</span>
            </div>
            <h1 class="d-title">
              @if (editingTitle()) {
                <input
                  #titleInput
                  class="title-input"
                  aria-label="Title"
                  [value]="d.title"
                  [attr.maxlength]="titleMax"
                  (keydown.enter)="saveTitle($any($event.target))"
                  (keydown.escape)="cancelTitle($event)"
                  (blur)="saveTitle($any($event.target))"
                />
              } @else if (canEdit()) {
                <button
                  type="button"
                  class="title-btn"
                  title="Edit the title"
                  (click)="editTitle()"
                >
                  {{ d.title }}
                </button>
              } @else {
                {{ d.title }}
              }
            </h1>
            <div class="d-pills">
              @if (canEdit()) {
                <mat-select
                  class="pill-select"
                  aria-label="Status"
                  panelWidth="200"
                  [value]="d.status"
                  (valueChange)="save({ status: $event })"
                >
                  <mat-select-trigger
                    ><app-status-pill [status]="d.status" [large]="true"
                  /></mat-select-trigger>
                  @for (s of statuses; track s) {
                    <mat-option [value]="s"><app-status-pill [status]="s" /></mat-option>
                  }
                </mat-select>
              } @else {
                <app-status-pill [status]="d.status" [large]="true" />
              }
              @if (canMove()) {
                <mat-select
                  class="pill-select"
                  aria-label="Bucket"
                  panelWidth="220"
                  [value]="d.bucketId ?? none"
                  (valueChange)="moveTo($event)"
                >
                  <mat-select-trigger
                    ><span class="bucket-pill"
                      >{{ bucketName(d) }}<app-icon name="chevronDown" [size]="13" /></span
                  ></mat-select-trigger>
                  @if (!needsBucket()) {
                    <mat-option [value]="none">Off the board</mat-option>
                  }
                  @for (b of ctx.buckets(); track b.id) {
                    <mat-option [value]="b.id">{{ b.name }}</mat-option>
                  }
                </mat-select>
              } @else {
                <span class="bucket-pill" aria-label="Bucket">{{ bucketName(d) }}</span>
              }
            </div>
          </div>

          <dl class="fields">
            <dt>Assignees</dt>
            <dd>
              @if (canEdit()) {
                <mat-select
                  class="k-inline"
                  aria-label="Assignees"
                  multiple
                  panelWidth="260"
                  [value]="d.assigneeIds"
                  (selectionChange)="save({ assigneeIds: $event.value })"
                  placeholder="Nobody"
                >
                  <mat-select-trigger>
                    <span class="trigger">
                      @for (p of assignees(); track p.id) {
                        <span class="trigger"
                          ><app-avatar-static [userId]="p.id" [name]="p.name" />{{ p.name }}</span
                        >
                      }
                    </span>
                  </mat-select-trigger>
                  @for (m of assignable(); track m.userId) {
                    <mat-option [value]="m.userId" [disabled]="!canAssign(m.userId)">{{
                      m.displayName
                    }}</mat-option>
                  }
                </mat-select>
              } @else {
                <div class="plain">
                  @for (p of assignees(); track p.id) {
                    <span class="trigger"
                      ><app-avatar [userId]="p.id" [name]="p.name" [email]="p.email" />{{
                        p.name
                      }}</span
                    >
                  } @empty {
                    <span class="muted">Nobody</span>
                  }
                </div>
              }
            </dd>

            <dt>Labels</dt>
            <dd>
              @if (canEdit()) {
                <mat-select
                  class="k-inline"
                  aria-label="Labels"
                  multiple
                  panelWidth="240"
                  [value]="d.labelIds"
                  (selectionChange)="save({ labelIds: $event.value })"
                  placeholder="No labels"
                >
                  <mat-select-trigger>
                    <span class="trigger">
                      @for (l of itemLabels(); track l.id) {
                        <app-label-pill
                          [name]="l.name"
                          [colour]="l.colour"
                          [labelStyle]="labelStyle()"
                          [large]="true"
                        />
                      }
                    </span>
                  </mat-select-trigger>
                  @for (l of ctx.labels(); track l.id) {
                    <mat-option [value]="l.id"
                      ><app-label-pill
                        [name]="l.name"
                        [colour]="l.colour"
                        [labelStyle]="labelStyle()"
                    /></mat-option>
                  }
                </mat-select>
              } @else {
                <div class="plain">
                  @for (l of itemLabels(); track l.id) {
                    <app-label-pill
                      [name]="l.name"
                      [colour]="l.colour"
                      [labelStyle]="labelStyle()"
                      [large]="true"
                    />
                  } @empty {
                    <span class="muted">No labels</span>
                  }
                </div>
              }
            </dd>

            <dt>Sprint</dt>
            <dd>
              @if (canEdit()) {
                <mat-select
                  class="k-inline"
                  aria-label="Sprint"
                  panelWidth="260"
                  [value]="d.sprintId ?? none"
                  (valueChange)="save({ sprintId: orNull($event) })"
                >
                  <mat-option [value]="none">No sprint</mat-option>
                  @for (s of ctx.sprints(); track s.id) {
                    @if (s.state !== closed || s.id === d.sprintId) {
                      <mat-option [value]="s.id" [disabled]="s.state === closed"
                        >{{ s.name }} · {{ sprintStates[s.state] }}</mat-option
                      >
                    }
                  }
                </mat-select>
              } @else {
                <div class="plain">{{ sprintName(d) }}</div>
              }
            </dd>

            <dt>Priority</dt>
            <dd>
              @if (canEdit()) {
                <mat-select
                  class="k-inline"
                  aria-label="Priority"
                  panelWidth="200"
                  [value]="d.priority"
                  (valueChange)="save({ priority: $event })"
                >
                  <mat-select-trigger
                    ><span class="trigger"
                      ><app-priority-icon [priority]="d.priority" />{{
                        priorityLabels[d.priority]
                      }}</span
                    ></mat-select-trigger
                  >
                  @for (p of priorities; track p) {
                    <mat-option [value]="p"
                      ><span class="trigger"
                        ><app-priority-icon [priority]="p" />{{ priorityLabels[p] }}</span
                      ></mat-option
                    >
                  }
                </mat-select>
              } @else {
                <div class="plain">
                  <app-priority-icon [priority]="d.priority" />{{ priorityLabels[d.priority] }}
                </div>
              }
            </dd>

            <dt>Dates</dt>
            <dd>
              <div class="dates">
                @if (canEdit()) {
                  <input
                    class="k-inline"
                    type="date"
                    aria-label="Start date"
                    [value]="d.startDate ?? ''"
                    (change)="save({ startDate: $any($event.target).value || null })"
                  />
                  <span class="muted" aria-hidden="true">→</span>
                  <input
                    class="k-inline"
                    type="date"
                    aria-label="Due date"
                    [value]="d.dueDate ?? ''"
                    (change)="save({ dueDate: $any($event.target).value || null })"
                  />
                } @else {
                  <span class="plain">
                    {{ d.startDate ? short(d.startDate) : 'No start' }} →
                    {{ d.dueDate ? short(d.dueDate) : 'no due date' }}
                  </span>
                }
                @if (due(); as due) {
                  <span
                    class="k-pill"
                    [class.danger]="due.state === 'overdue'"
                    [class.warn]="due.state === 'soon'"
                    >{{ due.text }}</span
                  >
                }
              </div>
            </dd>

            @if (ctx.teams().length > 0 || d.teamId) {
              <dt>Team</dt>
              <dd>
                @if (canEdit()) {
                  <mat-select
                    class="k-inline"
                    aria-label="Team"
                    panelWidth="240"
                    [value]="d.teamId ?? none"
                    (valueChange)="save({ teamId: orNull($event) })"
                  >
                    <mat-option [value]="none">No team</mat-option>
                    @for (t of ctx.teams(); track t.id) {
                      <mat-option [value]="t.id" [disabled]="!ctx.canPickTeam(t.id)">{{
                        t.name
                      }}</mat-option>
                    }
                  </mat-select>
                } @else {
                  <div class="plain">{{ teamName(d) }}</div>
                }
              </dd>
            }

            <dt>Type</dt>
            <dd>
              @if (canEdit()) {
                <mat-select
                  class="k-inline"
                  aria-label="Type"
                  panelWidth="200"
                  [value]="d.type"
                  (valueChange)="save({ type: $event })"
                >
                  @for (t of types; track t) {
                    <mat-option [value]="t">{{ typeLabels[t] }}</mat-option>
                  }
                </mat-select>
              } @else {
                <div class="plain">{{ typeLabels[d.type] }}</div>
              }
            </dd>

            <dt>Parent</dt>
            <dd>
              @if (canEdit() && d.type !== epic) {
                <mat-select
                  class="k-inline"
                  aria-label="Parent"
                  panelWidth="320"
                  [value]="d.parentId ?? none"
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
              } @else {
                <div class="plain">
                  @if (d.ancestors.at(-1); as p) {
                    {{ p.key }} {{ p.title }}
                  } @else {
                    <span class="muted">No parent</span>
                  }
                </div>
              }
            </dd>
          </dl>

          <section aria-labelledby="d-desc">
            <h2 id="d-desc">Description</h2>
            @if (canEdit()) {
              <app-rich-text-editor
                [html]="d.description"
                [uploadImage]="imageUploader()"
                (save)="save({ description: $event })"
              />
            } @else if (d.description) {
              <div class="description k-rich" appViewImages [innerHTML]="descriptionHtml()"></div>
            } @else {
              <p class="muted">No description.</p>
            }
          </section>

          <section aria-label="Checklist">
            <app-item-checklist
              [projectId]="projectId()"
              [itemId]="d.id"
              [items]="d.checklistItems"
              [canEdit]="canEdit()"
              (changed)="reload()"
            />
          </section>

          <section aria-labelledby="d-deps">
            <h2 id="d-deps">Dependencies</h2>
            <div class="refs">
              @for (r of d.blockedBy; track r.id) {
                <div class="ref-row blocked">
                  <span class="k-pill warn" style="background: var(--k-surface)">Blocked by</span>
                  <span class="k-key">{{ r.key }}</span>
                  <a class="ref-title" href="" (click)="openItem($event, r.number)">{{
                    r.title
                  }}</a>
                  @if (canEdit()) {
                    <button
                      type="button"
                      class="k-icon-btn sm"
                      [attr.aria-label]="'Remove blocker ' + r.key"
                      (click)="removeBlocker(r.id)"
                    >
                      <app-icon name="close" />
                    </button>
                  }
                </div>
              }
              @for (r of d.blocks; track r.id) {
                <div class="ref-row">
                  <span class="k-pill">Blocks</span>
                  <span class="k-key">{{ r.key }}</span>
                  <a class="ref-title" href="" (click)="openItem($event, r.number)">{{
                    r.title
                  }}</a>
                </div>
              }
              @if (d.blockedBy.length === 0 && d.blocks.length === 0) {
                <p class="muted">No dependencies.</p>
              }
            </div>
            @if (canEdit()) {
              <mat-select
                class="k-inline add-ref"
                aria-label="Add a blocking item"
                placeholder="+ Add a blocking item"
                panelWidth="360"
                (valueChange)="addBlocker($event)"
              >
                @for (i of blockerOptions(); track i.id) {
                  <mat-option [value]="i.id">{{ i.key }} {{ i.title }}</mat-option>
                }
              </mat-select>
            }
          </section>

          <section aria-labelledby="d-children">
            <h2 id="d-children">Children</h2>
            <div class="refs">
              @for (c of children(); track c.id) {
                <div class="ref-row">
                  <app-type-icon [type]="c.type" />
                  <span class="k-key">{{ c.key }}</span>
                  <a class="ref-title" href="" (click)="openItem($event, c.number)">{{
                    c.title
                  }}</a>
                  <app-status-pill [status]="c.status" />
                </div>
              } @empty {
                <p class="muted">No children.</p>
              }
            </div>
            @if (childCursor()) {
              <button type="button" class="k-action" (click)="moreChildren()">
                Show more children
              </button>
            }
          </section>

          <section aria-labelledby="d-files">
            <app-item-attachments
              [projectId]="projectId()"
              [itemId]="d.id"
              [canAdd]="canAnnotate()"
              [writable]="ctx.writable()"
              (changed)="reloadHistory()"
            />
          </section>

          <section aria-labelledby="d-activity">
            <app-item-activity
              [projectId]="projectId()"
              [itemId]="d.id"
              [version]="version()"
              [canAnnotate]="canAnnotate()"
              [writable]="ctx.writable()"
              [mentionables]="mentionables()"
              [uploadImage]="imageUploader()"
            />
          </section>
        } @empty {
          @if (!error()) {
            <app-skeleton label="Loading the item" [rows]="6" />
          }
        }
      </div>
    </div>
  `,
})
export class ItemDrawer {
  /** Shared project state. */
  protected readonly ctx = inject(ProjectContext);
  private readonly api = inject(ItemsApiService);
  private readonly router = inject(Router);
  private readonly session = inject(SessionStore);
  private readonly toast = inject(ToastService);
  private readonly dialogs = inject(Dialogs);
  private readonly annotations = inject(AnnotationsApiService);
  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');

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
  /** Priority names. */
  protected readonly priorityLabels = PRIORITY_LABELS;
  /** Sprint state names. */
  protected readonly sprintStates = SPRINT_STATE_LABELS;
  /** Longest title accepted. */
  protected readonly titleMax = ITEM_TITLE_MAX;
  /** Today, for the due pill. */
  private readonly today = isoDate(new Date());

  /** The item, or null while loading or after an error. */
  protected readonly detail = signal<WorkItemDetailDto | null>(null);
  /** Loaded children. */
  protected readonly children = signal<WorkItemDto[]>([]);
  /** Cursor for more children, or null. */
  protected readonly childCursor = signal<string | null>(null);
  /** Bumped after each change so the activity history reloads. */
  protected readonly version = signal(0);
  /** Last load error, if any. */
  protected readonly error = signal('');
  /** True while the title is being edited. */
  protected readonly editingTitle = signal(false);
  /** Counts item loads, so answers for an item no longer open are dropped. */
  private loadRun = 0;
  /** Bumped when a change is refused, to rebuild the controls. */
  private readonly resets = signal(0);
  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('titleInput');

  /** The item as a one-element list keyed by {@link resets}, for the template. */
  protected readonly views = computed(() => {
    const item = this.detail();
    return item === null ? [] : [{ item, key: this.resets() }];
  });

  /** Project id. */
  protected readonly projectId = computed(() => this.ctx.project()?.id ?? '');
  /** The project's label style. */
  protected readonly labelStyle = computed(
    () => this.ctx.project()?.settings.labelStyle ?? LabelStyle.SOLID,
  );

  /** Fields, checklist and dependencies are editable. */
  protected readonly canEdit = computed(() => {
    const d = this.detail();
    return d !== null && this.ctx.canEdit(d);
  });
  /** The bucket is editable. */
  protected readonly canMove = computed(() => {
    const d = this.detail();
    return d !== null && this.ctx.canMove(d);
  });
  /** Notes, attachments and images can be added. */
  protected readonly canAnnotate = computed(() => {
    const d = this.detail();
    return d !== null && this.ctx.writable() && d.can.annotate;
  });
  /** Uploads images pasted or dropped into the description or a note. */
  protected readonly imageUploader = computed<ImageUploader | null>(() => {
    const d = this.detail();
    const projectId = this.projectId();
    if (d === null || !this.canAnnotate()) return null;
    return {
      prefix: inlineImagePath(projectId, d.id, ''),
      upload: (file: File) => this.annotations.addImage(projectId, d.id, file),
    };
  });
  /** Active members, who can be mentioned in notes. */
  protected readonly mentionables = computed<Mentionable[]>(() =>
    this.ctx
      .members()
      .filter((m) => m.isActive)
      .map((m) => ({ id: m.userId, name: m.displayName })),
  );
  /** The description prepared for read-only display. */
  protected readonly descriptionHtml = computed(() => forDisplay(this.detail()?.description ?? ''));

  /** Deleting is offered. */
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

  /** Assignees with names and emails. */
  protected readonly assignees = computed(() => {
    const byId = this.ctx.membersById();
    return (this.detail()?.assigneeIds ?? []).map((id) => {
      const m = byId.get(id);
      return { id, name: m?.displayName ?? 'Former member', email: m?.email ?? '' };
    });
  });

  /** The item's labels that still exist. */
  protected readonly itemLabels = computed(() => {
    const byId = this.ctx.labelsById();
    return (this.detail()?.labelIds ?? []).map((id) => byId.get(id)).filter((l) => l !== undefined);
  });

  /** The due pill's text and urgency, or null. */
  protected readonly due = computed(() => {
    const d = this.detail();
    const state = d === null ? null : dueState(d, this.today);
    return d === null || state === null || state === 'later'
      ? null
      : { state, text: dueText(d, this.today) };
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
   * Loads the item whenever the number in the URL (or the project) changes,
   * and moves focus into the drawer when it opens.
   */
  constructor() {
    effect(() => {
      const projectId = this.projectId();
      const number = this.number();
      if (projectId === '') return;
      untracked(() => void this.load(projectId, number));
    });
    afterNextRender(() => this.panel().nativeElement.focus());
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

  /** Reloads the activity history, e.g. after an attachment was added. */
  protected reloadHistory(): void {
    this.version.update((v) => v + 1);
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
   * A short date for read-only values.
   *
   * @param date `YYYY-MM-DD`.
   * @returns E.g. "Fri 17 Oct".
   */
  protected short(date: string): string {
    return shortDate(date);
  }

  /**
   * The item's bucket name.
   *
   * @param d The item.
   * @returns The name, or "Off the board".
   */
  protected bucketName(d: WorkItemDto): string {
    return d.bucketId === null
      ? 'Off the board'
      : (this.ctx.bucketsById().get(d.bucketId)?.name ?? 'Unknown bucket');
  }

  /**
   * The item's sprint name with its dates and state.
   *
   * @param d The item.
   * @returns The text.
   */
  protected sprintName(d: WorkItemDto): string {
    const s = d.sprintId === null ? undefined : this.ctx.sprintsById().get(d.sprintId);
    return s === undefined ? 'No sprint' : `${s.name} · ${SPRINT_STATE_LABELS[s.state]}`;
  }

  /**
   * The item's team name.
   *
   * @param d The item.
   * @returns The name, or "No team".
   */
  protected teamName(d: WorkItemDto): string {
    return this.ctx.teams().find((t) => t.id === d.teamId)?.name ?? 'No team';
  }

  /** Starts editing the title and focuses the field. */
  protected editTitle(): void {
    this.editingTitle.set(true);
    setTimeout(() => this.titleInput()?.nativeElement.select());
  }

  /**
   * Esc in the title field puts the old title back without closing the drawer.
   *
   * @param event The key event.
   */
  protected cancelTitle(event: Event): void {
    event.stopPropagation();
    this.editingTitle.set(false);
  }

  /**
   * Saves a new title; an emptied or unchanged title is left as it was.
   *
   * @param input The title field.
   * @returns Resolves once saved.
   */
  protected async saveTitle(input: HTMLInputElement): Promise<void> {
    if (!this.editingTitle()) return;
    this.editingTitle.set(false);
    const title = input.value.trim();
    const d = this.detail();
    if (d === null || title === '' || title === d.title) return;
    await this.save({ title });
  }

  /**
   * Saves field changes, shows the item the API returns (whose bucket may
   * have moved through the project's `statusToBucket` map) and offers Undo.
   *
   * @param change Fields to change.
   * @returns Resolves once saved.
   */
  protected async save(change: UpdateItemRequest): Promise<void> {
    const d = this.detail();
    if (d === null) return;
    const names = Object.keys(change).map((k) => FIELD_NAMES[k] ?? k);
    await this.apply(
      () => this.api.update(this.projectId(), d.id, change),
      `${names.join(', ')} saved`,
    );
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
    const bucketId = this.orNull(value);
    const name =
      bucketId === null
        ? 'off the board'
        : `to ${this.ctx.bucketsById().get(bucketId)?.name ?? 'another bucket'}`;
    await this.apply(
      () => this.api.move(this.projectId(), d.id, { bucketId }),
      `${d.key} moved ${name}`,
    );
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
   * Copies the item's link to the clipboard.
   *
   * @returns Resolves once copied.
   */
  protected async copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(window.location.href);
      this.toast.show('Link copied');
    } catch {
      this.toast.error('The link could not be copied; copy it from the address bar.');
    }
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
    const confirmed = await this.dialogs.confirm({
      title: cascade ? `Delete ${d.key} and everything under it?` : `Delete ${d.key}?`,
      message: cascade
        ? `"${d.title}" and everything under it are deleted. This cannot be undone.`
        : `"${d.title}" is deleted. This cannot be undone.`,
      confirm: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await this.api.remove(this.projectId(), d.id, cascade);
      const gone = this.ctx
        .items()
        .filter((i) => i.id === d.id || i.ancestors.some((a) => a.id === d.id))
        .map((i) => i.id);
      this.ctx.forget(gone);
      this.toast.show(`${d.key} deleted`);
      this.close();
    } catch (error) {
      this.toast.error(error);
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
    try {
      const page = await this.api.children(this.projectId(), d.id, cursor);
      this.children.update((c) => [...c, ...page.items]);
      this.childCursor.set(page.nextCursor);
    } catch (error) {
      this.toast.error(error);
    }
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
   * Esc closes the drawer, except when it comes from an open select panel or
   * hover card (`aria-expanded="true"`), which closes itself instead.
   *
   * @param event The key event.
   */
  protected onEscape(event: Event): void {
    const target = event.target as HTMLElement | null;
    if (event.defaultPrevented || target?.closest('[aria-expanded="true"]')) return;
    this.close();
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
    this.error.set('');
    this.editingTitle.set(false);
    try {
      const [detail, children] = await Promise.all([
        this.api.get(projectId, number),
        this.api.children(projectId, number),
      ]);
      // A newer item was opened meanwhile; its answer wins.
      if (run !== this.loadRun) return;
      this.detail.set(detail);
      this.children.set(children.items);
      this.childCursor.set(children.nextCursor);
    } catch (error) {
      if (run === this.loadRun) this.error.set(errorMessage(error));
    }
  }

  /**
   * Runs a change, then shows and shares the item the API returned. With a
   * message, a toast confirms the change and offers Undo.
   *
   * @param change The request.
   * @param message Toast text, if the change should be undoable.
   * @returns Resolves once done.
   */
  private async apply(change: () => Promise<WorkItemDetailDto>, message?: string): Promise<void> {
    const run = this.loadRun;
    const before = this.detail();
    try {
      const updated = await change();
      this.ctx.upsert(updated);
      // Another item was opened meanwhile: keep showing that one.
      if (run !== this.loadRun) return;
      this.detail.set(updated);
      this.version.update((v) => v + 1);
      if (message !== undefined && before !== null) {
        this.toast.show(message, () => this.undo(run, before, updated));
      }
    } catch (error) {
      this.toast.error(error);
      // A refused change leaves the controls showing the rejected value;
      // build them again from the stored item.
      this.resets.update((n) => n + 1);
    }
  }

  /**
   * Reverses a change: moves the card back if its bucket changed, then puts
   * back every field that differs.
   *
   * @param run The load the change belonged to.
   * @param before The item before the change.
   * @param after The item after the change.
   * @returns Resolves once reverted.
   */
  private async undo(
    run: number,
    before: WorkItemDetailDto,
    after: WorkItemDetailDto,
  ): Promise<void> {
    let current = after;
    const move: MoveItemRequest | null = revertMove(before, after, undefined);
    if (move !== null) current = await this.api.move(this.projectId(), before.id, move);
    const fields = undoFields(before, after, current);
    if (fields !== null) current = await this.api.update(this.projectId(), before.id, fields);
    this.ctx.upsert(current);
    if (run === this.loadRun) {
      this.detail.set(current);
      this.version.update((v) => v + 1);
    }
  }
}
