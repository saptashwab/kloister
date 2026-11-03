import { BreakpointObserver } from '@angular/cdk/layout';
import { NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  type ElementRef,
  inject,
  Injector,
  type OnInit,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { type MatMenu, MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { MatDialog } from '@angular/material/dialog';
import { MatSelectModule } from '@angular/material/select';
import { ActivatedRoute, Router, RouterLink, RouterOutlet } from '@angular/router';
import {
  endSlot,
  finishAfter,
  type AssigneeShareDto,
  ITEM_TITLE_MAX,
  ItemStatus,
  ItemType,
  naturalChildType,
  type PlanEdge,
  PresenceAction,
  type PresenceField,
  ProjectPermission,
  type ProjectHolidaysDto,
  hasOwnSprint,
  type RescheduleChangeRequest,
  type ScheduleDates,
  slotHalfDay,
  startSlot,
  type WorkCalendar,
  workCalendar,
  type WorkItemDto,
  workingDuration,
} from '@kloister/shared';
import { firstValueFrom, map } from 'rxjs';
import { errorMessage } from '../../core/api';
import { buildTree, NONE, pruneTree } from '../../core/board-logic';
import { OutlineApiService } from './outline-api.service';
import { assertUndone, type BulkField, planBulk, runBulk, undoBulk } from '../../core/bulk';
import { Today } from '../../core/today';
import { ItemsApiService } from '../../core/items-api.service';
import { TrashApiService } from '../../core/trash-api.service';
import { STATUS_LABELS, TYPE_LABELS } from '../../core/labels';
import { PageActions } from '../../core/page-actions';
import { changedFields, CONFLICT_FIELDS, personName, personWithRole } from '../../core/live-logic';
import { type ItemHold, ProjectContext, type RemoteChange } from '../../core/project-context';
import { RescheduleFlow } from '../../core/reschedule';
import { parseWho, shareLabel, shareOf, sharesOf, whoText, withShareFor } from '../../core/shares';
import { type ShareChoice, ShareButtons, ShareKeys } from '../../ui/share-buttons';
import { SessionStore } from '../../core/session.store';
import {
  barBox,
  type BarBox,
  childTypeOf,
  conflicts,
  dateOfDay,
  dayNumber,
  openingDay,
  dueText,
  CELL_PADDING_PX,
  fitAvatars,
  durationText,
  halfX,
  applyOutlineMoves,
  type DropMove,
  type DropTarget,
  previousSibling,
  indentTarget,
  outdentTarget,
  parseDuration,
  parseHalfDay,
  parsePasted,
  parsePredecessors,
  planSpan,
  allowedTypes,
  typeName,
  keepDurations,
  percentComplete,
  rebaseDescendants,
  scaleTicks,
  shortDay,
  startText,
  timelineRows,
  type TimelineRow,
  timelineScale,
  type TimelineZoom,
} from '../../core/timeline-logic';
import { StaticAvatar } from '../../ui/avatar';
import { keepMine } from '../../ui/conflict';
import { Dialogs } from '../../ui/dialogs';
import { EmptyState, Skeleton } from '../../ui/feedback';
import { Icon } from '../../ui/icon';
import { PresenceAvatars } from '../../ui/live-ui';
import { StatusPill, TypeIcon } from '../../ui/signals';
import { ToastService } from '../../ui/toast.service';
import { dialogMotion } from '../../ui/motion';
import { HolidaysApiService } from '../../core/holidays-api.service';
import type { HolidaysDialogData, HolidaysDialogResult } from './holidays-dialog';
import { HEADER_PX, RowDrag } from './row-drag';
import {
  TimelineBarStyles,
  TimelineDragStyles,
  TimelineGridStyles,
  TimelineMarkStyles,
  TimelineToolStyles,
} from './timeline-styles';

/** Grid columns (docs/M9-PLAN.md §3.1). */
type ColumnId =
  | 'key'
  | 'title'
  | 'start'
  | 'days'
  | 'due'
  | 'pred'
  | 'who'
  | 'status'
  | 'type'
  | 'bucket'
  | 'sprint'
  | 'priority'
  | 'work'
  | 'progress';

/** The presence field each editable column names (M10). */
const COLUMN_FIELDS: Partial<Record<ColumnId, PresenceField>> = {
  title: 'title',
  start: 'startDate',
  days: 'duration',
  due: 'dueDate',
  pred: 'dependencies',
  who: 'assignees',
  status: 'status',
  type: 'type',
  sprint: 'sprint',
};

/** The item fields each text column writes, for the conflict notice (M10). */
const COLUMN_WRITES: Partial<Record<ColumnId, readonly (keyof WorkItemDto)[]>> = {
  title: CONFLICT_FIELDS.title,
  start: CONFLICT_FIELDS.dates,
  days: CONFLICT_FIELDS.dates,
  due: CONFLICT_FIELDS.dates,
};

/** A grid column. */
interface Column {
  /** Column id. */
  id: ColumnId;
  /** Header text. */
  label: string;
  /** Width in px. */
  width: number;
  /** How the cell is edited: typed text, a menu, or not at all. */
  edit: 'text' | 'menu' | null;
}

/** Columns that change an item's plan, kept to PMs and Leads by default (M9.2). */
const PLAN_COLUMNS: readonly ColumnId[] = [
  'title',
  'start',
  'days',
  'due',
  'pred',
  'type',
  'sprint',
];

/** Every column; the first eight are shown by default. */
const COLUMNS: Column[] = [
  { id: 'key', label: '#', width: 68, edit: null },
  { id: 'title', label: 'Title', width: 200, edit: 'text' },
  { id: 'start', label: 'Start', width: 104, edit: 'text' },
  { id: 'days', label: 'Days', width: 48, edit: 'text' },
  { id: 'due', label: 'Due', width: 104, edit: 'text' },
  { id: 'pred', label: 'Pred.', width: 56, edit: 'text' },
  { id: 'who', label: 'Who', width: 56, edit: 'menu' },
  { id: 'status', label: 'Status', width: 108, edit: 'menu' },
  { id: 'type', label: 'Type', width: 96, edit: 'menu' },
  { id: 'bucket', label: 'Bucket', width: 110, edit: null },
  { id: 'sprint', label: 'Sprint', width: 110, edit: 'menu' },
  { id: 'priority', label: 'Priority', width: 70, edit: null },
  { id: 'work', label: 'Work', width: 58, edit: null },
  { id: 'progress', label: '% complete', width: 100, edit: null },
];
const DEFAULT_COLUMNS: ColumnId[] = [
  'key',
  'title',
  'start',
  'days',
  'due',
  'pred',
  'who',
  'status',
];
const OPTIONAL = COLUMNS.filter(
  (c) => !DEFAULT_COLUMNS.includes(c.id) || c.id === 'who' || c.id === 'status',
);
const COLUMNS_KEY = 'kloister.timeline.columns';
/** Storage key of the dragged column widths. */
const WIDTHS_KEY = 'kloister.timeline.widths';
/** Storage key of the plan table's width beside the bars. */
const PANE_KEY = 'kloister.timeline.pane';
/** Narrowest the splitter makes the plan table. */
const MIN_PANE = 160;
/** Storage key of the row height choice. */
const DENSITY_KEY = 'kloister.timeline.rows';
/** Row heights: one line, or titles wrapping to two or three lines. */
type Density = 'compact' | 'two' | 'three';
const ROW_HEIGHT: Record<Density, number> = { compact: 34, two: 52, three: 70 };
const ROW_LINES: Record<Density, number> = { compact: 1, two: 2, three: 3 };
/** Narrowest and widest a column can be dragged. */
const MIN_WIDTH = 40;
const MAX_WIDTH = 600;
/** Width of the selection checkbox column. */
const CHECK = 36;

/** A pointer or keyboard change of a bar, in calendar half days. */
interface BarDraft {
  /** Item id. */
  id: string;
  /** Shift of the start. */
  start: number;
  /** Shift of the end. */
  end: number;
}

/**
 * The project timeline (SPEC §6.4, docs/M9-PLAN.md §3): a spreadsheet-like
 * grid of the visible items with bars beside it. Every row is an ordinary
 * item, so edits here show everywhere else. Typing in the grid is the main
 * way to plan; the drawer opens from the row key, the row menu or a double
 * click on a bar. Date changes go through {@link RescheduleFlow}, which
 * moves dependent items automatically or after a confirmation, as the
 * project is set up. Selected rows can be changed together.
 *
 * Controls follow the caller's capabilities; the API checks everything
 * again (SPEC §3.4).
 */
@Component({
  selector: 'app-timeline',
  host: {
    '[style.--tl-row.px]': 'rowHeight()',
    '[style.--tl-lines]': 'lines()',
    '[class.wrap]': "density() !== 'compact'",
  },
  imports: [
    NgTemplateOutlet,
    RouterOutlet,
    RouterLink,
    MatButtonModule,
    MatButtonToggleModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatMenuModule,
    MatSelectModule,
    EmptyState,
    Icon,
    PresenceAvatars,
    Skeleton,
    StaticAvatar,
    ShareButtons,
    StatusPill,
    TypeIcon,
    TimelineGridStyles,
    TimelineBarStyles,
    TimelineMarkStyles,
    TimelineToolStyles,
    TimelineDragStyles,
  ],
  template: `
    <app-timeline-grid-styles /><app-timeline-bar-styles /><app-timeline-mark-styles /><app-timeline-tool-styles /><app-timeline-drag-styles />
    <div class="tools k-page-tools" role="toolbar" aria-label="Timeline">
      @if (canCreate()) {
        <button mat-stroked-button type="button" (click)="focusAdd(null)">
          <app-icon name="plus" />Add row
        </button>
      }
      <button
        mat-icon-button
        type="button"
        aria-label="Outdent (Ctrl+[)"
        title="Outdent (Ctrl+[)"
        (click)="outline(-1)"
      >
        <app-icon name="outdent" />
      </button>
      <button
        mat-icon-button
        type="button"
        aria-label="Indent (Ctrl+])"
        title="Indent (Ctrl+])"
        (click)="outline(1)"
      >
        <app-icon name="indent" />
      </button>
      <mat-form-field subscriptSizing="dynamic">
        <mat-label>Search</mat-label>
        <input matInput [value]="text()" (input)="text.set($any($event.target).value)" />
      </mat-form-field>
      <mat-form-field subscriptSizing="dynamic">
        <mat-label>Type</mat-label>
        <mat-select [value]="typeFilter()" (valueChange)="typeFilter.set($event)">
          <mat-option value="">All types</mat-option>
          @for (t of types; track t) {
            <mat-option [value]="t">{{ typeLabels[t] }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field subscriptSizing="dynamic">
        <mat-label>Assignee</mat-label>
        <mat-select [value]="assigneeFilter()" (valueChange)="assigneeFilter.set($event)">
          <mat-option value="">Anyone</mat-option>
          @for (m of ctx.members(); track m.userId) {
            <mat-option [value]="m.userId">{{ m.displayName }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-checkbox [checked]="showDone()" (change)="showDone.set($event.checked)"
        >Show Done</mat-checkbox
      >
      <span class="grow"></span>
      <span class="mode" [class.auto]="auto()">
        <app-icon name="arrowRight" [size]="13" />{{
          auto() ? 'Dependent items move automatically' : 'Dependent moves are confirmed'
        }}
      </span>
      <mat-button-toggle-group
        class="k-segmented"
        aria-label="Zoom"
        hideSingleSelectionIndicator
        [value]="zoom()"
        (change)="zoom.set($event.value)"
      >
        @for (z of zooms; track z.id) {
          <mat-button-toggle [value]="z.id">{{ z.label }}</mat-button-toggle>
        }
      </mat-button-toggle-group>
      <button mat-stroked-button type="button" (click)="scrollToDay(todayDay())">Today</button>
      <button mat-stroked-button type="button" (click)="fitPlan()">Fit plan</button>
      <button mat-stroked-button type="button" (click)="openHolidays()">
        Holidays{{
          holidayInfo().holidays.length > 0 ? ' (' + holidayInfo().holidays.length + ')' : ''
        }}
      </button>
      <button mat-stroked-button type="button" [matMenuTriggerFor]="columnsMenu">Columns</button>
      <mat-form-field subscriptSizing="dynamic" class="rows">
        <mat-label>Rows</mat-label>
        <mat-select [value]="density()" (valueChange)="setDensity($event)">
          <mat-option value="compact">Compact</mat-option>
          <mat-option value="two">2 lines</mat-option>
          <mat-option value="three">3 lines</mat-option>
        </mat-select>
      </mat-form-field>
      <button mat-button type="button" (click)="collapsed.set(emptySet)">Expand all</button>
      <button mat-button type="button" (click)="collapsed.set(parentIds())">Collapse all</button>
      <mat-menu #columnsMenu="matMenu">
        @for (c of optional; track c.id) {
          <button
            mat-menu-item
            type="button"
            role="menuitemcheckbox"
            [attr.aria-checked]="shown().has(c.id)"
            (click)="toggleColumn(c.id); $event.stopPropagation()"
          >
            <app-icon [name]="shown().has(c.id) ? 'check' : 'plus'" />{{ c.label }}
          </button>
        }
        <button mat-menu-item type="button" (click)="resetWidths()">Reset column widths</button>
      </mat-menu>
    </div>

    @if (selected().size > 0) {
      <div class="bulk" role="region" aria-label="Selected rows">
        <span
          >{{ selected().size }} selected{{
            hiddenSelected() > 0 ? ' (' + hiddenSelected() + ' hidden by the filters)' : ''
          }}</span
        >
        @if (ctx.writable()) {
          @for (run of [bulkRuns()]; track run) {
            <mat-form-field subscriptSizing="dynamic">
              <mat-label>Set sprint</mat-label>
              <mat-select [disabled]="busy()" (valueChange)="bulk('sprint', $event)">
                <mat-option [value]="none">No sprint</mat-option>
                @for (s of openSprints(); track s.id) {
                  <mat-option [value]="s.id">{{ s.name }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            @if (ctx.project()?.ownerId === null) {
              <mat-form-field subscriptSizing="dynamic">
                <mat-label>Assign</mat-label>
                <mat-select [disabled]="busy()" (valueChange)="bulk('assignee', $event)">
                  <mat-option [value]="none">Unassigned</mat-option>
                  @for (m of ctx.members(); track m.userId) {
                    <mat-option [value]="m.userId">{{ m.displayName }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
            }
            <mat-form-field subscriptSizing="dynamic">
              <mat-label>Set status</mat-label>
              <mat-select [disabled]="busy()" (valueChange)="bulk('status', $event)">
                @for (s of statuses; track s) {
                  <mat-option [value]="s">{{ statusLabels[s] }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
          }
          <button mat-button type="button" [disabled]="busy()" (click)="outline(-1)">
            <app-icon name="outdent" />Outdent
          </button>
          <button mat-button type="button" [disabled]="busy()" (click)="outline(1)">
            <app-icon name="indent" />Indent
          </button>
          <button mat-button type="button" [disabled]="busy()" (click)="linkInOrder()">
            Link in order
          </button>
          <button mat-button type="button" [matMenuTriggerFor]="more" [disabled]="busy()">
            More…
          </button>
          <mat-menu #more="matMenu">
            @if (ctx.has(manageBoard)) {
              <button mat-menu-item type="button" (click)="sprintFromSelection()">
                New sprint from selection
              </button>
            }
            @if (ctx.project()?.ownerId === null) {
              <button mat-menu-item type="button" [matMenuTriggerFor]="addWho">Add assignee</button>
              <button mat-menu-item type="button" [matMenuTriggerFor]="sharePerson">Share…</button>
            }
            <button mat-menu-item type="button" [matMenuTriggerFor]="prio">Set priority</button>
            <button mat-menu-item type="button" [matMenuTriggerFor]="labelAdd">Add label</button>
            <button mat-menu-item type="button" [matMenuTriggerFor]="labelRemove">
              Remove label
            </button>
            <button mat-menu-item type="button" [matMenuTriggerFor]="bucketMenu">
              Move to bucket
            </button>
            <button mat-menu-item type="button" [matMenuTriggerFor]="typeMenuBulk">
              Change type
            </button>
            <button mat-menu-item type="button" [matMenuTriggerFor]="parentMenuBulk">
              Move under…
            </button>
            <button mat-menu-item type="button" (click)="unlink()">Unlink</button>
            <button mat-menu-item type="button" (click)="shiftDates()">Shift dates…</button>
            <button mat-menu-item type="button" (click)="deleteSelected()">Delete…</button>
          </mat-menu>
          <mat-menu #typeMenuBulk="matMenu">
            @for (t of types; track t) {
              <button mat-menu-item type="button" (click)="bulk('type', t)">
                <app-type-icon [type]="t" />{{ typeLabels[t] }}
              </button>
            }
          </mat-menu>
          <mat-menu #parentMenuBulk="matMenu">
            <button mat-menu-item type="button" (click)="bulk('parent', none)">
              Top level (no parent)
            </button>
            @for (p of parentChoices(); track p.id) {
              <button mat-menu-item type="button" (click)="bulk('parent', p.id)">
                <app-type-icon [type]="p.type" /><span class="k-key">{{ p.key }}</span>
                {{ p.title }}
              </button>
            }
          </mat-menu>
          <mat-menu #sharePerson="matMenu">
            @for (m of ctx.members(); track m.userId) {
              <button
                mat-menu-item
                type="button"
                [matMenuTriggerFor]="shareValue"
                [matMenuTriggerData]="{ userId: m.userId }"
              >
                {{ m.displayName }}
              </button>
            }
          </mat-menu>
          <mat-menu #shareValue="matMenu">
            <ng-template matMenuContent let-userId="userId">
              @for (s of bulkShares; track s) {
                <button mat-menu-item type="button" (click)="bulk('share', userId + ':' + s)">
                  {{ s }}%
                </button>
              }
            </ng-template>
          </mat-menu>
          <mat-menu #addWho="matMenu">
            @for (m of ctx.members(); track m.userId) {
              <button mat-menu-item type="button" (click)="bulk('assigneeAdd', m.userId)">
                {{ m.displayName }}
              </button>
            }
          </mat-menu>
          <mat-menu #prio="matMenu">
            @for (p of [1, 2, 3, 4]; track p) {
              <button mat-menu-item type="button" (click)="bulk('priority', '' + p)">
                Priority {{ p }}
              </button>
            }
          </mat-menu>
          <mat-menu #labelAdd="matMenu">
            @for (l of ctx.labels(); track l.id) {
              <button mat-menu-item type="button" (click)="bulk('labelAdd', l.id)">
                {{ l.name }}
              </button>
            }
          </mat-menu>
          <mat-menu #labelRemove="matMenu">
            @for (l of ctx.labels(); track l.id) {
              <button mat-menu-item type="button" (click)="bulk('labelRemove', l.id)">
                {{ l.name }}
              </button>
            }
          </mat-menu>
          <mat-menu #bucketMenu="matMenu">
            @for (b of ctx.buckets(); track b.id) {
              <button mat-menu-item type="button" (click)="bulk('bucket', b.id)">
                {{ b.name }}
              </button>
            }
          </mat-menu>
        }
        <button mat-button type="button" (click)="selected.set(emptySet)">Clear</button>
      </div>
    }
    @if (holidayReview(); as review) {
      <div class="k-alert warn notice" role="status">
        <span
          >Instance holidays changed since this plan was made ({{ review.holidays }}):
          {{ review.count }} {{ review.count === 1 ? 'item spans' : 'items span' }} them.</span
        >
        <button mat-flat-button type="button" (click)="reviewHolidays(true)">
          Keep their durations
        </button>
        <button mat-button type="button" (click)="reviewHolidays(false)">Keep dates</button>
      </div>
    }
    @if (report(); as r) {
      <div role="status" class="muted">
        {{ r.summary }}
        @if (r.problems.length > 0) {
          <ul>
            @for (p of r.problems; track p) {
              <li>{{ p }}</li>
            }
          </ul>
        }
      </div>
    }

    @if (!ctx.loaded()) {
      <app-skeleton label="Loading the timeline" />
    } @else if (phone()) {
      <div class="plan" role="status">
        @if (plan(); as p) {
          <b>{{ shortDay(p.start.date) }} – {{ shortDay(p.finish.dueDate) }}</b>
          <span>{{ fmt(p.duration) }} working days · {{ fmt(p.work) }} days of work</span>
        } @else {
          <span class="muted">No dates yet</span>
        }
      </div>
      <p class="muted">Bars are shown on wider screens. Open an item to edit it.</p>
      <div class="cards">
        @for (r of rows(); track r.node.id) {
          @if (r.node.item; as it) {
            <a
              class="card"
              [routerLink]="['items', it.number]"
              [style.margin-left.px]="r.depth * 12"
            >
              <span
                ><app-type-icon [type]="it.type" /> <span class="k-key">{{ it.key }}</span></span
              >
              <strong>{{ it.title }}</strong>
              <span class="muted"
                >{{ range(r.summary ? spanDates(r) : it) }} · {{ daysOf(r) }}</span
              >
            </a>
          }
        }
      </div>
    } @else if (rows().length === 0 && !canCreate()) {
      <app-empty-state title="Nothing to plan yet" />
    } @else {
      <div class="plan" role="status">
        <span><strong>Plan</strong></span>
        @if (plan(); as p) {
          <span>{{ shortDay(p.start.date) }} – {{ shortDay(p.finish.dueDate) }}</span>
          <span
            ><b>{{ fmt(p.duration) }}</b> <span class="muted">working days</span></span
          >
          <span
            ><b>{{ fmt(p.work) }}</b> <span class="muted">days of work</span></span
          >
        } @else {
          <span class="muted">No dates yet</span>
        }
        <span class="muted"
          >{{ itemCount() }} items{{ filtered() ? ' (filtered)' : '' }}
          @if (conflictMap().size > 0) {
            · {{ conflictMap().size }} {{ conflictMap().size === 1 ? 'conflict' : 'conflicts' }}
          }
        </span>
        @if (adHocCount() > 0) {
          <span class="muted" data-testid="ad-hoc-note"
            >{{ adHocCount() }} ad-hoc {{ adHocCount() === 1 ? 'item is' : 'items are' }} not in the
            plan (<a [routerLink]="['/p', ctx.project()?.key ?? 'personal']">show on board</a
            >)</span
          >
        }
      </div>
      <div class="scroller" #scroller (wheel)="gridWheel($event)">
        <div
          class="canvas"
          [style.width.px]="gridPane() + barsWidth()"
          [style.--tl-gx]="-gridShift() + 'px'"
        >
          <div class="row head">
            <div class="cells" role="presentation" [style.width.px]="gridPane()">
              <div class="cell" [style.width.px]="check">
                <span class="visually-hidden">Select</span>
              </div>
              @for (c of columns(); track c.id) {
                <div
                  class="cell"
                  [style.width.px]="c.width"
                  [class.num]="c.id === 'days' || c.id === 'work' || c.id === 'progress'"
                >
                  {{ c.label }}
                  <span
                    class="resize"
                    role="separator"
                    tabindex="0"
                    aria-orientation="vertical"
                    [attr.aria-label]="'Resize the ' + c.label + ' column'"
                    [attr.aria-valuenow]="c.width"
                    [attr.aria-valuetext]="c.width + ' pixels'"
                    [attr.aria-valuemin]="minWidth"
                    [attr.aria-valuemax]="maxWidth"
                    title="Drag, or use the arrow keys, to resize"
                    (pointerdown)="resizeStart($event, c)"
                    (keydown)="resizeKey($event, c)"
                    (dblclick)="setWidth(c.id, null)"
                  ></span>
                </div>
              }
              <div class="cell" [style.width.px]="check">
                <span class="visually-hidden">Actions</span>
              </div>
              <span
                class="split"
                role="separator"
                tabindex="0"
                aria-orientation="vertical"
                aria-label="Resize the plan table beside the bars"
                [attr.aria-valuenow]="gridPane()"
                [attr.aria-valuemin]="minPane()"
                [attr.aria-valuemax]="gridWidth()"
                title="Drag, or use the arrow keys, to share the width with the bars"
                (pointerdown)="splitStart($event)"
                (keydown)="splitKey($event)"
                (dblclick)="setPane(null)"
              ></span>
            </div>
            <div class="scale" [style.width.px]="barsWidth()" style="position: relative">
              @for (s of sprintBands(); track s.id) {
                @if (selected().size > 0 && ctx.writable()) {
                  <button
                    type="button"
                    class="band"
                    [style.left.px]="s.left"
                    [style.width.px]="s.width"
                    [attr.aria-label]="'Put the ' + selected().size + ' selected rows in ' + s.name"
                    (click)="bulk('sprint', s.id)"
                  >
                    {{ s.name }}
                  </button>
                } @else {
                  <div class="band" [style.left.px]="s.left" [style.width.px]="s.width">
                    {{ s.name }}
                  </div>
                }
              }
              @for (h of holidayBlocks(); track h.id) {
                <div
                  class="hol"
                  role="img"
                  [attr.aria-label]="'Holiday: ' + h.name"
                  [attr.title]="h.name"
                  [style.left.px]="h.left"
                  [style.width.px]="h.width"
                ></div>
              }
              @for (t of ticks().upper; track t.left) {
                <div class="tick up" [style.left.px]="t.left" [style.width.px]="t.width">
                  {{ t.label }}
                </div>
              }
              @for (t of ticks().lower; track t.left) {
                <div class="tick low" [style.left.px]="t.left" [style.width.px]="t.width">
                  {{ t.label }}
                </div>
              }
              <div
                class="today-mark"
                role="img"
                [attr.aria-label]="'Today, ' + shortDay(today())"
                [style.left.px]="todayX()"
              >
                <span aria-hidden="true">Today</span>
              </div>
            </div>
          </div>

          <div
            role="grid"
            tabindex="-1"
            aria-label="Plan"
            [class.dragging]="rowDrag.view() !== null"
            [attr.aria-rowcount]="rows().length"
            (keydown)="gridKey($event)"
            (paste)="pasteRows($event)"
          >
            @for (r of rows(); track r.node.id; let i = $index) {
              <div
                class="row"
                role="row"
                [id]="'row-' + r.node.id"
                [class.summary]="r.summary !== null"
                [class.selected]="selected().has(r.node.id)"
                [class.flash]="flash() === r.node.id"
                [class.dragged]="rowDrag.view()?.hidden?.has(i)"
                [style.translate]="rowShift(i)"
                [class.k-live-flash]="ctx.flashing().has(r.node.id)"
                [attr.title]="changedBy(r.node.id)"
                [attr.aria-selected]="r.node.item ? selected().has(r.node.id) : null"
              >
                <div class="cells" [style.width.px]="gridPane()">
                  <span
                    class="split"
                    aria-hidden="true"
                    (pointerdown)="splitStart($event)"
                    (dblclick)="setPane(null)"
                  ></span>
                  <div class="cell" role="gridcell" [style.width.px]="check">
                    @if (r.node.item) {
                      <mat-checkbox
                        [checked]="selected().has(r.node.id)"
                        (click)="selectClick($event, i)"
                        [aria-label]="'Select ' + r.node.ref.key"
                      />
                    }
                  </div>
                  @for (c of columns(); track c.id; let ci = $index) {
                    <div
                      class="cell"
                      role="gridcell"
                      [id]="'c-' + i + '-' + ci"
                      [style.width.px]="c.width"
                      [class.num]="c.id === 'days' || c.id === 'work' || c.id === 'progress'"
                      [class.title]="c.id === 'title'"
                      [class.focus]="focus().row === i && focus().col === ci"
                      [class.k-live-other]="otherEditor(r.node.id, c.id) !== null"
                      [attr.data-initials]="otherEditor(r.node.id, c.id)"
                      [attr.tabindex]="focus().row === i && focus().col === ci ? 0 : -1"
                      [attr.aria-readonly]="!editable(r, c) || null"
                      (click)="focusCell(i, ci, false)"
                      (keydown.f2)="startEdit(i, ci, null)"
                      (dblclick)="startEdit(i, ci, null)"
                    >
                      @if (editing(); as e) {
                        @if (e.row === i && e.col === ci) {
                          <input
                            #editor
                            [attr.aria-label]="c.label + ' of ' + r.node.ref.key"
                            [value]="e.value"
                            (input)="editValue($any($event.target).value)"
                            (keydown)="editKey($event)"
                            (blur)="commit(null)"
                          />
                        } @else {
                          <ng-container *ngTemplateOutlet="cell; context: { $implicit: r, c: c }" />
                        }
                      } @else {
                        <ng-container *ngTemplateOutlet="cell; context: { $implicit: r, c: c }" />
                      }
                    </div>
                  }
                  <div class="cell" role="gridcell" [style.width.px]="check">
                    @if (r.node.item; as it) {
                      <button
                        mat-icon-button
                        type="button"
                        [matMenuTriggerFor]="rowMenu"
                        [matMenuTriggerData]="{ $implicit: it, index: i }"
                        [attr.aria-label]="'Actions for ' + it.key"
                        tabindex="-1"
                      >
                        <app-icon name="more" />
                      </button>
                    }
                  </div>
                </div>
                <div
                  class="track"
                  role="gridcell"
                  [attr.aria-label]="'Bar of ' + r.node.ref.key"
                  [style.width.px]="barsWidth()"
                  [style]="weekendStyle()"
                >
                  @if (r.summary; as s) {
                    @if (spanBox(s); as b) {
                      <div
                        class="bracket"
                        [style.left.px]="b.left"
                        [style.width.px]="b.width"
                      ></div>
                      <div class="blabel" [style.left.px]="b.left + b.width + 6">
                        <strong>{{ fmt(s.duration) }} d</strong>
                      </div>
                    }
                    @if (r.node.item; as it) {
                      @if (box(it); as own) {
                        <div
                          class="own"
                          [style.left.px]="own.left"
                          [style.width.px]="own.width"
                        ></div>
                      }
                    }
                  } @else if (r.node.item; as it) {
                    @if (shownBox(it); as b) {
                      @if (b.marker) {
                        <div
                          class="marker"
                          [style.left.px]="b.left"
                          [style]="barVars(it)"
                          role="img"
                          [attr.aria-label]="barLabel(it)"
                        ></div>
                      } @else {
                        <div
                          class="bar"
                          tabindex="0"
                          role="button"
                          [attr.aria-label]="barLabel(it)"
                          [class.progress]="it.status === 'IN_PROGRESS'"
                          [class.blocked]="it.status === 'BLOCKED'"
                          [class.done]="it.status === 'DONE'"
                          [class.conflict]="conflictMap().has(it.id)"
                          [class.k-live-other]="otherMover(it.id) !== null"
                          [attr.data-initials]="otherMover(it.id)"
                          [style.left.px]="b.left"
                          [style.width.px]="b.width"
                          [style]="barVars(it)"
                          (pointerdown)="dragStart($event, it, 'move')"
                          (dblclick)="openItem(it)"
                          (keydown)="barKey($event, it)"
                          (blur)="barDraft.set(null)"
                        >
                          @if (canEditDates(it)) {
                            <span
                              class="edge l"
                              (pointerdown)="dragStart($event, it, 'start')"
                            ></span>
                            <span
                              class="edge r"
                              (pointerdown)="dragStart($event, it, 'end')"
                            ></span>
                          }
                        </div>
                      }
                      <div class="blabel" [style.left.px]="b.left + b.width + 8">
                        @if (ctx.presenceByItem().get(it.id); as people) {
                          <app-presence
                            [people]="people"
                            [members]="ctx.membersById()"
                            what="this bar"
                            [size]="16"
                          />
                        }
                        @if (it.startNoEarlierThan) {
                          <app-icon class="pin" name="pin" [size]="12" label="Pinned start" />
                        }
                        @if (conflictMap().has(it.id)) {
                          <span class="warn"
                            >{{ it.key }} starts before {{ predKeys(it) }} ends</span
                          >
                        } @else {
                          {{ it.key }}
                        }
                      </div>
                    }
                  }
                </div>
              </div>
              @if (canCreate() && inlineAt() === i) {
                <ng-container *ngTemplateOutlet="adderRow" />
              }
            }
          </div>

          @if (canCreate() && inlineAt() === null) {
            <ng-container *ngTemplateOutlet="adderRow" />
          }
          <ng-template #adderRow>
            <div class="row add" [class.inline]="inlineAt() !== null">
              <div class="cells" [style.width.px]="gridPane()">
                <div
                  class="cell"
                  [style.width.px]="gridPane()"
                  [style.padding-left.px]="8 + addDepth() * 16"
                  style="gap: 8px"
                >
                  <app-icon name="plus" />
                  <input
                    #adder
                    [attr.aria-label]="addLabel()"
                    [placeholder]="addLabel()"
                    [attr.maxlength]="titleMax"
                    (keydown.enter)="addRow($any($event.target))"
                    (keydown.escape)="leaveAdder()"
                    (paste)="pasteRows($event); $event.stopPropagation()"
                  />
                </div>
              </div>
            </div>
          </ng-template>
          @if (rowDrag.view(); as d) {
            <div
              class="drop-gap"
              [class.bad]="!d.valid"
              [style.top.px]="header + d.gap * rowHeight()"
              [style.height.px]="rowHeight()"
              [style.width.px]="gridPane() + barsWidth()"
            >
              <span
                class="drop-slot"
                [style.left.px]="d.left + check + 8 + d.depth * 16"
                [style.width.px]="gridPane() - check - 12 - d.depth * 16"
              ></span>
              @if (d.label) {
                <span
                  class="drop-label"
                  data-testid="drop-label"
                  [style.left.px]="d.left + gridPane() + 8"
                  >{{ d.label }}</span
                >
              }
            </div>
            <div
              class="drag-card"
              aria-hidden="true"
              [style.left.px]="d.x"
              [style.top.px]="d.y"
              [style.width.px]="d.width"
              [style.height.px]="rowHeight()"
            >
              <app-type-icon [type]="d.card.type" />
              <span class="k-key">{{ d.card.key }}</span>
              <span class="t">{{ d.card.title }}</span>
              @if (d.card.more) {
                <span class="more">{{ d.card.more }}</span>
              }
            </div>
          }

          <div class="layer" [style.left.px]="gridPane()" [style.width.px]="barsWidth()">
            @for (h of holidayBlocks(); track h.id) {
              <div class="holiday" [style.left.px]="h.left" [style.width.px]="h.width"></div>
            }
            <div class="today" [style.left.px]="todayX()"></div>
            <svg
              class="links"
              [class.faded]="rowDrag.view() !== null"
              [attr.width]="barsWidth()"
              [attr.height]="(rows().length + (inlineAt() === null ? 0 : 1)) * rowHeight()"
              aria-hidden="true"
            >
              @for (l of links(); track l.key) {
                <path [attr.d]="l.d" [class.bad]="l.bad" />
              }
            </svg>
          </div>
          @if (gridPane() < gridWidth()) {
            <div
              #gridScroll
              class="gscroll"
              aria-hidden="true"
              [style.width.px]="gridPane()"
              (scroll)="gridX.set($any($event.target).scrollLeft)"
            >
              <div [style.width.px]="gridWidth()"></div>
            </div>
          }
        </div>
      </div>
    }

    <ng-template #cell let-r let-c="c">
      @switch (c.id) {
        @case ('key') {
          @if (r.node.item; as it) {
            @if (ctx.canPlan(it)) {
              <span
                class="grip"
                aria-hidden="true"
                title="Drag to move the row; Alt+Shift+Up or Down moves it with the keyboard"
                (pointerdown)="rowDrag.start($event, rows().indexOf(r))"
                ><app-icon name="grip" [size]="12"
              /></span>
            }
            <a class="key k-key" [routerLink]="['items', it.number]" tabindex="-1">{{ it.key }}</a>
          } @else {
            <span class="k-key title-only">{{ r.node.ref.key }}</span>
          }
        }
        @case ('title') {
          <span class="tree" [style.padding-left.px]="r.depth * 16">
            @if (r.node.children.length > 0) {
              <button
                type="button"
                class="toggle"
                [class.open]="!collapsed().has(r.node.id)"
                [attr.aria-expanded]="!collapsed().has(r.node.id)"
                [attr.aria-label]="
                  (collapsed().has(r.node.id) ? 'Expand ' : 'Collapse ') + r.node.ref.key
                "
                tabindex="-1"
                (click)="toggle(r.node.id); $event.stopPropagation()"
              >
                <app-icon name="chevronRight" [size]="12" />
              </button>
            } @else {
              <!-- Same width as the toggle, so sibling icons line up and children sit one step in. -->
              <span class="toggle slot" aria-hidden="true"></span>
            }
            <app-type-icon [type]="r.node.ref.type" />
            <span
              class="text"
              [attr.title]="r.node.ref.title"
              [class.title-only]="!r.node.item"
              [class.sum]="r.summary"
              >{{ r.node.ref.title }}</span
            >
          </span>
        }
        @case ('start') {
          @if (r.summary; as s) {
            <span class="sum"
              >{{ shortDay(s.start.date) }}{{ s.start.second ? ', 2nd half' : '' }}</span
            >
          } @else if (r.node.item; as it) {
            @if (it.startNoEarlierThan) {
              <app-icon
                class="pin"
                name="pin"
                [size]="12"
                [label]="'Pinned: starts no earlier than ' + shortDay(it.startNoEarlierThan.date)"
              />
            }
            <span class="text">{{ startText(it) }}</span>
          }
        }
        @case ('days') {
          <span [class.sum]="r.summary">{{ daysOf(r) }}</span>
        }
        @case ('due') {
          @if (r.summary; as s) {
            <span class="sum"
              >{{ shortDay(s.finish.dueDate) }}{{ s.finish.dueFirstHalf ? ', 1st half' : '' }}</span
            >
          } @else if (r.node.item; as it) {
            <span class="text">{{ dueText(it) }}</span>
          }
        }
        @case ('pred') {
          @if (r.node.item; as it) {
            <span class="text">{{ predNumbers(it) }}</span>
            @if (conflictMap().has(it.id)) {
              <app-icon
                class="warn"
                name="alert"
                [size]="13"
                [label]="'Starts before ' + predKeys(it) + ' ends'"
              />
            }
          }
        }
        @case ('who') {
          @if (r.node.item; as it) {
            @if (whoStack(it, c.width); as w) {
              <span class="k-avatars" role="img" [attr.aria-label]="w.label" [title]="w.label">
                @for (a of w.shown; track a.userId) {
                  <app-avatar-static
                    [userId]="a.userId"
                    [name]="memberName(a.userId)"
                    [size]="22"
                  />
                }
                @if (w.more > 0) {
                  <span class="k-avatar who-more">{{ w.shown.length ? '+' : '' }}{{ w.more }}</span>
                }
              </span>
            }
          }
        }
        @case ('status') {
          @if (r.node.item; as it) {
            <app-status-pill [status]="it.status" />
          }
        }
        @case ('type') {
          {{ typeLabel(r) }}
        }
        @case ('bucket') {
          {{
            r.node.item?.bucketId ? (ctx.bucketsById().get(r.node.item.bucketId)?.name ?? '') : ''
          }}
        }
        @case ('sprint') {
          @if (r.node.item; as it) {
            @if (ownSprint(it)) {
              {{ it.sprintId ? (ctx.sprintsById().get(it.sprintId)?.name ?? '') : '' }}
              @if (storySprintDiffers(it)) {
                <span
                  class="k-pill warn"
                  title="Not in its story's sprint"
                  aria-label="Not in its story's sprint"
                  >≠</span
                >
              }
            } @else {
              <span class="muted" title="From its stories">{{ childSprints(r) }}</span>
            }
          }
        }
        @case ('priority') {
          {{ r.node.item?.priority ?? '' }}
        }
        @case ('work') {
          {{ r.summary ? fmt(r.summary.work) : r.node.item ? daysOf(r) : '' }}
        }
        @case ('progress') {
          {{ progress(r) }}
        }
      }
    </ng-template>

    <mat-menu #rowMenu="matMenu">
      <ng-template matMenuContent let-it let-index="index">
        <a mat-menu-item [routerLink]="['items', it.number]">Open details</a>
        @if (it.bucketId) {
          <a
            mat-menu-item
            [routerLink]="['/p', projectKey(), 'items', it.number]"
            [queryParams]="{ focus: it.number }"
            >Show on board</a
          >
        }
        @if (canCreate()) {
          <button mat-menu-item type="button" (click)="focusAdd(it)">Add row below</button>
          @if (canHaveChildren(it)) {
            <button mat-menu-item type="button" (click)="focusAddChild(it)">Add child row</button>
          }
        }
        @if (ctx.canEdit(it)) {
          @if (ctx.canPlan(it)) {
            <button mat-menu-item type="button" (click)="outlineOne(index, 1)">Indent</button>
            <button mat-menu-item type="button" (click)="outlineOne(index, -1)">Outdent</button>
            <button mat-menu-item type="button" (click)="reschedule([{ item: it.id }])">
              Reschedule from predecessors
            </button>
          }
          @if (it.startNoEarlierThan && ctx.canPlan(it)) {
            <button
              mat-menu-item
              type="button"
              (click)="reschedule([{ item: it.id, pin: 'remove' }])"
            >
              Remove pin
            </button>
          }
          <button
            mat-menu-item
            type="button"
            [matMenuTriggerFor]="statusMenu"
            [matMenuTriggerData]="{ $implicit: it }"
          >
            Status
          </button>
        }
      </ng-template>
    </mat-menu>
    <mat-menu #statusMenu="matMenu">
      <ng-template matMenuContent let-it>
        @for (s of statuses; track s) {
          <button mat-menu-item type="button" (click)="setStatus(it, s)">
            {{ statusLabels[s] }}
          </button>
        }
      </ng-template>
    </mat-menu>
    <mat-menu #whoMenu="matMenu" class="who-menu">
      <ng-template matMenuContent let-it>
        @for (m of ctx.members(); track m.userId) {
          <div class="who-row">
            <button
              mat-menu-item
              type="button"
              role="menuitemcheckbox"
              [attr.aria-checked]="it.assigneeIds.includes(m.userId)"
              (click)="toggleAssignee(it, m.userId)"
              (keydown)="whoKey($event, it, m.userId)"
            >
              <app-icon [name]="it.assigneeIds.includes(m.userId) ? 'check' : 'plus'" />{{
                m.displayName
              }}
            </button>
            @if (it.can.plan && shareOf(it, m.userId); as share) {
              <app-share-buttons
                [name]="m.displayName"
                [share]="share"
                (shareChange)="setShare(it, { userId: m.userId, share: $event })"
              />
            }
          </div>
        }
      </ng-template>
    </mat-menu>
    <mat-menu #typeMenu="matMenu">
      <ng-template matMenuContent let-it>
        @for (t of typesFor(it); track t) {
          <button mat-menu-item type="button" (click)="setType(it, t)">{{ typeLabels[t] }}</button>
        }
      </ng-template>
    </mat-menu>
    <mat-menu #sprintMenu="matMenu">
      <ng-template matMenuContent let-it>
        <button mat-menu-item type="button" (click)="setSprint(it, null)">No sprint</button>
        @for (s of openSprints(); track s.id) {
          <button mat-menu-item type="button" (click)="setSprint(it, s.id)">{{ s.name }}</button>
        }
      </ng-template>
    </mat-menu>
    <span
      #menuAnchor
      style="position: fixed; width: 0; height: 0"
      [matMenuTriggerFor]="activeMenu()"
      [matMenuTriggerData]="{ $implicit: menuItem() }"
      [style.left.px]="menuAt().x"
      [style.top.px]="menuAt().y"
    ></span>

    <router-outlet />
  `,
})
export class TimelinePage implements OnInit {
  /** Shared project state. */
  protected readonly ctx = inject(ProjectContext);
  private readonly api = inject(ItemsApiService);
  private readonly trashApi = inject(TrashApiService);
  private readonly flow = inject(RescheduleFlow);
  private readonly toast = inject(ToastService);
  private readonly dialogs = inject(Dialogs);
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly injector = inject(Injector);
  private readonly dialog = inject(MatDialog);
  private readonly holidaysApi = inject(HolidaysApiService);
  /** Holds the item of the cell being edited (M10). */
  private editHold: ItemHold | null = null;
  /** Holds the item of the bar being dragged (M10). */
  private barHold: ItemHold | null = null;
  /** Ends holds when the page closes, so the item does not stay busy (M10). */
  private readonly holdsEnd = inject(DestroyRef).onDestroy(() => {
    void this.editHold?.release();
    void this.barHold?.release();
    this.rowDrag.cancel();
  });
  /** Reloads the links and holidays when someone else changed them (M10). */
  private readonly linksWatch = effect(() => {
    if (this.ctx.linksVersion() === 0) return;
    untracked(() => void this.loadEdges().catch(() => undefined));
  });
  /**
   * Shows this view's Export… in the project header (the workbook has a
   * Timeline sheet), with the Microsoft Project file too (v1.3.2).
   */
  private readonly pageActions = inject(PageActions).register(() => ({
    source: this.ctx.project()?.id ?? '',
    filters: { today: this.today(), boardOnly: false, ...(this.text() ? { q: this.text() } : {}) },
    msProject: true,
    tools: true,
    activeFilters: [
      this.text() !== '',
      this.typeFilter() !== '',
      this.assigneeFilter() !== '',
      !this.showDone(),
    ].filter(Boolean).length,
  }));

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private readonly adder = viewChild<ElementRef<HTMLInputElement>>('adder');
  private readonly gridScroll = viewChild<ElementRef<HTMLElement>>('gridScroll');
  private readonly outlineApi = inject(OutlineApiService);
  private readonly editor = viewChild<ElementRef<HTMLInputElement>>('editor');
  private readonly menuAnchor = viewChild('menuAnchor', { read: MatMenuTrigger });

  /** Selection column width, for the template. */
  protected readonly check = CHECK;
  protected readonly none = NONE;
  protected readonly emptySet: ReadonlySet<string> = new Set<string>();
  protected readonly types = Object.values(ItemType);
  protected readonly typeLabels = TYPE_LABELS;
  protected readonly statuses = Object.values(ItemStatus);
  /** Shares offered by the selection's "Share…" (M13). */
  protected readonly bulkShares = [100, 75, 50, 25, 10];
  /** An item's assignees with shares, for the Who cell. */
  protected readonly sharesOf = sharesOf;
  /** A person's share on an item, or null. */
  protected readonly shareOf = shareOf;
  protected readonly statusLabels = STATUS_LABELS;
  protected readonly optional = OPTIONAL;
  protected readonly manageBoard = ProjectPermission.MANAGE_BOARD;
  protected readonly titleMax = ITEM_TITLE_MAX;
  protected readonly zooms: { id: TimelineZoom; label: string }[] = [
    { id: 'week', label: 'Week' },
    { id: 'month', label: 'Month' },
    { id: 'quarter', label: 'Quarter' },
  ];
  /** Today, `YYYY-MM-DD`; kept current on an open tab (v1.4.0). */
  protected readonly today = inject(Today).date;
  /** Today as a day number. */
  protected readonly todayDay = computed(() => dayNumber(this.today()));

  /** Phone width shows cards instead of the grid and bars. */
  protected readonly phone = toSignal(
    inject(BreakpointObserver)
      .observe('(max-width: 599px)')
      .pipe(map((s) => s.matches)),
    { initialValue: false },
  );

  /** Visible links. */
  private readonly edges = signal<PlanEdge[]>([]);
  /** The project's holidays and instance changes since the last review (M9.1). */
  protected readonly holidayInfo = signal<ProjectHolidaysDto>({
    holidays: [],
    useInstanceHolidays: true,
    instanceChanges: [],
  });
  /** The working-day calendar: weekends and the project's holidays are off. */
  protected readonly calendar = computed(() => workCalendar(this.holidayInfo().holidays));
  /** Holiday shading on the bars, one block per holiday. */
  protected readonly holidayBlocks = computed(() =>
    this.holidayInfo().holidays.map((h) => ({
      id: h.id,
      name: h.name,
      left: halfX(this.scale(), h.startDate, false),
      width: (dayNumber(h.endDate) - dayNumber(h.startDate) + 1) * this.scale().dayWidth,
    })),
  );
  /** PMs and Leads may change holidays and review instance changes. */
  protected readonly canManageHolidays = computed(
    () => this.ctx.writable() && this.ctx.has(ProjectPermission.MANAGE_BOARD),
  );
  /** Items an instance holiday change touches, for the review notice. */
  protected readonly holidayReview = computed(() => {
    const info = this.holidayInfo();
    if (info.instanceChanges.length === 0 || !this.canManageHolidays()) return null;
    const changes = this.durationChanges(info.instanceChanges, this.previousCalendar());
    return { count: changes.length, holidays: info.instanceChanges.length };
  });
  protected readonly zoom = signal<TimelineZoom>('week');
  protected readonly collapsed = signal<ReadonlySet<string>>(new Set());
  protected readonly text = signal('');
  protected readonly typeFilter = signal('');
  protected readonly assigneeFilter = signal('');
  protected readonly showDone = signal(true);
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  private anchor: number | null = null;
  protected readonly focus = signal({ row: 0, col: 1 });
  protected readonly editing = signal<{ row: number; col: number; value: string } | null>(null);
  protected readonly flash = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly bulkRuns = signal(0);
  protected readonly report = signal<{ summary: string; problems: string[] } | null>(null);
  /** The parent new rows go under, set by "Add row below"; null for the focused row's level. */
  protected readonly addParent = signal<WorkItemDto | null>(null);
  /** Height of the plan's sticky header row, where the rows start. */
  protected readonly header = HEADER_PX;
  /** Dragging rows by their grip (v1.3.2): card, sliding rows and gap. */
  protected readonly rowDrag = new RowDrag({
    rows: () => this.rows(),
    rowHeight: () => this.rowHeight(),
    draggedFrom: (index) => this.draggedFrom(index),
    childTypes: (id) =>
      this.ctx
        .items()
        .filter((i) => i.parentId === id)
        .map((i) => i.type),
    label: (target) => this.dropLabel(target),
    scroller: () => this.scroller()?.nativeElement,
    begin: (dragged) => {
      this.addParent.set(null);
      this.addChildId.set(null);
      // Others see the rows being moved; their changes wait for the drop.
      const holds = dragged.map((d) => this.ctx.hold(d.item.id, PresenceAction.MOVING));
      return (apply) => holds.forEach((hold) => void hold.release(apply));
    },
    drop: (target, release) => this.placeRows(target.moves ?? [], true, release),
  });
  /** Saves of placed rows, one after another so quick key presses keep their order. */
  private placing: Promise<void> = Promise.resolve();
  /** Placements queued or saving; the project reloads once they are all done. */
  private placements = 0;
  /** Id of the item new rows go under as its children, set by "Add child row" (v1.3.1). */
  protected readonly addChildId = signal<string | null>(null);
  /**
   * The item new rows go under, read fresh from the store so a later type
   * change or removal is seen; null once it can no longer take children.
   */
  protected readonly addChildOf = computed(() => {
    const id = this.addChildId();
    const item = id === null ? undefined : this.ctx.itemsById().get(id);
    return item !== undefined && this.canHaveChildren(item) ? item : null;
  });
  protected readonly barDraft = signal<BarDraft | null>(null);
  protected readonly activeMenu = signal<MatMenu | null>(null);
  protected readonly menuItem = signal<WorkItemDto | null>(null);
  protected readonly menuAt = signal({ x: 0, y: 0 });
  /** Shown optional columns (remembered per browser). */
  protected readonly shown = signal<ReadonlySet<ColumnId>>(new Set(loadColumns()));
  /** Column widths the viewer dragged (remembered per browser). */
  protected readonly widths = signal<Partial<Record<ColumnId, number>>>(loadWidths());
  /** Row height: compact, or titles wrapping to two or three lines. */
  protected readonly density = signal<Density>(loadDensity());
  /**
   * Width of the plan table beside the bars set with the splitter
   * (remembered per browser), or null to fit every column.
   */
  protected readonly paneWidth = signal<number | null>(loadPane());
  /** Sideways scroll of the plan table inside a narrowed pane, in px. */
  protected readonly gridX = signal(0);
  /** Row height in px; grid rows, bar tracks and links share it. */
  protected readonly rowHeight = computed(() => ROW_HEIGHT[this.density()]);
  /** Lines a wrapped title may take. */
  protected readonly lines = computed(() => ROW_LINES[this.density()]);
  /** Narrowest column, for the resize handles. */
  protected readonly minWidth = MIN_WIDTH;
  /** Widest column, for the resize handles. */
  protected readonly maxWidth = MAX_WIDTH;

  protected readonly columns = computed(() =>
    this.visibleColumns().map((c) => ({ ...c, width: this.widths()[c.id] ?? c.width })),
  );
  /** The columns shown, at their default widths. */
  private readonly visibleColumns = computed(() =>
    COLUMNS.filter(
      (c) =>
        (DEFAULT_COLUMNS.includes(c.id) && c.id !== 'who' && c.id !== 'status') ||
        this.shown().has(c.id),
    ),
  );
  protected readonly gridWidth = computed(
    () => CHECK * 2 + this.columns().reduce((w, c) => w + c.width, 0),
  );
  /** Narrowest the plan table can be made. */
  protected readonly minPane = computed(() => Math.min(MIN_PANE, this.gridWidth()));
  /** Width the plan table takes: its columns, or less when the splitter narrows it. */
  protected readonly gridPane = computed(() => {
    const pane = this.paneWidth();
    return pane === null
      ? this.gridWidth()
      : Math.max(this.minPane(), Math.min(this.gridWidth(), pane));
  });
  /** How far the table's cells are shifted left, never past its last column. */
  protected readonly gridShift = computed(() =>
    Math.max(0, Math.min(this.gridX(), this.gridWidth() - this.gridPane())),
  );
  protected readonly filtered = computed(
    () =>
      this.text() !== '' ||
      this.typeFilter() !== '' ||
      this.assigneeFilter() !== '' ||
      !this.showDone(),
  );
  private readonly tree = computed(() => {
    const roots = buildTree(this.planned());
    if (!this.filtered()) return roots;
    const text = this.text().trim().toLowerCase();
    return pruneTree(
      roots,
      (i) =>
        (text === '' || i.title.toLowerCase().includes(text) || i.key.toLowerCase() === text) &&
        (this.typeFilter() === '' || i.type === this.typeFilter()) &&
        (this.assigneeFilter() === '' || i.assigneeIds.includes(this.assigneeFilter())) &&
        (this.showDone() || i.status !== ItemStatus.DONE),
    );
  });
  protected readonly rows = computed(() =>
    timelineRows(this.tree(), this.collapsed(), this.calendar()),
  );
  /** Selected rows the filters hide; bulk actions include them, as on the backlog. */
  protected readonly hiddenSelected = computed(() => {
    const shown = new Set(this.rows().map((r) => r.node.id));
    return [...this.selected()].filter((id) => !shown.has(id)).length;
  });
  protected readonly itemCount = computed(() => this.rows().filter((r) => r.node.item).length);
  protected readonly plan = computed(() =>
    planSpan(
      this.filtered()
        ? this.rows().flatMap((r) => (r.node.item ? [r.node.item] : []))
        : this.planned(),
      this.calendar(),
    ),
  );
  protected readonly parentIds = computed(
    () =>
      new Set(
        this.rows()
          .filter((r) => r.node.children.length > 0)
          .map((r) => r.node.id),
      ),
  );
  protected readonly scale = computed(() =>
    timelineScale(this.planned(), this.today(), this.zoom()),
  );
  protected readonly barsWidth = computed(() => this.scale().days * this.scale().dayWidth);
  protected readonly ticks = computed(() => scaleTicks(this.scale(), this.zoom()));
  protected readonly todayX = computed(
    () => (this.todayDay() - this.scale().origin + 0.5) * this.scale().dayWidth,
  );
  protected readonly conflictMap = computed(() =>
    conflicts(this.planned(), this.edges(), this.calendar()),
  );
  /** Items on the timeline: everything but ad-hoc items, which are not in the plan (M12). */
  protected readonly planned = computed(() => this.ctx.items().filter((i) => !i.adHoc));
  /** Ad-hoc items left out, for the quiet note. */
  protected readonly adHocCount = computed(() => this.ctx.items().length - this.planned().length);
  /** Visible items by id. */
  private readonly byId = computed(() => new Map(this.ctx.items().map((i) => [i.id, i])));
  protected readonly openSprints = computed(() =>
    this.ctx.sprints().filter((s) => s.state !== 'CLOSED'),
  );
  protected readonly auto = computed(
    () => this.ctx.project()?.settings.autoMoveDependents ?? false,
  );
  protected readonly canCreate = computed(
    () => this.ctx.writable() && this.ctx.has(ProjectPermission.CREATE_ITEMS),
  );
  protected readonly projectKey = computed(() => this.ctx.project()?.key ?? '');
  protected readonly sprintBands = computed(() =>
    this.ctx.sprints().map((s) => ({
      id: s.id,
      name: s.name,
      left: halfX(this.scale(), s.startDate, false),
      width: (dayNumber(s.endDate) - dayNumber(s.startDate) + 1) * this.scale().dayWidth,
    })),
  );
  /** Weekends shaded at week and month zoom. */
  protected readonly weekendStyle = computed(() => {
    if (this.zoom() === 'quarter') return '';
    const w = this.scale().dayWidth;
    return `background-image: linear-gradient(to right, transparent ${5 * w}px, var(--k-sunken) ${5 * w}px); background-size: ${7 * w}px 100%;`;
  });
  /** Dependency arrows between the rows shown. */
  protected readonly links = computed(() => {
    const index = new Map(this.rows().map((r, i) => [r.node.id, i]));
    const byId = this.ctx.itemsById();
    const out: { key: string; d: string; bad: boolean }[] = [];
    for (const e of this.edges()) {
      const a = index.get(e.blockingItemId);
      const b = index.get(e.blockedItemId);
      const pred = byId.get(e.blockingItemId);
      const succ = byId.get(e.blockedItemId);
      if (a === undefined || b === undefined || pred === undefined || succ === undefined) continue;
      const pb = this.shownBox(pred);
      const sb = this.shownBox(succ);
      if (pb === null || sb === null) continue;
      const x1 = pb.left + pb.width;
      const y1 = this.rowY(a);
      const x2 = sb.left;
      const y2 = this.rowY(b);
      const d =
        x2 >= x1 + 10
          ? `M${x1} ${y1}H${x1 + 6}V${y2}H${x2}`
          : `M${x1} ${y1}H${x1 + 6}V${y2 - (y2 > y1 ? 10 : -10)}H${x2 - 6}V${y2}H${x2}`;
      out.push({
        key: `${e.blockingItemId}>${e.blockedItemId}`,
        d,
        bad: this.conflictMap().get(succ.id)?.includes(pred.id) ?? false,
      });
    }
    return out;
  });
  /** Text of the add-row field. */
  protected readonly addLabel = computed(() => {
    const parent = this.newRowParent();
    return parent === null
      ? 'Type a title · Enter adds the row · paste many lines at once'
      : `New row under ${parent.key} · Enter adds it · paste many lines at once`;
  });

  private drag: {
    id: string;
    mode: 'move' | 'start' | 'end';
    x: number;
    pointer: number;
  } | null = null;

  /**
   * Loads fresh data and the links, then shows the item named in `?item=`.
   */
  ngOnInit(): void {
    void (async () => {
      try {
        await this.ctx.refresh();
        await this.loadEdges();
        const wanted = Number(this.route.snapshot.queryParamMap.get('item'));
        if (Number.isInteger(wanted) && wanted > 0) this.reveal(wanted);
        else this.scrollToDay(openingDay(this.plan(), this.today()));
      } catch (error) {
        this.toast.error(error);
      }
    })();
  }

  /**
   * Reloads the visible links.
   *
   * @returns Resolves once loaded.
   */
  private async loadEdges(): Promise<void> {
    const project = this.ctx.project();
    if (project === null) return;
    const [timeline, holidays] = await Promise.all([
      this.api.timeline(project.id),
      this.holidaysApi.forProject(project.id),
    ]);
    this.edges.set(timeline.edges);
    this.holidayInfo.set(holidays);
  }

  /**
   * The calendar before the unreviewed instance changes: added holidays
   * removed again and removed ones put back.
   *
   * @returns The calendar items were planned with.
   */
  private previousCalendar(): WorkCalendar {
    const info = this.holidayInfo();
    const added = new Set(
      info.instanceChanges.filter((h) => h.deletedAt === null).map((h) => h.id),
    );
    const removed = info.instanceChanges.filter((h) => h.deletedAt !== null);
    return workCalendar([...info.holidays.filter((h) => !added.has(h.id)), ...removed]);
  }

  /**
   * The changes that keep working days for items touched by changed holidays.
   *
   * @param ranges Changed holidays.
   * @param before The calendar the items were planned with.
   * @returns Reschedule changes.
   */
  private durationChanges(
    ranges: readonly { startDate: string; endDate: string }[],
    before: WorkCalendar,
  ): RescheduleChangeRequest[] {
    return keepDurations(this.planned(), ranges, before, this.calendar());
  }

  /**
   * Answers the instance holiday notice: keep the affected items' durations
   * (moving finishes and dependent items) or keep their dates. Either way the
   * review is recorded.
   *
   * @param keep Keep durations (true) or dates (false).
   * @returns Resolves once done.
   */
  protected async reviewHolidays(keep: boolean): Promise<void> {
    const project = this.ctx.project();
    if (project === null) return;
    const info = this.holidayInfo();
    if (keep) {
      const changes = this.durationChanges(info.instanceChanges, this.previousCalendar());
      if (changes.length > 0 && (await this.flow.change(changes)) === null) return;
    }
    // Only the changes shown count as reviewed; newer ones show next time.
    const through = info.instanceChanges
      .map((h) => h.deletedAt ?? h.createdAt)
      .reduce((a, b) => (a > b ? a : b));
    try {
      await this.holidaysApi.markReviewed(project.id, through);
      this.holidayInfo.set({ ...info, instanceChanges: [] });
    } catch (error) {
      this.toast.error(error);
    }
  }

  /**
   * Opens the Holidays dialog; after a project holiday changed, affected
   * items keep their working days through the reschedule flow.
   *
   * @returns Resolves once closed and applied.
   */
  protected async openHolidays(): Promise<void> {
    const project = this.ctx.project();
    if (project === null) return;
    const { HolidaysDialog } = await import('./holidays-dialog');
    const before = this.calendar();
    const beforeInstance = this.holidayInfo().holidays.filter((h) => h.scope === 'INSTANCE');
    const ref = this.dialog.open<
      InstanceType<typeof HolidaysDialog>,
      HolidaysDialogData,
      HolidaysDialogResult
    >(HolidaysDialog, {
      data: {
        projectId: project.id,
        info: this.holidayInfo(),
        canManage: this.canManageHolidays(),
        canSwitch: this.ctx.writable() && this.ctx.has(ProjectPermission.MANAGE_PROJECT),
        today: this.today(),
      },
      // Wide enough for a holiday's name, both days and the button on one line.
      width: 'var(--k-size-880px)',
      maxWidth: 'calc(100vw - var(--k-space-8))',
      enterAnimationDuration: dialogMotion(),
      exitAnimationDuration: dialogMotion(),
    });
    const result = await firstValueFrom(ref.afterClosed());
    if (result === undefined) return;
    if (result.useInstanceHolidays !== undefined) await this.ctx.refresh();
    const after = await this.holidaysApi.forProject(project.id);
    this.holidayInfo.set(after);
    // Switching the instance holidays changes their days too.
    const changed =
      result.useInstanceHolidays === undefined
        ? result.changed
        : [
            ...result.changed,
            ...beforeInstance,
            ...after.holidays.filter((h) => h.scope === 'INSTANCE'),
          ];
    if (changed.length === 0) return;
    const changes = this.durationChanges(changed, before);
    if (changes.length > 0) await this.flow.change(changes);
  }

  // --- Display helpers -------------------------------------------------

  /**
   * A short date.
   *
   * @param date `YYYY-MM-DD`.
   * @returns E.g. "5 Nov".
   */
  protected shortDay(date: string): string {
    return shortDay(date, this.today());
  }

  /**
   * An item's start text.
   *
   * @param dates Dates.
   * @returns E.g. "5 Nov, 2nd half".
   */
  protected startText(dates: ScheduleDates): string {
    return startText(dates, this.today());
  }

  /**
   * An item's due text.
   *
   * @param dates Dates.
   * @returns E.g. "11 Nov, 1st half".
   */
  protected dueText(dates: ScheduleDates): string {
    return dueText(dates, this.today());
  }

  /**
   * A duration or work figure.
   *
   * @param days Working days.
   * @returns E.g. "2.5".
   */
  protected fmt(days: number): string {
    return durationText(days);
  }

  /**
   * A date range.
   *
   * @param dates Dates.
   * @returns E.g. "5 Nov – 11 Nov, 1st half".
   */
  protected range(dates: ScheduleDates): string {
    return [this.startText(dates), this.dueText(dates)].filter((t) => t !== '').join(' – ');
  }

  /**
   * The dates of a summary row's span.
   *
   * @param row The row.
   * @returns Dates.
   */
  protected spanDates(row: TimelineRow): ScheduleDates {
    const s = row.summary!;
    return {
      startDate: s.start.date,
      startSecondHalf: s.start.second,
      dueDate: s.finish.dueDate,
      dueFirstHalf: s.finish.dueFirstHalf,
    };
  }

  /**
   * The Days cell: a summary's span, or the item's own duration.
   *
   * @param row The row.
   * @returns The text.
   */
  protected daysOf(row: TimelineRow): string {
    if (row.summary !== null) return durationText(row.summary.duration);
    const item = row.node.item;
    if (item === null || item.startDate === null || item.dueDate === null) return '';
    return durationText(workingDuration(item, this.calendar()));
  }

  /**
   * The % complete cell: Done items 100, otherwise the checklist share; parents
   * weight their items by working days.
   *
   * @param row The row.
   * @returns E.g. "60%", or empty for a title-only row.
   */
  protected progress(row: TimelineRow): string {
    const percent = percentComplete(row.node, this.calendar());
    return percent === null ? '' : `${percent}%`;
  }

  /**
   * A row's type name.
   *
   * @param row The row.
   * @returns E.g. "User Story".
   */
  protected typeLabel(row: TimelineRow): string {
    return TYPE_LABELS[row.node.ref.type];
  }

  /**
   * A member's name.
   *
   * @param id User id.
   * @returns The display name.
   */
  protected memberName(id: string): string {
    return this.ctx.membersById().get(id)?.displayName ?? 'Unknown';
  }

  /**
   * The item numbers of an item's visible predecessors.
   *
   * @param item The item.
   * @returns E.g. "12, 15".
   */
  protected predNumbers(item: WorkItemDto): string {
    const byId = this.ctx.itemsById();
    return this.edges()
      .filter((e) => e.blockedItemId === item.id)
      .map((e) => byId.get(e.blockingItemId)?.number)
      .filter((n) => n !== undefined)
      .sort((a, b) => a - b)
      .join(', ');
  }

  /**
   * The keys of the predecessors an item starts before.
   *
   * @param item The item.
   * @returns E.g. "WEB-11".
   */
  protected predKeys(item: WorkItemDto): string {
    const byId = this.ctx.itemsById();
    return (this.conflictMap().get(item.id) ?? []).map((id) => byId.get(id)?.key ?? '').join(', ');
  }

  /**
   * A bar's box from the item's stored dates.
   *
   * @param dates Dates.
   * @returns The box, or null.
   */
  protected box(dates: ScheduleDates): BarBox | null {
    return barBox(this.scale(), dates);
  }

  /**
   * A bar's box, including an unsaved drag or keyboard change.
   *
   * @param item The item.
   * @returns The box, or null.
   */
  protected shownBox(item: WorkItemDto): BarBox | null {
    const draft = this.barDraft();
    return barBox(this.scale(), draft?.id === item.id ? this.drafted(item, draft) : item);
  }

  /**
   * A summary span's box.
   *
   * @param span The span.
   * @param span.start First half day.
   * @param span.finish Finish.
   * @returns The box, or null.
   */
  protected spanBox(span: NonNullable<TimelineRow['summary']>): BarBox | null {
    return barBox(this.scale(), {
      startDate: span.start.date,
      startSecondHalf: span.start.second,
      dueDate: span.finish.dueDate,
      dueFirstHalf: span.finish.dueFirstHalf,
    });
  }

  /**
   * The CSS variables colouring a bar by its type.
   *
   * @param item The item.
   * @returns Inline style.
   */
  protected barVars(item: WorkItemDto): string {
    const t = item.type.toLowerCase();
    return `--bar: var(--k-type-${t}); --bar-soft: var(--k-type-${t}-soft);`;
  }

  /**
   * A bar's accessible name: key, title, dates, duration, status and the keys to change it.
   *
   * @param item The item.
   * @returns The name.
   */
  protected barLabel(item: WorkItemDto): string {
    const draft = this.barDraft();
    const dates = draft?.id === item.id ? this.drafted(item, draft) : item;
    const days =
      dates.startDate !== null && dates.dueDate !== null
        ? `, ${durationText(workingDuration(dates, this.calendar()))} days`
        : '';
    const conflict = this.conflictMap().has(item.id)
      ? `, starts before ${this.predKeys(item)} ends`
      : '';
    const keys = this.canEditDates(item)
      ? '. Arrow keys move it, Shift with arrows changes the duration, Enter saves.'
      : '';
    return `${item.key} ${item.title}, ${this.range(dates)}${days}, ${STATUS_LABELS[item.status]}${conflict}${keys}`;
  }

  /**
   * Whether the caller may change an item's dates here (M9.2: the plan may
   * be kept to PMs and Leads).
   *
   * @param item The item.
   * @returns True when editable on an unarchived project.
   */
  protected canEditDates(item: WorkItemDto): boolean {
    return this.ctx.canPlan(item);
  }

  /**
   * Whether a cell can be edited.
   *
   * @param row The row.
   * @param column The column.
   * @returns True when editable.
   */
  protected editable(row: TimelineRow, column: Column): boolean {
    const item = row.node.item;
    if (item === null || column.edit === null || !this.ctx.canEdit(item)) return false;
    // Epics and Features show their stories' sprints, read-only (M12).
    if (column.id === 'sprint' && !hasOwnSprint(item.type)) return false;
    if (PLAN_COLUMNS.includes(column.id) && !this.ctx.canPlan(item)) return false;
    if (row.summary !== null && ['start', 'days', 'due'].includes(column.id)) return false;
    return true;
  }

  // --- Scrolling ---------------------------------------------------------

  /**
   * Scrolls the bars so a day is near the left.
   *
   * @param day Day number.
   */
  protected scrollToDay(day: number): void {
    afterNextRender(
      () => {
        const el = this.scroller()?.nativeElement;
        if (el === undefined) return;
        el.scrollLeft = Math.max(0, (day - this.scale().origin) * this.scale().dayWidth - 40);
      },
      { injector: this.injector },
    );
  }

  /**
   * Picks the zoom that fits the plan and scrolls to its start.
   */
  protected fitPlan(): void {
    const plan = this.plan();
    const el = this.scroller()?.nativeElement;
    if (plan === null || el === undefined) return;
    const days = dayNumber(plan.finish.dueDate) - dayNumber(plan.start.date) + 1;
    const room = el.clientWidth - this.gridPane() - 60;
    this.zoom.set(days * 22 <= room ? 'week' : days * 7 <= room ? 'month' : 'quarter');
    this.scrollToDay(dayNumber(plan.start.date));
  }

  /**
   * Shows an item: expands its ancestors, clears filters that hide it,
   * scrolls to it and highlights it (`?item=` from "Show on timeline").
   *
   * @param number Item number.
   */
  private reveal(number: number): void {
    const item = this.ctx.items().find((i) => i.number === number);
    if (item === undefined) {
      this.toast.show(`Item ${number} is not on this timeline`);
      return;
    }
    if (this.filtered()) {
      this.text.set('');
      this.typeFilter.set('');
      this.assigneeFilter.set('');
      this.showDone.set(true);
      this.toast.show('Filters cleared to show the item');
    }
    const ancestors = new Set(item.ancestors.map((a) => a.id));
    this.collapsed.update((set) => new Set([...set].filter((id) => !ancestors.has(id))));
    this.flash.set(item.id);
    const index = this.rows().findIndex((r) => r.node.id === item.id);
    if (index >= 0) this.focus.set({ row: index, col: 1 });
    afterNextRender(
      () => {
        document.getElementById(`row-${item.id}`)?.scrollIntoView({ block: 'center' });
        const box = barBox(this.scale(), item);
        const el = this.scroller()?.nativeElement;
        if (box !== null && el !== undefined) el.scrollLeft = Math.max(0, box.left - 80);
      },
      { injector: this.injector },
    );
    setTimeout(() => this.flash.set(null), 2600);
  }

  // --- Grid navigation and editing ----------------------------------------

  /**
   * Toggles a row open or closed.
   *
   * @param id Row id.
   */
  protected toggle(id: string): void {
    this.collapsed.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * Moves the cell focus.
   *
   * @param row Row index.
   * @param col Column index.
   * @param focusDom Move DOM focus too.
   */
  protected focusCell(row: number, col: number, focusDom = true): void {
    const rows = this.rows().length;
    const cols = this.columns().length;
    const next = {
      row: Math.max(0, Math.min(rows - 1, row)),
      col: Math.max(0, Math.min(cols - 1, col)),
    };
    this.focus.set(next);
    this.revealColumn(next.col);
    if (focusDom)
      afterNextRender(() => document.getElementById(`c-${next.row}-${next.col}`)?.focus(), {
        injector: this.injector,
      });
  }

  /**
   * Keys of the grid in navigation mode (ARIA grid pattern).
   *
   * @param event The key event.
   */
  protected gridKey(event: KeyboardEvent): void {
    if (this.editing() !== null) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, .bar, button, a, mat-checkbox') !== null && event.key !== 'Escape') {
      if (!(target.closest('.cell') !== null && target.classList.contains('cell'))) return;
    }
    const { row, col } = this.focus();
    const r = this.rows()[row];
    const c = this.columns()[col];
    if (
      (event.ctrlKey || event.metaKey) &&
      (event.code === 'BracketRight' || event.code === 'BracketLeft')
    ) {
      event.preventDefault();
      void this.outline(event.code === 'BracketRight' ? 1 : -1);
      return;
    }
    if (event.altKey && event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      void this.shiftRow(row, event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.focusCell(row + 1, col);
        return;
      case 'ArrowUp':
        event.preventDefault();
        this.focusCell(row - 1, col);
        return;
      case 'ArrowRight':
        event.preventDefault();
        this.focusCell(row, col + 1);
        return;
      case 'ArrowLeft':
        event.preventDefault();
        this.focusCell(row, col - 1);
        return;
      case 'Home':
        event.preventDefault();
        this.focusCell(row, 0);
        return;
      case 'End':
        event.preventDefault();
        this.focusCell(row, this.columns().length - 1);
        return;
      case ' ':
        event.preventDefault();
        if (r?.node.item) this.toggleSelected(r.node.id);
        return;
      case 'Escape':
        this.selected.set(this.emptySet);
        return;
      case 'Insert':
        event.preventDefault();
        this.focusAdd(r?.node.item ?? null);
        return;
      case 'Enter':
        event.preventDefault();
        // Alt+Enter adds a child row under the focused row (v1.3.1).
        if (event.altKey) {
          const item = r?.node.item;
          if (!item || !this.canCreate()) return;
          if (this.canHaveChildren(item)) this.focusAddChild(item);
          else this.toast.show(`A ${typeName(item.type)} cannot have child rows`);
          return;
        }
        if (c?.id === 'key' && r?.node.item) this.openItem(r.node.item);
        else this.startEdit(row, col, null);
        return;
    }
    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      (c?.edit === 'text' || c?.id === 'who')
    ) {
      event.preventDefault();
      this.startEdit(row, col, event.key);
    }
  }

  /**
   * Starts editing a cell, or opens its menu.
   *
   * @param row Row index.
   * @param col Column index.
   * @param typed A first character typed, replacing the value.
   */
  protected startEdit(row: number, col: number, typed: string | null): void {
    const r = this.rows()[row];
    const c = this.columns()[col];
    if (r === undefined || c === undefined || !this.editable(r, c)) return;
    const item = r.node.item!;
    this.focus.set({ row, col });
    // Typing in the Who cell edits it as text ("Ann, Bo 25"); Enter opens the menu.
    if (c.edit === 'menu' && !(c.id === 'who' && typed !== null)) {
      this.openMenu(c.id, item, row, col);
      return;
    }
    const value =
      typed ??
      {
        title: item.title,
        start: this.startText(item),
        days: this.daysOf(r),
        due: this.dueText(item),
        pred: this.predNumbers(item),
      }[c.id as 'title' | 'start' | 'days' | 'due' | 'pred'] ??
      '';
    void this.editHold?.release();
    this.editHold = this.ctx.hold(item.id, PresenceAction.EDITING, COLUMN_FIELDS[c.id] ?? null);
    this.editing.set({ row, col, value });
    afterNextRender(
      () => {
        const input = this.editor()?.nativeElement;
        input?.focus();
        if (typed === null) input?.select();
      },
      { injector: this.injector },
    );
  }

  /**
   * Opens a cell's menu next to it.
   *
   * @param column The column.
   * @param item The item.
   * @param row Row index.
   * @param col Column index.
   */
  private openMenu(column: ColumnId, item: WorkItemDto, row: number, col: number): void {
    const cell = document.getElementById(`c-${row}-${col}`)?.getBoundingClientRect();
    this.menuAt.set({ x: cell?.left ?? 0, y: cell?.bottom ?? 0 });
    this.menuItem.set(item);
    this.activeMenu.set(
      column === 'status'
        ? this.statusMenuRef()
        : column === 'who'
          ? this.whoMenuRef()
          : column === 'type'
            ? this.typeMenuRef()
            : this.sprintMenuRef(),
    );
    afterNextRender(() => this.menuAnchor()?.openMenu(), { injector: this.injector });
  }

  private readonly statusMenuRef = viewChild.required<MatMenu>('statusMenu');
  private readonly whoMenuRef = viewChild.required<MatMenu>('whoMenu');
  /** The Type cell's menu. */
  private readonly typeMenuRef = viewChild.required<MatMenu>('typeMenu');
  private readonly sprintMenuRef = viewChild.required<MatMenu>('sprintMenu');

  /**
   * Keeps the edited text.
   *
   * @param value The text.
   */
  protected editValue(value: string): void {
    this.editing.update((e) => (e === null ? e : { ...e, value }));
  }

  /**
   * Keys while editing: Enter saves and goes down, Tab saves and goes
   * sideways, Escape cancels.
   *
   * @param event The key event.
   */
  protected editKey(event: KeyboardEvent): void {
    const e = this.editing();
    if (e === null) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.editing.set(null);
      void this.editHold?.release();
      this.editHold = null;
      this.focusCell(e.row, e.col);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const last = e.row >= this.rows().length - 1;
      void this.commit(last ? 'add' : { row: e.row + 1, col: e.col });
    } else if (event.key === 'Tab') {
      event.preventDefault();
      void this.commit({ row: e.row, col: e.col + (event.shiftKey ? -1 : 1) });
    }
  }

  /**
   * Saves the edited cell, then moves on.
   *
   * @param next Cell to focus next, 'add' for the add-row field, or null to stay.
   * @returns Resolves once saved.
   */
  protected async commit(next: { row: number; col: number } | 'add' | null): Promise<void> {
    const e = this.editing();
    if (e === null) return;
    this.editing.set(null);
    const r = this.rows()[e.row];
    const c = this.columns()[e.col];
    if (next === 'add') this.focusAdd(null);
    else if (next !== null) this.focusCell(next.row, next.col);
    else this.focus.set({ row: e.row, col: e.col });
    const hold = this.editHold;
    this.editHold = null;
    const missed = (await hold?.release(false)) ?? null;
    if (r?.node.item === null || r === undefined || c === undefined) {
      if (missed !== null) this.ctx.applyRemote(missed);
      return;
    }
    const item = await this.afterMissed(r.node.item, missed, COLUMN_WRITES[c.id] ?? [], 'editing');
    if (item !== null) await this.saveCell(item, c.id, e.value.trim());
  }

  /**
   * Applies a change someone else made while the caller edited or dragged
   * the same item. When it touched what the caller is changing, the caller
   * chooses: Keep mine (save on top of theirs) or Use theirs (M10 plan
   * sections 4.3, 4.3.1). No role outranks another; the notice names theirs.
   *
   * @param item The copy the edit started from.
   * @param missed The waiting change, if any.
   * @param fields What the caller's change writes.
   * @param doing "editing" or "moving", for the notice.
   * @returns The item to save the caller's change on, or null to drop it.
   */
  private async afterMissed(
    item: WorkItemDto,
    missed: RemoteChange | null,
    fields: readonly (keyof WorkItemDto)[],
    doing: 'editing' | 'moving',
  ): Promise<WorkItemDto | null> {
    if (missed === null) return item;
    this.ctx.applyRemote(missed);
    if (missed.item === null) {
      this.toast.show(
        missed.deleted
          ? `${personName(this.ctx.membersById(), missed.actorId)} deleted this item`
          : 'This item is no longer available to you',
      );
      return null;
    }
    if (!changedFields(item, missed.item, fields)) return missed.item;
    const who = personWithRole(this.ctx.membersById(), missed.actorId);
    const keep = await keepMine(
      this.dialog,
      doing === 'moving'
        ? `${who} changed the dates of this item while you were moving it`
        : `${who} changed this while you were editing`,
    );
    return keep ? missed.item : null;
  }

  /**
   * Initials of someone else editing a cell's field, for its outline.
   *
   * @param itemId Item id.
   * @param column The cell's column.
   * @returns Their initials, or null.
   */
  protected otherEditor(itemId: string, column: ColumnId): string | null {
    const field = COLUMN_FIELDS[column];
    const entry = this.ctx
      .presenceByItem()
      .get(itemId)
      ?.find((p) => p.action === PresenceAction.EDITING && p.field === field);
    return entry === undefined ? null : this.initials(entry.userId);
  }

  /**
   * Initials of someone else dragging a bar, for its outline.
   *
   * @param itemId Item id.
   * @returns Their initials, or null.
   */
  protected otherMover(itemId: string): string | null {
    const entry = this.ctx
      .presenceByItem()
      .get(itemId)
      ?.find((p) => p.action === PresenceAction.MOVING);
    return entry === undefined ? null : this.initials(entry.userId);
  }

  /**
   * "Changed by … just now" of a recently changed row.
   *
   * @param itemId Item id.
   * @returns The text, or null.
   */
  protected changedBy(itemId: string): string | null {
    this.ctx.recent();
    return this.ctx.changedBy(itemId);
  }

  /**
   * A person's initials.
   *
   * @param userId The person.
   * @returns Up to two letters.
   */
  private initials(userId: string): string {
    return personName(this.ctx.membersById(), userId)
      .split(/\s+/)
      .map((w) => w[0] ?? '')
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  /**
   * Saves one cell's new text.
   *
   * @param item The item.
   * @param column The column.
   * @param value The typed text.
   * @returns Resolves once saved.
   */
  private async saveCell(item: WorkItemDto, column: ColumnId, value: string): Promise<void> {
    const project = this.ctx.project();
    if (project === null) return;
    try {
      switch (column) {
        case 'title':
          if (value === '' || value === item.title) return;
          this.ctx.upsert(
            await this.api.update(project.id, item.id, { title: value.slice(0, ITEM_TITLE_MAX) }),
          );
          return;
        case 'start':
        case 'due': {
          if (value === (column === 'start' ? this.startText(item) : this.dueText(item))) return;
          const change = this.dateChange(item, column, value);
          if (change !== null) await this.reschedule([change]);
          return;
        }
        case 'days': {
          if (
            value ===
            this.daysOf({
              node: { id: item.id, ref: item, item, children: [] },
              depth: 0,
              summary: null,
            })
          )
            return;
          const days = parseDuration(value);
          if (days === null) {
            this.toast.show('Type a duration of at least 0.5 working days, in halves');
            return;
          }
          const start = item.startDate ?? item.dueDate ?? this.today();
          const finish = finishAfter(
            { date: start, second: item.startDate !== null && item.startSecondHalf },
            days,
            this.calendar(),
          );
          await this.reschedule([
            {
              item: item.id,
              startDate: start,
              startSecondHalf: item.startDate !== null && item.startSecondHalf,
              ...finish,
            },
          ]);
          return;
        }
        case 'pred':
          await this.savePredecessors(item, value);
          return;
        case 'who': {
          if (value === this.whoText(item)) return;
          const parsed = parseWho(
            value,
            this.ctx.members().filter((m) => m.isActive || item.assigneeIds.includes(m.userId)),
          );
          if (parsed.unknown.length > 0) {
            this.toast.show(`No member matches ${parsed.unknown.join(', ')}`);
            return;
          }
          this.ctx.upsert(
            await this.api.update(project.id, item.id, { assignees: parsed.assignees }),
          );
          return;
        }
      }
    } catch (error) {
      this.toast.error(error);
    }
  }

  /**
   * Builds a date change from typed text: any two of start, duration and due
   * set the third, so changing the start keeps the duration.
   *
   * @param item The item.
   * @param column Start or due.
   * @param value Typed text; empty clears the date.
   * @returns The change, or null when the text is not a date.
   */
  private dateChange(
    item: WorkItemDto,
    column: 'start' | 'due',
    value: string,
  ): RescheduleChangeRequest | null {
    if (value === '')
      return column === 'start'
        ? { item: item.id, startDate: null }
        : { item: item.id, dueDate: null };
    const parsed = parseHalfDay(value, this.today());
    if (parsed === null) {
      this.toast.show('Type a date such as 5 Nov or 05/11/2026, optionally with 1st or 2nd half');
      return null;
    }
    if (column === 'due') {
      return { item: item.id, dueDate: parsed.date, dueFirstHalf: parsed.half === 1 };
    }
    const second = parsed.half === 2;
    if (item.startDate !== null && item.dueDate !== null) {
      const finish = finishAfter(
        { date: parsed.date, second },
        Math.max(0.5, workingDuration(item, this.calendar())),
        this.calendar(),
      );
      return { item: item.id, startDate: parsed.date, startSecondHalf: second, ...finish };
    }
    return { item: item.id, startDate: parsed.date, startSecondHalf: second };
  }

  /**
   * Replaces an item's predecessors and reschedules it.
   *
   * @param item The item.
   * @param value Typed numbers or keys.
   * @returns Resolves once saved.
   */
  private async savePredecessors(item: WorkItemDto, value: string): Promise<void> {
    const project = this.ctx.project()!;
    const byNumber = new Map(this.ctx.items().map((i) => [i.number, i]));
    const { ids, unknown } = parsePredecessors(value, byNumber);
    if (unknown.length > 0) {
      this.toast.show(`Not found: ${unknown.join(', ')}`);
      return;
    }
    const current = this.edges()
      .filter((e) => e.blockedItemId === item.id)
      .map((e) => e.blockingItemId);
    const add = ids.filter((id) => !current.includes(id));
    const remove = current.filter((id) => !ids.includes(id));
    if (add.length === 0 && remove.length === 0) return;
    for (const id of add) await this.api.addDependency(project.id, item.id, { blockingItemId: id });
    for (const id of remove) await this.api.removeDependency(project.id, item.id, id);
    await this.loadEdges();
    await this.reschedule([{ item: item.id }]);
  }

  // --- Rescheduling ------------------------------------------------------

  /**
   * Sends date changes through the project's reschedule flow.
   *
   * @param changes The changes.
   * @returns Resolves once done or cancelled.
   */
  protected async reschedule(changes: RescheduleChangeRequest[]): Promise<void> {
    await this.flow.change(changes);
  }

  /**
   * Dates after an unsaved drag or keyboard change, kept on working half
   * days: a start on a weekend goes to Monday, a finish to Friday; a moved
   * bar keeps its working duration.
   *
   * @param item The item.
   * @param draft The change.
   * @returns The dates.
   */
  private drafted(item: WorkItemDto, draft: BarDraft): ScheduleDates {
    const cal = this.calendar();
    const shift = (date: string, second: boolean, halves: number) => {
      const index = dayNumber(date) * 2 + (second ? 1 : 0) + halves;
      return { date: dateOfDay(Math.floor(index / 2)), second: index % 2 === 1 };
    };
    if (item.startDate === null || item.dueDate === null) {
      if (item.dueDate !== null) {
        const end = shift(item.dueDate, !item.dueFirstHalf, draft.end);
        const half = slotHalfDay(endSlot(end.date, !end.second, cal), cal);
        return {
          startDate: null,
          startSecondHalf: false,
          dueDate: half.date,
          dueFirstHalf: !half.second,
        };
      }
      if (item.startDate !== null) {
        const start = shift(item.startDate, item.startSecondHalf, draft.start);
        const half = slotHalfDay(startSlot(start.date, start.second, cal), cal);
        return {
          startDate: half.date,
          startSecondHalf: half.second,
          dueDate: null,
          dueFirstHalf: false,
        };
      }
      return {
        startDate: null,
        startSecondHalf: false,
        dueDate: null,
        dueFirstHalf: false,
      };
    }
    const s = shift(item.startDate, item.startSecondHalf, draft.start);
    const startHalf = slotHalfDay(startSlot(s.date, s.second, cal), cal);
    if (draft.start === draft.end) {
      return {
        startDate: startHalf.date,
        startSecondHalf: startHalf.second,
        ...finishAfter(startHalf, Math.max(0.5, workingDuration(item, cal)), cal),
      };
    }
    const e = shift(item.dueDate, !item.dueFirstHalf, draft.end);
    let endIndex = endSlot(e.date, !e.second, cal);
    const startIndex = startSlot(startHalf.date, startHalf.second, cal);
    endIndex = Math.max(endIndex, startIndex);
    const endHalf = slotHalfDay(endIndex, cal);
    return {
      startDate: startHalf.date,
      startSecondHalf: startHalf.second,
      dueDate: endHalf.date,
      dueFirstHalf: !endHalf.second,
    };
  }

  /**
   * Starts dragging a bar or one of its ends.
   *
   * @param event The pointer event.
   * @param item The item.
   * @param mode Move the bar, or change its start or end.
   */
  protected dragStart(
    event: PointerEvent,
    item: WorkItemDto,
    mode: 'move' | 'start' | 'end',
  ): void {
    if (!this.canEditDates(item) || event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    this.drag = { id: item.id, mode, x: event.clientX, pointer: event.pointerId };
    void this.barHold?.release();
    this.barHold = this.ctx.hold(item.id, PresenceAction.MOVING);
    const target = event.target as HTMLElement;
    const move = (e: PointerEvent) => {
      if (this.drag === null) return;
      const halves = Math.round((e.clientX - this.drag.x) / (this.scale().dayWidth / 2));
      this.barDraft.set({
        id: item.id,
        start: this.drag.mode === 'end' ? 0 : halves,
        end: this.drag.mode === 'start' ? 0 : halves,
      });
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      this.drag = null;
      void this.commitBar(item);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  /**
   * Keys of a focused bar: arrows move it by half a day, Shift+arrows change
   * the duration, Enter saves, Escape cancels.
   *
   * @param event The key event.
   * @param item The item.
   */
  protected barKey(event: KeyboardEvent, item: WorkItemDto): void {
    if (event.key === 'Enter' && this.barDraft()?.id !== item.id) {
      event.preventDefault();
      this.openItem(item);
      return;
    }
    if (!this.canEditDates(item)) return;
    const draft =
      this.barDraft()?.id === item.id ? this.barDraft()! : { id: item.id, start: 0, end: 0 };
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === 'ArrowLeft' ? -1 : 1;
      this.barDraft.set(
        event.shiftKey
          ? { ...draft, end: draft.end + step }
          : { ...draft, start: draft.start + step, end: draft.end + step },
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void this.commitBar(item);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.barDraft.set(null);
    }
  }

  /**
   * Saves a bar's unsaved change.
   *
   * @param item The item.
   * @returns Resolves once saved or cancelled.
   */
  private async commitBar(item: WorkItemDto): Promise<void> {
    const hold = this.barHold;
    this.barHold = null;
    const missed = (await hold?.release(false)) ?? null;
    const draft = this.barDraft();
    if (draft === null || draft.id !== item.id || (draft.start === 0 && draft.end === 0)) {
      if (draft?.id === item.id) this.barDraft.set(null);
      if (missed !== null) this.ctx.applyRemote(missed);
      return;
    }
    // The dates the caller dropped the bar on, from the copy they saw.
    const to = this.drafted(item, draft);
    if ((await this.afterMissed(item, missed, CONFLICT_FIELDS.dates, 'moving')) === null) {
      this.barDraft.set(null);
      return;
    }
    try {
      await this.reschedule([{ item: item.id, ...to }]);
    } finally {
      this.barDraft.set(null);
    }
  }

  // --- Single-row actions --------------------------------------------------

  /**
   * Opens an item in the drawer beside the timeline.
   *
   * @param item The item.
   */
  protected openItem(item: WorkItemDto): void {
    void this.router.navigate(['items', item.number], { relativeTo: this.route });
  }

  /**
   * Sets an item's status from its menu.
   *
   * @param item The item.
   * @param status New status.
   * @returns Resolves once saved.
   */
  protected async setStatus(item: WorkItemDto, status: ItemStatus): Promise<void> {
    try {
      this.ctx.upsert(await this.api.update(this.ctx.project()!.id, item.id, { status }));
    } catch (error) {
      this.toast.error(error);
    }
  }

  /**
   * Reports whether a row's item has a sprint of its own (M12).
   *
   * @param item The item.
   * @returns False for Epics and Features.
   */
  protected ownSprint(item: WorkItemDto): boolean {
    return hasOwnSprint(item.type);
  }

  /**
   * Reports whether a Task or Bug sits in another sprint than its Story (M12).
   *
   * @param item The item.
   * @returns True when its Story's sprint differs.
   */
  protected storySprintDiffers(item: WorkItemDto): boolean {
    const parent = item.parentId === null ? undefined : this.byId().get(item.parentId);
    return (
      item.sprintId !== null && parent?.type === ItemType.STORY && parent.sprintId !== item.sprintId
    );
  }

  /**
   * The sprints of an Epic's or Feature's visible descendants (M12).
   *
   * @param row The row.
   * @returns Sprint names, comma-separated.
   */
  protected childSprints(row: TimelineRow): string {
    const ids = new Set<string>();
    const walk = (nodes: readonly TimelineRow['node'][]): void => {
      for (const node of nodes) {
        if (node.item?.sprintId) ids.add(node.item.sprintId);
        walk(node.children);
      }
    };
    walk(row.node.children);
    return this.ctx
      .sprints()
      .filter((s) => ids.has(s.id))
      .map((s) => s.name)
      .join(', ');
  }

  /**
   * Sets an item's sprint from its menu.
   *
   * @param item The item.
   * @param sprintId Sprint, or null.
   * @returns Resolves once saved.
   */
  protected async setSprint(item: WorkItemDto, sprintId: string | null): Promise<void> {
    try {
      this.ctx.upsert(await this.api.update(this.ctx.project()!.id, item.id, { sprintId }));
    } catch (error) {
      this.toast.error(error);
    }
  }

  /**
   * What the Who cell draws: as many avatars as fit the column, a "+N" circle
   * for the rest, and every name with its share (below 100%) as its label and
   * tooltip, since shares are not drawn.
   *
   * @param item The item.
   * @param width The column width in px.
   * @returns The stack, or null without assignees.
   */
  protected whoStack(
    item: WorkItemDto,
    width: number,
  ): { shown: AssigneeShareDto[]; more: number; label: string } | null {
    const people = sharesOf(item);
    if (people.length === 0) return null;
    const fit = fitAvatars(people.length, width - CELL_PADDING_PX);
    return {
      shown: people.slice(0, fit.shown),
      more: fit.more,
      label: people.map((a) => shareLabel(this.memberName(a.userId), a.share)).join(', '),
    };
  }

  /**
   * The Who cell's text: names, with the share after those below 100%.
   *
   * @param item The item.
   * @returns E.g. "Ann, Bo 25".
   */
  protected whoText(item: WorkItemDto): string {
    return whoText(sharesOf(item), (id) => this.memberName(id));
  }

  /**
   * Sets one person's share on an item from the Who menu (M13).
   *
   * @param item The item.
   * @param choice The person and the new percent.
   * @returns Resolves once saved.
   */
  protected async setShare(item: WorkItemDto, choice: ShareChoice): Promise<void> {
    const current = this.ctx.itemsById().get(item.id) ?? item;
    if (shareOf(current, choice.userId) === choice.share) return;
    try {
      const updated = await this.api.update(this.ctx.project()!.id, item.id, {
        assignees: withShareFor(sharesOf(current), choice.userId, choice.share),
      });
      this.ctx.upsert(updated);
      this.menuItem.set(updated);
    } catch (error) {
      this.toast.error(error);
    }
  }

  /**
   * Share keys on a ticked person in the Who menu: ← / → and digits.
   *
   * @param event The key event.
   * @param item The item.
   * @param userId The person.
   */
  protected whoKey(event: KeyboardEvent, item: WorkItemDto, userId: string): void {
    const current = this.ctx.itemsById().get(item.id) ?? item;
    const share = shareOf(current, userId);
    if (share === null || !current.can.plan) return;
    this.whoShareKeys.handle(event, userId, share);
  }

  /** Share keys of the Who menu, applied to the item the menu is open for. */
  private readonly whoShareKeys = new ShareKeys((choice) => {
    const item = this.menuItem();
    if (item !== null) void this.setShare(item, choice);
  });

  /**
   * Adds or removes one assignee from the menu.
   *
   * @param item The item.
   * @param userId The member.
   * @returns Resolves once saved.
   */
  protected async toggleAssignee(item: WorkItemDto, userId: string): Promise<void> {
    const current = this.ctx.itemsById().get(item.id) ?? item;
    const assigneeIds = current.assigneeIds.includes(userId)
      ? current.assigneeIds.filter((id) => id !== userId)
      : [...current.assigneeIds, userId];
    try {
      const updated = await this.api.update(this.ctx.project()!.id, item.id, { assigneeIds });
      this.ctx.upsert(updated);
      this.menuItem.set(updated);
    } catch (error) {
      this.toast.error(error);
    }
  }

  // --- New rows ------------------------------------------------------------

  /**
   * The row index after which the typing row shows (v1.3.1): after the
   * subtree of the row chosen with Add row below or Add child row, so the
   * new row appears where it will be; null shows it at the bottom.
   */
  protected readonly inlineAt = computed(() => {
    const anchor = this.addChildOf() ?? this.addParent();
    if (anchor === null) return null;
    const rows = this.rows();
    const at = rows.findIndex((row) => row.node.id === anchor.id);
    if (at < 0) return null;
    let end = at;
    while (end + 1 < rows.length && rows[end + 1].depth > rows[at].depth) end++;
    return end;
  });

  /** Indent of the typing row: a child's depth, or the chosen row's own. */
  protected readonly addDepth = computed(() => {
    const anchor = this.addChildOf() ?? this.addParent();
    const at = this.inlineAt();
    if (anchor === null || at === null) return 0;
    const depth = this.rows().find((row) => row.node.id === anchor.id)?.depth ?? 0;
    return this.addChildOf() === null ? depth : depth + 1;
  });

  /**
   * Middle of a row in the bars layer, below the typing row when it shows
   * above it.
   *
   * @param index Row index.
   * @returns Y in px.
   */
  private rowY(index: number): number {
    const inline = this.inlineAt();
    const shift = inline !== null && index > inline ? 1 : 0;
    return (index + shift) * this.rowHeight() + this.rowHeight() / 2;
  }

  /**
   * Focuses the add-row field; new rows go beside the given item.
   *
   * @param beside The item the new row goes beside, or null for the focused row.
   */
  protected focusAdd(beside: WorkItemDto | null): void {
    this.addChildId.set(null);
    this.addParent.set(beside);
    afterNextRender(() => this.adder()?.nativeElement.focus(), { injector: this.injector });
  }

  /**
   * Focuses the add-row field so new rows become children of an item, with
   * its natural child type (v1.3.1): Stories under a Feature, Tasks under a
   * Story, Features under an Epic. Stays until another row is chosen.
   *
   * @param parent The item the new rows go under.
   */
  protected focusAddChild(parent: WorkItemDto): void {
    if (!this.canHaveChildren(parent)) return;
    this.addParent.set(null);
    this.addChildId.set(parent.id);
    if (this.collapsed().has(parent.id)) {
      const open = new Set(this.collapsed());
      open.delete(parent.id);
      this.collapsed.set(open);
    }
    afterNextRender(() => this.adder()?.nativeElement.focus(), { injector: this.injector });
  }

  /**
   * Leaves the typing row with Escape: new rows go to the bottom again and
   * the focus returns to the row it was opened from.
   */
  protected leaveAdder(): void {
    const anchor = this.addChildOf() ?? this.addParent();
    this.addParent.set(null);
    this.addChildId.set(null);
    const at = anchor === null ? -1 : this.rows().findIndex((row) => row.node.id === anchor.id);
    if (at >= 0) this.focusCell(at, this.focus().col);
  }

  /**
   * Whether an item can take child rows: Epics, Features and Stories that are
   * not ad hoc.
   *
   * @param item The item.
   * @returns True when "Add child row" applies.
   */
  protected canHaveChildren(item: WorkItemDto): boolean {
    return !item.adHoc && naturalChildType(item.type) !== null;
  }

  /**
   * The parent new rows go under: the chosen row's parent (they become its
   * siblings), else the focused row's.
   *
   * @returns The parent item reference, or null for the top level.
   */
  private newRowParent(): { id: string; key: string; type: ItemType } | null {
    const under = this.addChildOf();
    if (under !== null) return { id: under.id, key: under.key, type: under.type };
    const beside = this.addParent() ?? this.rows()[this.focus().row]?.node.item ?? null;
    const parent = beside?.ancestors[beside.ancestors.length - 1];
    return parent === undefined ? null : { id: parent.id, key: parent.key, type: parent.type };
  }

  /**
   * The type a new row gets: the type of the row it goes beside, or the
   * usual child of the parent.
   *
   * @param parentType The parent's type, or null.
   * @returns The type.
   */
  private newRowType(parentType: ItemType | null): ItemType {
    const under = this.addChildOf();
    if (under !== null) return naturalChildType(under.type) ?? ItemType.TASK;
    const beside = this.addParent() ?? this.rows()[this.focus().row]?.node.item ?? null;
    return beside?.type ?? childTypeOf(parentType, ItemType.TASK);
  }

  /**
   * Creates one item from the add-row field.
   *
   * @param input The field.
   * @returns Resolves once created.
   */
  protected async addRow(input: HTMLInputElement): Promise<void> {
    const title = input.value.trim();
    if (title === '') return;
    input.value = '';
    const parent = this.newRowParent();
    await this.createRows([{ title, level: 0 }], parent);
  }

  /**
   * Creates rows one after another; each level-n row goes under the last
   * level n-1 row. Stops at the first refusal and reports it.
   *
   * @param rows Titles and levels.
   * @param parent The parent of level-0 rows.
   * @returns Resolves once done.
   */
  private async createRows(
    rows: { title: string; level: number }[],
    parent: { id: string; key: string; type: ItemType } | null,
  ): Promise<void> {
    const project = this.ctx.project();
    if (project === null) return;
    const chain: { id: string; key: string; type: ItemType }[] = [];
    const created: WorkItemDto[] = [];
    let placedAny = false;
    const teamId = project.myVisibility === 'TEAMS' ? (project.myTeams[0]?.teamId ?? null) : null;
    for (const [index, row] of rows.entries()) {
      const above =
        row.level === 0 ? parent : (chain[row.level - 1] ?? chain[chain.length - 1] ?? parent);
      const type =
        index === 0 && row.level === 0
          ? this.newRowType(above?.type ?? null)
          : childTypeOf(above?.type ?? null, this.newRowType(parent?.type ?? null));
      try {
        const item = await this.api.create(project.id, {
          type,
          title: row.title,
          ...(above === null ? {} : { parentId: above.id }),
          // No bucket: the project's "New items start in" bucket, or the
          // first the caller can see items in (M12).
          ...(teamId === null ? {} : { teamId }),
        });
        this.ctx.upsert(item);
        created.push(item);
        // Add row below: the new row goes right after the chosen row (or the
        // row added before it), not at the end of its siblings (v1.3.1).
        const beside = this.addParent();
        if (row.level === 0 && beside !== null && this.addChildOf() === null) {
          this.addParent.set(
            await this.outlineApi.outline(project.id, item.id, { afterId: beside.id }),
          );
          placedAny = true;
        }
        chain[row.level] = { id: item.id, key: item.key, type: item.type };
        chain.length = row.level + 1;
      } catch (error) {
        this.report.set({
          summary: `${created.length} of ${rows.length} rows created; stopped at "${row.title}".`,
          problems: [errorMessage(error)],
        });
        if (placedAny) await this.ctx.refresh();
        return;
      }
    }
    // Placing may have numbered the siblings too: reload so the order is right.
    if (placedAny) await this.ctx.refresh();
    // The typing row moved under the new row; keep typing there.
    afterNextRender(() => this.adder()?.nativeElement.focus(), { injector: this.injector });
    // Undo deletes the rows, so it is offered only when the caller may delete
    // every one (with the plan kept to PMs and Leads, a Member may not once a
    // row is scheduled).
    if (rows.length > 1 && !created.every((i) => i.can.delete)) {
      this.toast.show(`${created.length} rows created`);
    } else if (rows.length > 1) {
      this.toast.show(`${created.length} rows created`, async () => {
        // Children first, so every delete is an ordinary one without cascade.
        const kept: string[] = [];
        for (const item of [...created].reverse())
          await this.api.remove(project.id, item.id).catch((error: unknown) => {
            kept.push(`${item.key}: ${errorMessage(error)}`);
          });
        await this.ctx.refresh();
        if (kept.length > 0)
          this.report.set({ summary: `${kept.length} rows could not be removed.`, problems: kept });
      });
    }
  }

  /**
   * Turns pasted lines into rows after a preview.
   *
   * @param event The paste event.
   * @returns Resolves once done.
   */
  protected async pasteRows(event: ClipboardEvent): Promise<void> {
    if (!this.canCreate() || this.editing() !== null) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!/\r?\n./.test(text.trim())) return;
    event.preventDefault();
    const rows = parsePasted(text, ITEM_TITLE_MAX);
    const parent = this.newRowParent();
    const ok = await this.dialogs.confirm({
      title: `Create ${rows.length} items?`,
      message:
        rows
          .slice(0, 8)
          .map((r) => `${'  '.repeat(r.level)}${r.title}`)
          .join(' · ') +
        (rows.length > 8 ? ` · and ${rows.length - 8} more` : '') +
        (parent === null ? '' : ` (under ${parent.key})`),
      confirm: `Create ${rows.length} items`,
    });
    if (ok) await this.createRows(rows, parent);
  }

  // --- Selection and bulk actions ----------------------------------------

  /**
   * Selects rows by click: plain toggles one, Shift selects a range from the
   * last clicked row, Ctrl/Cmd adds or removes one.
   *
   * @param event The click.
   * @param index Row index.
   */
  protected selectClick(event: MouseEvent, index: number): void {
    event.stopPropagation();
    const id = this.rows()[index]?.node.id;
    if (id === undefined) return;
    if (event.shiftKey && this.anchor !== null) {
      event.preventDefault();
      const [a, b] = [Math.min(this.anchor, index), Math.max(this.anchor, index)];
      const ids = this.rows()
        .slice(a, b + 1)
        .filter((r) => r.node.item !== null)
        .map((r) => r.node.id);
      this.selected.update((set) => new Set([...set, ...ids]));
      return;
    }
    this.anchor = index;
    this.toggleSelected(id);
  }

  /**
   * Adds a row to the selection or removes it.
   *
   * @param id Row id.
   */
  private toggleSelected(id: string): void {
    this.selected.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * The selected items in display order.
   *
   * @returns Items.
   */
  private selectedItems(): WorkItemDto[] {
    const chosen = this.selected();
    const byId = this.ctx.itemsById();
    const shown = this.rows()
      .map((r) => r.node.id)
      .filter((id) => chosen.has(id));
    const hidden = [...chosen].filter((id) => !shown.includes(id));
    return [...shown, ...hidden].map((id) => byId.get(id)).filter((i) => i !== undefined);
  }

  /**
   * Sets a field on every selected row, one request per row; a toast offers
   * Undo, which puts every changed row back (v1.4.0).
   *
   * @param field What to set.
   * @param value The value.
   * @returns Resolves once done.
   */
  protected async bulk(field: BulkField, value: string): Promise<void> {
    const project = this.ctx.project();
    const userId = this.session.user()?.id;
    if (project === null || userId === undefined || this.busy()) return;
    this.busy.set(true);
    const plan = planBulk(this.selectedItems(), field, value, {
      userId,
      canAssignOthers: (teamId) => this.ctx.canAssignOthers(teamId),
      childTypes: (id) =>
        this.ctx
          .items()
          .filter((i) => i.parentId === id)
          .map((i) => i.type),
      itemById: (id) => this.ctx.itemsById().get(id),
    });
    const result = await runBulk(plan.steps, (step) =>
      step.kind === 'move'
        ? this.api.move(project.id, step.item.id, step.request)
        : this.api.update(project.id, step.item.id, step.request),
    );
    this.busy.set(false);
    for (const item of result.updated) this.ctx.upsert(item);
    // A new parent or type also changes descendants' ancestors and buckets.
    if ((field === 'parent' || field === 'type') && result.updated.length > 0)
      await this.ctx.refresh();
    this.bulkRuns.update((n) => n + 1);
    this.report.set({
      summary: `${result.updated.length} updated, ${plan.unchanged.length} already set, ${plan.skipped.length} skipped, ${result.failed.length} refused.`,
      problems: [
        ...plan.skipped.map(
          (i) => `${i.key}: ${plan.reasons.get(i.id) ?? 'you cannot make this change'}`,
        ),
        ...result.failed.map((f) => `${f.item.key}: ${f.message}`),
      ],
    });
    if (result.updated.length === 0) return;
    const before = new Map(plan.steps.map((step) => [step.item.id, step.item]));
    const count = result.updated.length;
    this.toast.show(`${count} ${count === 1 ? 'row' : 'rows'} updated`, async () => {
      this.busy.set(true);
      const undone = await undoBulk(before, result.updated, {
        move: (item, request) => this.api.move(project.id, item.id, request),
        update: (item, request) => this.api.update(project.id, item.id, request),
      }).finally(() => this.busy.set(false));
      for (const item of undone.updated) this.ctx.upsert(item);
      if (field === 'parent' || field === 'type') await this.ctx.refresh();
      this.report.set({
        summary: `${undone.updated.length} put back, ${undone.failed.length} refused.`,
        problems: undone.failed.map((f) => `${f.item.key}: ${f.message}`),
      });
      assertUndone(undone);
    });
  }

  /**
   * Items the selected rows can move under: visible Epics, Features and
   * Stories that are not selected, in plan order (v1.3.1).
   */
  protected readonly parentChoices = computed(() => {
    const chosen = this.selected();
    return this.ctx
      .items()
      .filter((i) => naturalChildType(i.type) !== null && !i.adHoc && !chosen.has(i.id));
  });

  /**
   * Indents or outdents the selected rows, or the focused row without a
   * selection. Rows whose parent is also selected move with it.
   *
   * @param direction 1 to indent, -1 to outdent.
   * @returns Resolves once done.
   */
  protected async outline(direction: 1 | -1): Promise<void> {
    const chosen = this.selected();
    if (chosen.size === 0) {
      await this.outlineOne(this.focus().row, direction);
      return;
    }
    const ids = this.selectedItems()
      .filter((i) => !i.ancestors.some((a) => chosen.has(a.id)))
      .map((i) => i.id);
    const problems: string[] = [];
    let moved = 0;
    this.busy.set(true);
    for (const id of ids) {
      const index = this.rows().findIndex((r) => r.node.id === id);
      const problem = await this.moveInOutline(index, direction);
      if (problem === null) moved++;
      else problems.push(problem);
    }
    this.busy.set(false);
    this.report.set({ summary: `${moved} moved, ${problems.length} not moved.`, problems });
  }

  /**
   * Indents or outdents one row.
   *
   * @param index Row index.
   * @param direction 1 to indent, -1 to outdent.
   * @returns Resolves once done.
   */
  protected async outlineOne(index: number, direction: 1 | -1): Promise<void> {
    const problem = await this.moveInOutline(index, direction);
    if (problem !== null) this.toast.show(problem);
  }

  /**
   * Moves one row in the outline and rebases its descendants.
   *
   * @param index Row index.
   * @param direction 1 to indent, -1 to outdent.
   * @returns Null when moved, else why not.
   */
  private async moveInOutline(index: number, direction: 1 | -1): Promise<string | null> {
    const rows = this.rows();
    const item = rows[index]?.node.item;
    if (item === undefined || item === null) return 'Choose a row first';
    if (!this.ctx.canPlan(item)) return `${item.key}: only PMs and Leads change its plan`;
    const childTypes = this.ctx
      .items()
      .filter((i) => i.parentId === item.id)
      .map((i) => i.type);
    const target =
      direction === 1
        ? indentTarget(rows, index, childTypes)
        : outdentTarget(rows, index, childTypes);
    if ('error' in target) return `${item.key}: ${target.error}`;
    try {
      // The type changes with the move when the old one is not allowed there.
      const moved = await this.api.update(this.ctx.project()!.id, item.id, {
        parentId: target.parentId,
        ...(target.type === undefined ? {} : { type: target.type }),
      });
      this.ctx.items.set(
        rebaseDescendants(
          this.ctx.items().map((i) => (i.id === moved.id ? moved : i)),
          moved,
        ),
      );
      return null;
    } catch (error) {
      return `${item.key}: ${errorMessage(error)}`;
    }
  }

  /**
   * Moves a row one place up or down among its siblings (Alt+Shift+Up/Down,
   * v1.3.1); its children move with it.
   *
   * @param index Row index.
   * @param direction -1 up, 1 down.
   * @returns Resolves once moved.
   */
  protected async shiftRow(index: number, direction: -1 | 1): Promise<void> {
    const item = this.rows()[index]?.node.item;
    if (!item) return;
    if (!this.ctx.canPlan(item)) {
      this.toast.show(`${item.key}: only PMs and Leads change its plan`);
      return;
    }
    const siblings = this.rows()
      .filter((row) => row.node.item !== null && row.node.item.parentId === item.parentId)
      .map((row) => row.node.id);
    const at = siblings.indexOf(item.id);
    const to = at + direction;
    if (at < 0 || to < 0 || to >= siblings.length) return;
    const afterId = direction === -1 ? (siblings[to - 1] ?? null) : siblings[to];
    // The row moves at once; the focus follows it, so the next press moves it again.
    const saving = this.placeRows([{ item, move: { afterId } }], false);
    const now = this.rows().findIndex((row) => row.node.id === item.id);
    if (now >= 0) this.focusCell(now, this.focus().col);
    await saving;
  }

  /**
   * Shifts a row while rows are dragged, to open the gap (v1.3.2).
   *
   * @param index Row index.
   * @returns A CSS translate, or null when it stays.
   */
  protected rowShift(index: number): string | null {
    const shift = this.rowDrag.view()?.shift[index] ?? 0;
    return shift === 0 ? null : `0 ${shift * this.rowHeight()}px`;
  }

  /**
   * The rows a drag from this row moves (v1.3.2): every selected row the
   * caller may plan when this row is selected, otherwise this row alone.
   * Rows inside another dragged row travel with it.
   *
   * @param index Row index.
   * @returns Row indexes in display order.
   */
  private draggedFrom(index: number): number[] {
    const rows = this.rows();
    const id = rows[index]?.node.id;
    if (id === undefined) return [];
    const selected = this.selected();
    const picked = selected.has(id)
      ? rows.flatMap((row, i) =>
          selected.has(row.node.id) && row.node.item !== null && this.ctx.canPlan(row.node.item)
            ? [i]
            : [],
        )
      : [index];
    const ids = new Set(picked.map((i) => rows[i].node.id));
    // The API refuses others too; this keeps the drag honest.
    if (!picked.every((i) => rows[i].node.item !== null && this.ctx.canPlan(rows[i].node.item)))
      return [];
    return picked.filter((i) => !(rows[i].node.item?.ancestors.some((a) => ids.has(a.id)) ?? true));
  }

  /**
   * What the drop gap says: the parent the rows go under and a type they
   * take, or why they cannot go there.
   *
   * @param target The possible drop.
   * @returns E.g. "Under KLO-3 · becomes User Story".
   */
  private dropLabel(target: DropTarget): string {
    if (target.moves === null) return target.reason;
    const parts: string[] = [];
    if (target.parent !== null) parts.push(`Under ${target.parent.key}`);
    else if (target.moves.some((m) => m.move.parentId !== undefined)) parts.push('Top level');
    const types = new Set(target.moves.flatMap((m) => m.move.type ?? []));
    if (types.size === 1) parts.push(`becomes ${typeName([...types][0])}`);
    else if (types.size > 1) parts.push('types fitted');
    return parts.join(' · ');
  }

  /**
   * Places rows at once and then saves them in order (v1.3.2): the plan shows
   * the new order straight away, the server's copies follow, and a failure
   * puts the rows back. A drop confirms with Undo, which returns each row to
   * the place it had.
   *
   * @param moves Placements in display order.
   * @param announce Whether to confirm with Undo (drops, not key presses).
   * @param release Ends a drag's holds: before the reload when rows move
   *   (it brings others' changes), replaying them when nothing moved.
   * @returns Resolves once saved and reloaded.
   */
  private async placeRows(
    moves: readonly DropMove[],
    announce: boolean,
    release: (apply: boolean) => void = () => undefined,
  ): Promise<void> {
    const project = this.ctx.project();
    if (project === null || moves.length === 0) {
      release(true);
      return;
    }
    const before = this.ctx.items();
    const back: DropMove[] = moves.map(({ item, move }) => ({
      item,
      move: {
        afterId: previousSibling(before, item),
        ...(move.parentId === undefined ? {} : { parentId: item.parentId }),
        ...(move.type === undefined ? {} : { type: item.type }),
      },
    }));
    // Dropped where they already were: nothing to save.
    const same = moves.every(
      ({ move }, k) =>
        move.parentId === undefined &&
        move.type === undefined &&
        move.afterId === back[k].move.afterId,
    );
    if (same) {
      release(true);
      return;
    }
    const changed = applyOutlineMoves(
      before,
      moves.map(({ item, move }) => ({ id: item.id, move })),
    );
    for (const item of changed) this.ctx.upsert(item);
    release(false);
    if (announce) {
      this.flash.set(moves[0].item.id);
      setTimeout(() => this.flash.set(null), 2600);
    }
    let saved = 0;
    const ok = await this.queuePlacement(async () => {
      try {
        for (const { item, move } of moves) {
          await this.outlineApi.outline(project.id, item.id, move);
          saved++;
        }
        return true;
      } catch (error) {
        // Put the rows back here and on the server for those already saved;
        // the reload then shows the server's state.
        const original = new Map(before.map((i) => [i.id, i]));
        for (const item of changed) {
          const was = original.get(item.id);
          if (was !== undefined) this.ctx.upsert(was);
        }
        try {
          for (const step of back.slice(0, saved))
            await this.outlineApi.outline(project.id, step.item.id, step.move);
        } catch {
          // The reload shows what is left.
        }
        this.toast.error(error);
        return false;
      }
    });
    if (ok && announce) {
      this.toast.show(this.movedText(moves), async () => {
        await this.queuePlacement(async () => {
          for (const { item, move } of back)
            await this.outlineApi.outline(project.id, item.id, move);
          return true;
        });
      });
    }
  }

  /**
   * Runs a save of placed rows after the ones before it, then reloads the
   * project once no other placement waits, so quick key presses do not see
   * rows jump back between saves. A failure still reloads, then rethrows.
   *
   * @param save The save; resolves to whether it succeeded.
   * @returns What the save resolved to.
   */
  private async queuePlacement(save: () => Promise<boolean>): Promise<boolean> {
    this.placements++;
    const run = this.placing.then(save);
    this.placing = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await run;
    } finally {
      // Siblings may have been numbered on the server too: reload the order.
      if (--this.placements === 0) await this.ctx.refresh();
    }
  }

  /**
   * Confirms a drop.
   *
   * @param moves The placements.
   * @returns E.g. "Moved KLO-12 under KLO-3 (now a User Story)".
   */
  private movedText(moves: readonly DropMove[]): string {
    const what = moves.length === 1 ? moves[0].item.key : `${moves.length} items`;
    const parentId = moves.find((m) => m.move.parentId !== undefined)?.move.parentId;
    const where =
      parentId === undefined
        ? ''
        : parentId === null
          ? ' to the top level'
          : ` under ${this.ctx.itemsById().get(parentId)?.key ?? 'its new parent'}`;
    const types = moves.flatMap((m) => m.move.type ?? []);
    let type = '';
    if (types.length > 0 && moves.length > 1) type = ' (types fitted)';
    else if (types.length > 0) {
      const name = typeName(types[0]);
      type = ` (now ${/^[AEIOU]/.test(name) ? 'an' : 'a'} ${name})`;
    }
    return `Moved ${what}${where}${type}`;
  }

  /**
   * Links the selected rows in display order: each becomes a predecessor of
   * the next. Dependent items then follow.
   *
   * @returns Resolves once done.
   */
  protected async linkInOrder(): Promise<void> {
    const items = this.selectedItems();
    if (items.length < 2) {
      this.toast.show('Select at least two rows to link');
      return;
    }
    const project = this.ctx.project()!;
    const problems: string[] = [];
    const linked: string[] = [];
    this.busy.set(true);
    for (let i = 1; i < items.length; i++) {
      const [pred, succ] = [items[i - 1], items[i]];
      if (this.edges().some((e) => e.blockingItemId === pred.id && e.blockedItemId === succ.id))
        continue;
      if (!this.ctx.canPlan(succ)) {
        problems.push(`${succ.key}: only PMs and Leads change its plan`);
        continue;
      }
      try {
        await this.api.addDependency(project.id, succ.id, { blockingItemId: pred.id });
        linked.push(succ.id);
      } catch (error) {
        problems.push(`${succ.key}: ${errorMessage(error)}`);
      }
    }
    this.busy.set(false);
    await this.loadEdges();
    this.report.set({ summary: `${linked.length} links added.`, problems });
    if (linked.length > 0) await this.reschedule(linked.map((id) => ({ item: id })));
  }

  /**
   * Removes the links among the selected rows.
   *
   * @returns Resolves once done.
   */
  protected async unlink(): Promise<void> {
    const chosen = this.selected();
    const project = this.ctx.project()!;
    const links = this.edges().filter(
      (e) => chosen.has(e.blockingItemId) && chosen.has(e.blockedItemId),
    );
    const problems: string[] = [];
    const byId = new Map(this.ctx.items().map((i) => [i.id, i]));
    for (const e of links) {
      const blocked = byId.get(e.blockedItemId);
      if (blocked !== undefined && !this.ctx.canPlan(blocked)) {
        problems.push(`${blocked.key}: only PMs and Leads change its plan`);
        continue;
      }
      try {
        await this.api.removeDependency(project.id, e.blockedItemId, e.blockingItemId);
      } catch (error) {
        problems.push(errorMessage(error));
      }
    }
    await this.loadEdges();
    this.report.set({ summary: `${links.length - problems.length} links removed.`, problems });
  }

  /**
   * Moves the selected rows by a number of working days; dependent items follow.
   *
   * @returns Resolves once done.
   */
  protected async shiftDates(): Promise<void> {
    const answer = await this.dialogs.prompt({
      title: 'Shift dates',
      label: 'Working days (negative moves earlier, halves allowed)',
      value: '1',
      confirm: 'Shift',
    });
    if (answer === null) return;
    const days = Number(answer.replace(',', '.'));
    if (!Number.isFinite(days) || days === 0 || !Number.isInteger(days * 2)) {
      this.toast.show('Type a number of working days such as 2, -1 or 0.5');
      return;
    }
    const halves = days * 2;
    const cal = this.calendar();
    const changes: RescheduleChangeRequest[] = [];
    for (const item of this.selectedItems()) {
      if (!this.ctx.canPlan(item) || (item.startDate === null && item.dueDate === null)) continue;
      const start =
        item.startDate === null
          ? null
          : slotHalfDay(startSlot(item.startDate, item.startSecondHalf, cal) + halves, cal);
      const end =
        item.dueDate === null
          ? null
          : slotHalfDay(endSlot(item.dueDate, item.dueFirstHalf, cal) + halves, cal);
      changes.push({
        item: item.id,
        ...(start === null ? {} : { startDate: start.date, startSecondHalf: start.second }),
        ...(end === null ? {} : { dueDate: end.date, dueFirstHalf: !end.second }),
        pin: 'keep',
      });
    }
    if (changes.length === 0) {
      this.toast.show('None of the selected rows has dates you can change');
      return;
    }
    await this.reschedule(changes);
  }

  /**
   * Creates a sprint spanning the selected rows and puts them in it.
   *
   * @returns Resolves once done.
   */
  protected async sprintFromSelection(): Promise<void> {
    const project = this.ctx.project()!;
    const span = planSpan(this.selectedItems(), this.calendar());
    if (span === null) {
      this.toast.show('The selected rows have no dates');
      return;
    }
    const name = await this.dialogs.prompt({
      title: `New sprint, ${shortDay(span.start.date, this.today())} – ${shortDay(span.finish.dueDate, this.today())}`,
      label: 'Sprint name',
      value: `Sprint ${this.ctx.sprints().length + 1}`,
      confirm: 'Create and assign',
      maxLength: 100,
    });
    if (name === null) return;
    try {
      const sprint = await this.api.createSprint(project.id, {
        name,
        startDate: span.start.date,
        endDate: span.finish.dueDate,
      });
      this.ctx.sprints.update((list) => [...list, sprint]);
      await this.bulk('sprint', sprint.id);
    } catch (error) {
      this.toast.error(error);
    }
  }

  /**
   * Deletes the selected rows after a confirmation, under the ordinary
   * delete rules; rows with children need cascade rights.
   *
   * @returns Resolves once done.
   */
  protected async deleteSelected(): Promise<void> {
    const project = this.ctx.project()!;
    const items = this.selectedItems().filter(
      (i) => !i.ancestors.some((a) => this.selected().has(a.id)),
    );
    const allowed = items.filter((i) => (i.childCount > 0 ? i.can.deleteCascade : i.can.delete));
    const skipped = items.filter((i) => !allowed.includes(i));
    if (allowed.length === 0) {
      this.toast.show('You cannot delete the selected rows');
      return;
    }
    const withChildren = allowed.filter((i) => i.childCount > 0).length;
    const ok = await this.dialogs.confirm({
      title: `Delete ${allowed.length} ${allowed.length === 1 ? 'item' : 'items'}?`,
      message:
        `${allowed
          .slice(0, 10)
          .map((i) => i.key)
          .join(', ')}${allowed.length > 10 ? ` and ${allowed.length - 10} more` : ''}` +
        (withChildren > 0 ? `, and the children of ${withChildren} of them` : '') +
        `. They move to the trash.${skipped.length > 0 ? ` ${skipped.length} you cannot delete stay.` : ''}`,
      confirm: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const problems: string[] = skipped.map((i) => `${i.key}: you cannot delete this item`);
    const batches: string[] = [];
    this.busy.set(true);
    for (const item of allowed) {
      try {
        batches.push((await this.api.remove(project.id, item.id, item.childCount > 0)).batchId);
      } catch (error) {
        problems.push(`${item.key}: ${errorMessage(error)}`);
      }
    }
    this.busy.set(false);
    this.selected.set(this.emptySet);
    await this.ctx.refresh();
    await this.loadEdges();
    if (problems.length > 0)
      this.report.set({
        summary: `${batches.length} moved to the trash.`,
        problems,
      });
    if (batches.length > 0)
      this.toast.show(
        `${batches.length} moved to the trash`,
        async () => {
          for (const batch of [...batches].reverse())
            await this.trashApi.restore(project.id, batch);
          await this.ctx.refresh();
          await this.loadEdges();
        },
        { action: 'Undo', done: 'Restored' },
      );
  }

  // --- Columns and rows ----------------------------------------------------

  /**
   * The types a row's item may change to.
   *
   * @param item The item.
   * @returns Allowed types.
   */
  protected typesFor(item: WorkItemDto): ItemType[] {
    const children = this.ctx
      .items()
      .filter((i) => i.parentId === item.id)
      .map((i) => i.type);
    return allowedTypes(item, children);
  }

  /**
   * Changes an item's type from the Type cell.
   *
   * @param item The item.
   * @param type New type.
   * @returns Resolves once saved.
   */
  protected async setType(item: WorkItemDto, type: ItemType): Promise<void> {
    if (type === item.type) return;
    try {
      this.ctx.upsert(await this.api.update(this.ctx.project()!.id, item.id, { type }));
    } catch (error) {
      this.toast.error(error);
    }
  }

  /**
   * Sets a column's width, or resets it with null, and remembers it.
   *
   * @param id Column id.
   * @param width Width in px, or null for the default.
   * @param remember Store the widths now (false while dragging).
   */
  protected setWidth(id: ColumnId, width: number | null, remember = true): void {
    this.widths.update((all) => {
      const next = { ...all };
      if (width === null) delete next[id];
      else next[id] = clampWidth(width);
      if (remember) store(WIDTHS_KEY, next);
      return next;
    });
  }

  /**
   * Resets every column to its default width.
   */
  protected resetWidths(): void {
    this.widths.set({});
    store(WIDTHS_KEY, {});
  }

  /**
   * Starts dragging a column edge.
   *
   * @param event The pointer event.
   * @param column The column.
   */
  protected resizeStart(event: PointerEvent, column: Column): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.target as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = column.width;
    const move = (e: PointerEvent) =>
      this.setWidth(column.id, startWidth + e.clientX - startX, false);
    const up = () => {
      store(WIDTHS_KEY, this.widths());
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  /**
   * Resizes a column from the keyboard: arrows by 8 px, with Shift by 32 px;
   * Home resets it.
   *
   * @param event The key event.
   * @param column The column.
   */
  protected resizeKey(event: KeyboardEvent, column: Column): void {
    const step = event.shiftKey ? 32 : 8;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      this.setWidth(column.id, column.width + (event.key === 'ArrowLeft' ? -step : step));
    } else if (event.key === 'Home') {
      event.preventDefault();
      this.setWidth(column.id, null);
    }
  }

  /**
   * Sets the plan table's width beside the bars, or fits every column with
   * null, and remembers it.
   *
   * @param width Width in px, or null.
   * @param remember Store it now (false while dragging).
   */
  protected setPane(width: number | null, remember = true): void {
    // A pane as wide as the columns fits them, also after columns change.
    const pane =
      width === null || width >= this.gridWidth()
        ? null
        : Math.round(Math.max(this.minPane(), width));
    this.paneWidth.set(pane);
    if (pane === null) this.gridX.set(0);
    // A scrollbar that appears now starts at 0; show the current shift on it.
    afterNextRender(
      () => {
        const bar = this.gridScroll()?.nativeElement;
        if (bar !== undefined) bar.scrollLeft = this.gridShift();
      },
      { injector: this.injector },
    );
    if (remember) store(PANE_KEY, pane);
  }

  /**
   * Scrolls a narrowed table sideways with a trackpad or Shift+wheel over its
   * cells, so overlay scrollbars (which may be hidden) are not needed.
   *
   * @param event The wheel event.
   */
  protected gridWheel(event: WheelEvent): void {
    const max = this.gridWidth() - this.gridPane();
    const delta = event.deltaX !== 0 ? event.deltaX : event.shiftKey ? event.deltaY : 0;
    if (max <= 0 || delta === 0) return;
    if (!(event.target instanceof Element) || event.target.closest('.cells') === null) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(max, this.gridShift() + delta));
    this.gridX.set(next);
    const bar = this.gridScroll()?.nativeElement;
    if (bar !== undefined) bar.scrollLeft = next;
  }

  /**
   * Starts dragging the splitter between the plan table and the bars.
   *
   * @param event The pointer event.
   */
  protected splitStart(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.target as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const start = this.gridPane();
    const move = (e: PointerEvent) => this.setPane(start + e.clientX - startX, false);
    const up = () => {
      store(PANE_KEY, this.paneWidth());
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  /**
   * Moves the splitter from the keyboard: arrows by 16 px, with Shift by
   * 64 px; Home fits every column.
   *
   * @param event The key event.
   */
  protected splitKey(event: KeyboardEvent): void {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      this.setPane(this.gridPane() + (event.key === 'ArrowLeft' ? -step : step));
    } else if (event.key === 'Home') {
      event.preventDefault();
      this.setPane(null);
    }
  }

  /**
   * Scrolls a narrowed plan table so a column is in view.
   *
   * @param col Column index.
   */
  private revealColumn(col: number): void {
    const pane = this.gridPane();
    const columns = this.columns();
    if (pane >= this.gridWidth() || columns[col] === undefined) return;
    // The first column brings the selection checkboxes back too.
    const start = CHECK + columns.slice(0, col).reduce((w, c) => w + c.width, 0);
    const left = col === 0 ? 0 : start;
    const right = start + columns[col].width;
    const shift = this.gridShift();
    const next = left < shift ? left : right > shift + pane ? right - pane : shift;
    if (next === shift) return;
    this.gridX.set(next);
    const bar = this.gridScroll()?.nativeElement;
    if (bar !== undefined) bar.scrollLeft = next;
  }

  /**
   * Chooses the row height and remembers it.
   *
   * @param density Compact, or titles on two or three lines.
   */
  protected setDensity(density: Density): void {
    this.density.set(density);
    store(DENSITY_KEY, density);
  }

  /**
   * Shows or hides an optional column, remembered in this browser.
   *
   * @param id Column id.
   */
  protected toggleColumn(id: ColumnId): void {
    this.shown.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLUMNS_KEY, JSON.stringify([...next]));
      } catch {
        // Storage may be unavailable (private windows); the choice then lasts this visit.
      }
      return next;
    });
  }
}

/**
 * Reads a remembered value; storage may be unavailable (private windows).
 *
 * @param key Storage key.
 * @param fallback Value when nothing usable is stored.
 * @returns The value.
 */
function loadStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/**
 * Remembers a value in this browser when storage is available.
 *
 * @param key Storage key.
 * @param value The value.
 */
function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The choice then lasts this visit only.
  }
}

/**
 * Keeps a column width within the allowed range.
 *
 * @param width Width in px.
 * @returns The clamped, whole width.
 */
function clampWidth(width: number): number {
  return Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width)));
}

/**
 * The remembered column widths, keeping only known columns with numbers.
 *
 * @returns Widths by column.
 */
function loadWidths(): Partial<Record<ColumnId, number>> {
  const raw = loadStored<unknown>(WIDTHS_KEY, {});
  const out: Partial<Record<ColumnId, number>> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [id, width] of Object.entries(raw)) {
    if (COLUMNS.some((c) => c.id === id) && typeof width === 'number' && Number.isFinite(width))
      out[id as ColumnId] = clampWidth(width);
  }
  return out;
}

/**
 * The remembered plan table width, or null to fit every column.
 *
 * @returns Width in px, or null.
 */
function loadPane(): number | null {
  const value = loadStored<unknown>(PANE_KEY, null);
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

/**
 * The remembered row height, compact by default.
 *
 * @returns The density.
 */
function loadDensity(): Density {
  const value = loadStored<string>(DENSITY_KEY, 'compact');
  return value === 'two' || value === 'three' ? value : 'compact';
}

/**
 * The optional columns remembered in this browser; Assignees and Status by default.
 *
 * @returns Column ids.
 */
function loadColumns(): ColumnId[] {
  try {
    const raw = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? 'null') as unknown;
    if (Array.isArray(raw))
      return raw.filter((id): id is ColumnId => COLUMNS.some((c) => c.id === id));
  } catch {
    // Unreadable storage falls back to the defaults.
  }
  return ['who', 'status'];
}
