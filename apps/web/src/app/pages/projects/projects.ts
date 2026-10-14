import { Component, inject, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import {
  MAX_INITIAL_PMS,
  PROJECT_DESCRIPTION_MAX,
  PROJECT_KEY_PATTERN,
  PROJECT_NAME_MAX,
  type ProjectDto,
  type UserDto,
} from '@kloister/shared';
import { AdminApiService } from '../../core/admin-api.service';
import { errorMessage } from '../../core/api';
import { ROLE_LABELS } from '../../core/labels';
import { ProjectsApiService } from '../../core/projects-api.service';
import { ProjectsNav } from '../../core/projects-nav';
import { SessionStore } from '../../core/session.store';
import { required } from '../../core/validators';

import { EmptyState, Skeleton } from '../../ui/feedback';

/**
 * Projects list (SPEC §6), the landing page after sign-in.
 *
 * Everyone sees their own projects. Admins also get the "All projects" /
 * "My projects" toggle, which only filters this list (opening a project they
 * are not a member of is audited by the API), and a form to create a project
 * with one or more Project Managers (SPEC §3.1).
 */
@Component({
  selector: 'app-projects',
  host: { class: 'k-page' },
  imports: [
    EmptyState,
    Skeleton,
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatButtonToggleModule,
    MatCardModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  template: `
    <header class="k-page-head">
      <h1>Projects</h1>
      <span class="spacer"></span>
      @if (store.isAdmin()) {
        <mat-button-toggle-group
          class="k-segmented"
          aria-label="Which projects"
          hideSingleSelectionIndicator
          [value]="scope()"
          (change)="setScope($event.value)"
        >
          <mat-button-toggle value="mine">My projects</mat-button-toggle>
          <mat-button-toggle value="all">All projects</mat-button-toggle>
        </mat-button-toggle-group>
      }
      <mat-checkbox [checked]="includeArchived()" (change)="setIncludeArchived($event.checked)">
        Show archived
      </mat-checkbox>
    </header>

    @if (store.isAdmin()) {
      <mat-card>
        <mat-card-header><mat-card-title>New project</mat-card-title></mat-card-header>
        <mat-card-content>
          <form class="row" [formGroup]="createForm" (ngSubmit)="create()">
            <mat-form-field>
              <mat-label>Key</mat-label>
              <input matInput formControlName="key" maxlength="6" />
              <mat-hint>2–6 letters, e.g. KLO</mat-hint>
            </mat-form-field>
            <mat-form-field>
              <mat-label>Name</mat-label>
              <input matInput formControlName="name" />
            </mat-form-field>
            <mat-form-field>
              <mat-label>Description</mat-label>
              <input matInput formControlName="description" />
            </mat-form-field>
            <mat-form-field>
              <mat-label>Find Project Managers</mat-label>
              <input matInput #pmSearch (keyup.enter)="searchPm(pmSearch.value)" />
            </mat-form-field>
            <button mat-button type="button" (click)="searchPm(pmSearch.value)">Search</button>
            <mat-form-field>
              <mat-label>Project Managers</mat-label>
              <mat-select formControlName="pmUserIds" multiple>
                @for (user of pmOptions(); track user.id) {
                  <mat-option [value]="user.id"
                    >{{ user.displayName }} ({{ user.email }})</mat-option
                  >
                }
              </mat-select>
            </mat-form-field>
            <button mat-flat-button type="submit" [disabled]="createForm.invalid || busy()">
              Create
            </button>
          </form>
        </mat-card-content>
      </mat-card>
    }

    @if (error()) {
      <p class="k-alert" role="alert">{{ error() }}</p>
    }

    @if (loading()) {
      <app-skeleton label="Loading the list" />
    } @else {
      <div class="k-panel k-table-scroll" tabindex="0" role="region" aria-label="Scrollable table">
        <table class="data">
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Name</th>
              <th scope="col">Your role</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            @for (project of projects(); track project.id) {
              <tr>
                <td>
                  <a class="k-key" [routerLink]="['/p', project.key]">{{ project.key }}</a>
                </td>
                <td>{{ project.name }}</td>
                <td>{{ project.myRole ? roleLabels[project.myRole] : 'Not a member' }}</td>
                <td>{{ project.archivedAt ? 'Archived' : 'Active' }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="4">
                  <app-empty-state
                    [title]="
                      scope() === 'all'
                        ? 'No projects yet.'
                        : 'You are not a member of any project yet.'
                    "
                    text="An admin can create a project and add its project managers."
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
export class ProjectsPage implements OnInit {
  private readonly api = inject(ProjectsApiService);
  private readonly nav = inject(ProjectsNav);
  private readonly adminApi = inject(AdminApiService);
  /** Decides whether admin controls are shown. */
  protected readonly store = inject(SessionStore);

  /** Role names for the template. */
  protected readonly roleLabels = ROLE_LABELS;
  /** Loaded projects. */
  protected readonly projects = signal<ProjectDto[]>([]);
  /** Cursor for the next page, or null. */
  protected readonly nextCursor = signal<string | null>(null);
  /** `mine` or (admins only) `all`. */
  protected readonly scope = signal<'mine' | 'all'>('mine');
  /** Whether archived projects are listed. */
  protected readonly includeArchived = signal(false);
  /** Users found by the PM search. */
  protected readonly pmOptions = signal<UserDto[]>([]);
  /** Last error message, if any. */
  protected readonly error = signal('');
  /** True while the list is being replaced. */
  protected readonly loading = signal(true);
  /** True while a create request is in flight. */
  protected readonly busy = signal(false);

  /** New-project form (admins only). */
  protected readonly createForm = inject(NonNullableFormBuilder).group({
    key: ['', [required, Validators.pattern(/^[A-Za-z]{2,6}$/)]],
    name: ['', [required, Validators.maxLength(PROJECT_NAME_MAX)]],
    description: ['', [Validators.maxLength(PROJECT_DESCRIPTION_MAX)]],
    pmUserIds: [[] as string[], [required, Validators.maxLength(MAX_INITIAL_PMS)]],
  });

  /**
   * Loads the first page.
   */
  ngOnInit(): void {
    void this.reload();
  }

  /**
   * Switches between the caller's projects and all projects (admins).
   *
   * @param scope The new scope.
   * @returns Resolves once reloaded.
   */
  protected async setScope(scope: 'mine' | 'all'): Promise<void> {
    this.scope.set(scope);
    await this.reload();
  }

  /**
   * Shows or hides archived projects.
   *
   * @param include True to include archived projects.
   * @returns Resolves once reloaded.
   */
  protected async setIncludeArchived(include: boolean): Promise<void> {
    this.includeArchived.set(include);
    await this.reload();
  }

  /**
   * Appends the next page.
   *
   * @returns Resolves once loaded.
   */
  protected async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (cursor === null) return;
    await this.run(async () => {
      const page = await this.api.list({ ...this.filter(), cursor });
      this.projects.update((projects) => [...projects, ...page.items]);
      this.nextCursor.set(page.nextCursor);
    });
  }

  /**
   * Finds active users to choose the Project Managers from. Users already
   * chosen stay in the list so the selection survives a new search.
   *
   * @param q Search text.
   * @returns Resolves once loaded.
   */
  protected async searchPm(q: string): Promise<void> {
    await this.run(async () => {
      const page = await this.adminApi.listUsers(q.trim(), undefined);
      const chosen = new Set(this.createForm.controls.pmUserIds.value);
      const kept = this.pmOptions().filter((user) => chosen.has(user.id));
      const found = page.items.filter((user) => user.isActive && !chosen.has(user.id));
      this.pmOptions.set([...kept, ...found]);
    });
  }

  /**
   * Creates the project and lists it.
   *
   * @returns Resolves once done.
   */
  protected async create(): Promise<void> {
    const value = this.createForm.getRawValue();
    const key = value.key.toUpperCase();
    if (!PROJECT_KEY_PATTERN.test(key)) return;
    this.busy.set(true);
    await this.run(async () => {
      await this.api.create({ ...value, key });
      this.createForm.reset();
      await this.reload();
      void this.nav.refresh();
    });
    this.busy.set(false);
  }

  /**
   * Replaces the list with the first page for the current filters.
   *
   * @returns Resolves once loaded.
   */
  private async reload(): Promise<void> {
    this.loading.set(true);
    await this.run(async () => {
      const page = await this.api.list(this.filter());
      this.projects.set(page.items);
      this.nextCursor.set(page.nextCursor);
    });
    this.loading.set(false);
  }

  /**
   * Current list filters.
   *
   * @returns Scope and archived flag.
   */
  private filter(): { scope: 'mine' | 'all'; includeArchived: boolean } {
    return { scope: this.scope(), includeArchived: this.includeArchived() };
  }

  /**
   * Runs an action, showing any error instead of throwing.
   *
   * @param action The work to do.
   * @returns Resolves once the action settles.
   */
  private async run(action: () => Promise<void>): Promise<void> {
    this.error.set('');
    try {
      await action();
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }
}
