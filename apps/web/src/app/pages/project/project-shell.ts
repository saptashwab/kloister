import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatTabsModule } from '@angular/material/tabs';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { errorMessage } from '../../core/api';
import { ProjectContext } from '../../core/project-context';

/**
 * Frame of one project (`/p/:key/…`): the project name, tabs for the board,
 * backlog, sprints and settings, and the page itself.
 *
 * It provides the {@link ProjectContext} its pages share. Every member (and
 * every admin) can open each tab; the pages hide controls the caller lacks
 * permissions for, and the API answers 404 to non-members.
 */
@Component({
  selector: 'app-project-shell',
  imports: [RouterOutlet, RouterLink, MatTabsModule],
  providers: [ProjectContext],
  styles: `
    .title {
      margin: 0 0 4px;
      font-size: 1.25rem;
    }
  `,
  template: `
    @if (ctx.project(); as project) {
      <h2 class="title">{{ project.key }} · {{ project.name }}</h2>
      @if (project.archivedAt) {
        <p role="status">This project is archived and read-only.</p>
      }
      <nav mat-tab-nav-bar [tabPanel]="panel" aria-label="Project views">
        @for (tab of tabs; track tab.path) {
          <a
            mat-tab-link
            [routerLink]="tab.path === '' ? ['/p', project.key] : ['/p', project.key, tab.path]"
            [active]="activeTab() === tab.path"
            >{{ tab.label }}</a
          >
        }
      </nav>
      <mat-tab-nav-panel #panel>
        <router-outlet />
      </mat-tab-nav-panel>
    } @else if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    } @else {
      <p>Loading…</p>
    }
  `,
})
export class ProjectShellPage {
  /** Shared state of the project, provided here for the pages below. */
  protected readonly ctx = inject(ProjectContext);

  /** Project key from the route (`/p/:key`). */
  readonly key = input.required<string>();

  /** Load error, e.g. for projects the caller is not a member of. */
  protected readonly error = signal('');

  /** Tabs in display order; `''` is the board. */
  protected readonly tabs = [
    { path: '', label: 'Board' },
    { path: 'backlog', label: 'Backlog' },
    { path: 'sprints', label: 'Sprints' },
    { path: 'settings', label: 'Settings' },
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

  /**
   * Opens the project whenever the key in the URL changes.
   */
  constructor() {
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
}
