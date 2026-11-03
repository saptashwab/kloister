import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatTabsModule } from '@angular/material/tabs';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import {
  type CreateItemRequest,
  ItemType,
  PRESENCE_VIEWS,
  type PresenceEntryDto,
  type PresenceView,
  ProjectPermission,
  SprintState,
} from '@kloister/shared';
import { filter, firstValueFrom, map } from 'rxjs';
import { errorMessage } from '../../core/api';
import { ItemsApiService } from '../../core/items-api.service';
import { ProjectContext } from '../../core/project-context';
import { RescheduleFlow } from '../../core/reschedule';
import { FoldControls, FoldHost } from '../../ui/fold';
import { Shortcuts } from '../../core/shortcuts';
import { Skeleton } from '../../ui/feedback';
import { Icon, type IconName } from '../../ui/icon';
import { ToastService } from '../../ui/toast.service';
import { dialogMotion } from '../../ui/motion';
import { NewItemDialog, type NewItemData } from './new-item-dialog';
import { PageActions } from '../../core/page-actions';
import { SnapshotAction } from '../../ui/snapshot-action';
import { drawerPath } from '../../core/live-logic';
import { LiveStatusChip, LiveStyles } from '../../ui/live-ui';
import { PresenceHead } from '../../ui/presence-head';

/**
 * Frame of one project (`/p/:key/…`, DESIGN §7): breadcrumb, project name,
 * "New item", tabs for the board, backlog, timeline (projects only),
 * calendar, sprints, reports (M13) and settings, and the page itself. The header also shows who else is on
 * the project's pages and the live updates connection chip (M10); a member
 * removed while looking sees "project not found".
 *
 * It provides the {@link ProjectContext} its pages share. Every member (and
 * every admin) can open each tab; the pages hide controls the caller lacks
 * permissions for, and the API answers 404 to non-members.
 */
@Component({
  selector: 'app-project-shell',
  imports: [
    LiveStatusChip,
    LiveStyles,
    PresenceHead,
    SnapshotAction,
    RouterOutlet,
    RouterLink,
    NgTemplateOutlet,
    MatTabsModule,
    MatButtonModule,
    Icon,
    Skeleton,
    FoldControls,
  ],
  providers: [ProjectContext, PageActions, RescheduleFlow],
  hostDirectives: [FoldHost],
  styles: `
    .head {
      padding: var(--k-size-14px) var(--k-gutter) 0;
    }
    .crumbs a {
      color: inherit;
      text-decoration: none;
    }
    .crumbs a:hover {
      text-decoration: underline;
    }
    .tabs-row {
      display: flex;
      align-items: center;
      gap: var(--k-space-2);
      padding: 0 var(--k-gutter) 0 calc(var(--k-gutter) - var(--k-space-2));
      border-bottom: var(--k-line) solid var(--k-border);
    }
    nav {
      flex: 1;
      min-width: 0;
      --mat-tab-header-divider-height: 0;
    }
    /* Below desktop width the folded row wraps: name and actions, then the tabs. */
    @media (max-width: 1023px) {
      :host(.k-folded) .tabs-row {
        flex-wrap: wrap;
        padding-top: var(--k-space-1);
      }
      :host(.k-folded) nav {
        flex-basis: 100%;
        order: 2;
      }
      :host(.k-folded) app-fold-controls {
        flex: 1 1 auto;
        flex-wrap: wrap;
        justify-content: flex-end;
        min-width: 0;
      }
    }
    .slim-name {
      flex: none;
      max-width: var(--k-size-200px);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding-left: var(--k-space-2);
      font-size: var(--k-body);
      font-weight: 700;
    }
    mat-tab-nav-panel {
      display: block;
      position: relative;
    }
    .tab {
      display: inline-flex;
      align-items: center;
      gap: var(--k-space-2);
    }
    .archived {
      margin: var(--k-space-3) var(--k-gutter) 0;
    }
    .missing {
      padding: var(--k-space-6) var(--k-gutter);
    }
  `,
  template: `
    <app-live-styles />
    @if (ctx.project(); as project) {
      <ng-template #actions let-slim>
        <app-live-status />
        <app-presence-head [people]="ctx.presence()" (goTo)="goTo($event)" />
        @if (slim) {
          <button
            type="button"
            class="k-icon-btn"
            (click)="shortcuts.open()"
            aria-label="Search or jump"
            title="Search or jump (/)"
          >
            <app-icon name="search" />
          </button>
        } @else {
          <button
            type="button"
            class="k-chip"
            (click)="shortcuts.open()"
            aria-label="Search or jump"
          >
            <app-icon name="search" />Search or jump <kbd>/</kbd>
          </button>
        }
        @if (pageActions.export(); as exportAction) {
          <app-snapshot-action
            [source]="exportAction.source"
            [filters]="exportAction.filters"
            [msProject]="exportAction.msProject === true"
            [compact]="slim"
          />
        }
        @if (canCreate()) {
          @if (slim) {
            <button
              mat-flat-button
              type="button"
              (click)="newItem()"
              aria-label="New item"
              title="New item (C)"
            >
              <app-icon name="plus" />
            </button>
          } @else {
            <button mat-flat-button type="button" (click)="newItem()">
              <app-icon name="plus" />New item
            </button>
          }
        }
      </ng-template>
      @if (!layout.folded()) {
        <div class="k-page-head head">
          <div>
            <div class="crumbs">
              <a routerLink="/">Projects</a> / {{ project.key ?? 'Private space' }}
            </div>
            <h1>{{ project.name }}</h1>
          </div>
          <span class="spacer"></span>
          <ng-container *ngTemplateOutlet="actions; context: { $implicit: false }" />
        </div>
      }
      @if (project.archivedAt) {
        <p class="k-alert warn archived" role="status">This project is archived and read-only.</p>
      }
      <div class="tabs-row">
        @if (layout.folded()) {
          <h1 class="slim-name" [title]="project.name">{{ project.name }}</h1>
        }
        <nav mat-tab-nav-bar mat-stretch-tabs="false" [tabPanel]="panel" aria-label="Project views">
          @for (tab of tabs; track tab.path) {
            @if (!tab.projectOnly || project.ownerId === null) {
              <a
                mat-tab-link
                [routerLink]="
                  tab.path === ''
                    ? ['/p', project.key ?? 'personal']
                    : ['/p', project.key ?? 'personal', tab.path]
                "
                [active]="activeTab() === tab.path"
                ><span class="tab">
                  @if (!layout.folded()) {
                    <app-icon [name]="tab.icon" />
                  }
                  {{ tab.label }}</span
                ></a
              >
            }
          }
          @if (ctx.has(adoPermission) && project.ownerId === null) {
            <a
              mat-tab-link
              [routerLink]="['/p', project.key, 'ado']"
              [active]="activeTab() === 'ado'"
              >ADO transfer</a
            >
          }
        </nav>
        <app-fold-controls [filterCount]="filterCount()" [hasTools]="hasTools()">
          @if (layout.folded()) {
            <ng-container *ngTemplateOutlet="actions; context: { $implicit: true }" />
          }
        </app-fold-controls>
      </div>
      <mat-tab-nav-panel #panel>
        <router-outlet />
      </mat-tab-nav-panel>
    } @else if (error() || ctx.lost()) {
      <div class="missing">
        <p class="k-alert" role="alert">{{ error() || ctx.lost() }}</p>
        <a routerLink="/">Back to your projects</a>
      </div>
    } @else {
      <div class="missing"><app-skeleton label="Loading the project" /></div>
    }
  `,
})
export class ProjectShellPage {
  /** The open view's page actions (Export…), shown in the header. */
  protected readonly pageActions = inject(PageActions);
  /** Transfer is project PM/Lead only; snapshots use their own control. */
  protected readonly adoPermission = ProjectPermission.EXPORT_ADO;
  /** Lazy command palette shared with the app shell. */
  protected readonly shortcuts = inject(Shortcuts);
  /** Folded header and toolbar with peeking (v1.4.0), shared with My work. */
  private readonly fold = inject(FoldHost);
  /** The remembered fold choice. */
  protected readonly layout = this.fold.layout;
  /** Whether the open view has a toolbar that folds. */
  protected readonly hasTools = computed(() => this.pageActions.export()?.tools === true);
  /** Filters narrowing the open view, for the folded row's chip. */
  protected readonly filterCount = computed(() => this.pageActions.export()?.activeFilters ?? 0);
  /** Shared state of the project, provided here for the pages below. */
  protected readonly ctx = inject(ProjectContext);
  private readonly items = inject(ItemsApiService);
  private readonly dialog = inject(MatDialog);
  private readonly toast = inject(ToastService);

  /** Project key from the route (`/p/:key`). */
  readonly key = input.required<string>();

  /** Load error, e.g. for projects the caller is not a member of. */
  protected readonly error = signal('');

  /** Tabs in display order; `''` is the board. */
  protected readonly tabs: {
    path: string;
    label: string;
    icon: IconName;
    projectOnly?: boolean;
  }[] = [
    { path: '', label: 'Board', icon: 'board' },
    { path: 'backlog', label: 'Backlog', icon: 'backlog' },
    { path: 'timeline', label: 'Timeline', icon: 'timeline', projectOnly: true },
    { path: 'calendar', label: 'Calendar', icon: 'calendar' },
    { path: 'sprints', label: 'Sprints', icon: 'sprints' },
    { path: 'reports', label: 'Reports', icon: 'chart' },
    { path: 'settings', label: 'Settings', icon: 'settings' },
  ];

  private readonly router = inject(Router);
  /** The router URL, updated after every navigation. */
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /**
   * The current tab: the first path segment after `/p/:key`, or `''` for the
   * board (including `/p/:key/items/:number`).
   */
  protected readonly activeTab = computed(() => {
    const segment = this.url().split(/[?#]/)[0]?.split('/')[3] ?? '';
    if (segment === 'ado') return 'ado';
    return this.tabs.some((t) => t.path === segment) ? segment : '';
  });

  /** "New item" is offered with `CREATE_ITEMS` on an unarchived project. */
  protected readonly canCreate = computed(
    () => this.ctx.writable() && this.ctx.has(ProjectPermission.CREATE_ITEMS),
  );

  /**
   * Opens the project whenever the key in the URL changes, and folds a
   * peeking toolbar again after navigating.
   */
  constructor() {
    effect(() => {
      this.url();
      untracked(() => this.fold.peek.set(false));
    });
    // Others' header hover cards say which page the caller is on (DESIGN §9.1).
    effect(() => {
      const tab = this.activeTab() || 'board';
      const view = Object.hasOwn(PRESENCE_VIEWS, tab) ? (tab as PresenceView) : null;
      untracked(() => this.ctx.setPage(view));
    });
    inject(DestroyRef).onDestroy(() => this.ctx.setPage(null));
    inject(Shortcuts).register((key) => {
      if (key !== 'c' || !this.canCreate() || document.querySelector('.d-panel')) return false;
      void this.newItem();
      return true;
    }, inject(DestroyRef));
    let previous: string | undefined;
    effect(() => {
      const key = this.key();
      this.error.set('');
      // The pages load their lists when they open; when the shell is reused
      // for another project they stay open, so the lists are reloaded here.
      const switched = previous !== undefined && previous !== key;
      previous = key;
      this.ctx
        .open(key)
        .then(() => (switched ? this.ctx.refresh() : undefined))
        .catch((error: unknown) => this.error.set(errorMessage(error)));
    });
  }

  /**
   * "Go to" from a person's header hover card (DESIGN §9.1): the page shows
   * the item (board and backlog scroll and flash it, the timeline selects
   * its row) and the drawer opens unless the page keeps it closed. An item
   * the page's filters hide still opens, with a note saying so.
   *
   * @param entry The person's presence.
   * @returns Resolves once navigated.
   */
  protected async goTo(entry: PresenceEntryDto): Promise<void> {
    const key = this.ctx.project()?.key;
    const item = entry.itemId === null ? undefined : this.ctx.itemsById().get(entry.itemId);
    if (!key || item === undefined) return;
    const result = this.ctx.locate(item.id);
    if (result === 'done') return;
    if (result === 'hidden') this.toast.show('Hidden by your filters on this view');
    const tab = this.activeTab();
    const path = drawerPath(key, tab, item.number);
    // Filters stay only when the drawer opens beside the same page.
    const samePage = tab === '' || path.includes(tab);
    await this.router.navigate(path, samePage ? { queryParamsHandling: 'preserve' } : {});
  }

  /**
   * Asks for a new item's type, title and bucket (and optionally parent,
   * sprint and dates), creates it and opens it in the drawer beside the board.
   *
   * @returns Resolves once created and opened.
   */
  protected async newItem(): Promise<void> {
    const project = this.ctx.project();
    if (project === null) return;
    const ref = this.dialog.open<NewItemDialog, NewItemData, CreateItemRequest | null>(
      NewItemDialog,
      {
        data: {
          buckets: this.ctx.buckets(),
          parents: this.ctx
            .items()
            .filter((i) => i.type !== ItemType.TASK && i.type !== ItemType.BUG)
            .map((i) => ({ id: i.id, key: i.key, title: i.title, type: i.type })),
          sprints: this.ctx.sprints().filter((s) => s.state !== SprintState.CLOSED),
          defaultBucketId: project.settings.newItemBucketId,
        },
        width: 'var(--k-size-460px)',
        maxWidth: 'calc(100vw - var(--k-space-8))',
        enterAnimationDuration: dialogMotion(),
        exitAnimationDuration: dialogMotion(),
      },
    );
    const request = await firstValueFrom(ref.afterClosed());
    if (!request) return;
    try {
      const item = await this.items.create(project.id, request);
      this.ctx.upsert(item);
      this.toast.show(`${item.key} created`);
      await this.router.navigate(
        drawerPath(project.key ?? 'personal', this.activeTab(), item.number),
      );
    } catch (error) {
      this.toast.error(error);
    }
  }
}
