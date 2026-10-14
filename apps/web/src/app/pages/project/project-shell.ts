import { Component, computed, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatTabsModule } from '@angular/material/tabs';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { type CreateItemRequest, ProjectPermission } from '@kloister/shared';
import { filter, firstValueFrom, map } from 'rxjs';
import { errorMessage } from '../../core/api';
import { ItemsApiService } from '../../core/items-api.service';
import { ProjectContext } from '../../core/project-context';
import { Shortcuts } from '../../core/shortcuts';
import { Skeleton } from '../../ui/feedback';
import { Icon, type IconName } from '../../ui/icon';
import { ToastService } from '../../ui/toast.service';
import { dialogMotion } from '../../ui/motion';
import { NewItemDialog, type NewItemData } from './new-item-dialog';

/**
 * Frame of one project (`/p/:key/…`, DESIGN §7): breadcrumb, project name,
 * "New item", tabs for the board, backlog, sprints and settings, and the
 * page itself.
 *
 * It provides the {@link ProjectContext} its pages share. Every member (and
 * every admin) can open each tab; the pages hide controls the caller lacks
 * permissions for, and the API answers 404 to non-members.
 */
@Component({
  selector: 'app-project-shell',
  imports: [RouterOutlet, RouterLink, MatTabsModule, MatButtonModule, Icon, Skeleton],
  providers: [ProjectContext],
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
    nav {
      padding: 0 calc(var(--k-gutter) - var(--k-space-2));
      border-bottom: var(--k-line) solid var(--k-border);
      --mat-tab-header-divider-height: 0;
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
    @if (ctx.project(); as project) {
      <div class="k-page-head head">
        <div>
          <div class="crumbs"><a routerLink="/">Projects</a> / {{ project.key }}</div>
          <h1>{{ project.name }}</h1>
        </div>
        <span class="spacer"></span>
        <button type="button" class="k-chip" (click)="shortcuts.open()" aria-label="Search or jump">
          <app-icon name="search" />Search or jump <kbd>/</kbd>
        </button>
        @if (canCreate()) {
          <button mat-flat-button type="button" (click)="newItem()">
            <app-icon name="plus" />New item
          </button>
        }
      </div>
      @if (project.archivedAt) {
        <p class="k-alert warn archived" role="status">This project is archived and read-only.</p>
      }
      <nav mat-tab-nav-bar mat-stretch-tabs="false" [tabPanel]="panel" aria-label="Project views">
        @for (tab of tabs; track tab.path) {
          <a
            mat-tab-link
            [routerLink]="tab.path === '' ? ['/p', project.key] : ['/p', project.key, tab.path]"
            [active]="activeTab() === tab.path"
            ><span class="tab"><app-icon [name]="tab.icon" />{{ tab.label }}</span></a
          >
        }
      </nav>
      <mat-tab-nav-panel #panel>
        <router-outlet />
      </mat-tab-nav-panel>
    } @else if (error()) {
      <div class="missing">
        <p class="k-alert" role="alert">{{ error() }}</p>
        <a routerLink="/">Back to your projects</a>
      </div>
    } @else {
      <div class="missing"><app-skeleton label="Loading the project" /></div>
    }
  `,
})
export class ProjectShellPage {
  /** Lazy command palette shared with the app shell. */
  protected readonly shortcuts = inject(Shortcuts);
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
  protected readonly tabs: { path: string; label: string; icon: IconName }[] = [
    { path: '', label: 'Board', icon: 'board' },
    { path: 'backlog', label: 'Backlog', icon: 'backlog' },
    { path: 'sprints', label: 'Sprints', icon: 'sprints' },
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
    return this.tabs.some((t) => t.path === segment) ? segment : '';
  });

  /** "New item" is offered with `CREATE_ITEMS` on an unarchived project. */
  protected readonly canCreate = computed(
    () => this.ctx.writable() && this.ctx.has(ProjectPermission.CREATE_ITEMS),
  );

  /**
   * Opens the project whenever the key in the URL changes.
   */
  constructor() {
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
   * Asks for a new item's type, title and bucket, creates it and opens it in
   * the drawer beside the board.
   *
   * @returns Resolves once created and opened.
   */
  protected async newItem(): Promise<void> {
    const project = this.ctx.project();
    if (project === null) return;
    const ref = this.dialog.open<NewItemDialog, NewItemData, CreateItemRequest | null>(
      NewItemDialog,
      {
        data: { buckets: this.ctx.buckets() },
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
      const onBacklog = this.activeTab() === 'backlog';
      await this.router.navigate(
        onBacklog
          ? ['/p', project.key, 'backlog', 'items', item.number]
          : ['/p', project.key, 'items', item.number],
      );
    } catch (error) {
      this.toast.error(error);
    }
  }
}
