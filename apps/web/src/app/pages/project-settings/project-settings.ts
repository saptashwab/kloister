import { Component, computed, inject, input, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Router } from '@angular/router';
import {
  assignsPmsOnly,
  isScopedRole,
  type MemberCandidateDto,
  PROJECT_DESCRIPTION_MAX,
  PROJECT_NAME_MAX,
  type ProjectDto,
  type ProjectMemberDto,
  ProjectPermission,
  ProjectRole,
  type UpdateMemberRequest,
  Visibility,
} from '@kloister/shared';
import { errorMessage } from '../../core/api';
import { ROLE_LABELS, VISIBILITY_LABELS } from '../../core/labels';
import { ProjectsApiService } from '../../core/projects-api.service';
import { SessionStore } from '../../core/session.store';
import { required } from '../../core/validators';

/**
 * Project settings (SPEC §6): general settings and archiving, and members
 * with their role and visibility.
 *
 * Every member can open it read-only; editing controls appear only when
 * `myPermissions` includes `MANAGE_PROJECT` or `MANAGE_MEMBERS` (PM). Admins
 * who are not PMs get controls to grant and remove the PM role only. The API
 * enforces the same rules and answers 404 to non-members.
 *
 * Bucket selection for the `BUCKETS` scope arrives with buckets (M3/M4);
 * until then only `ALL` and `OWN` can be chosen here.
 */
@Component({
  selector: 'app-project-settings',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  template: `
    @if (project(); as project) {
      <h2>{{ project.key }} · {{ project.name }}</h2>
      @if (project.archivedAt) {
        <p role="status">This project is archived and read-only.</p>
      }
    } @else if (!error()) {
      <p>Loading…</p>
    }

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    @if (project(); as project) {
      <mat-card>
        <mat-card-header><mat-card-title>General</mat-card-title></mat-card-header>
        <mat-card-content>
          @if (canManageProject()) {
            <form class="row" [formGroup]="generalForm" (ngSubmit)="saveGeneral()">
              <mat-form-field>
                <mat-label>Name</mat-label>
                <input matInput formControlName="name" />
              </mat-form-field>
              <mat-form-field>
                <mat-label>Description</mat-label>
                <textarea matInput formControlName="description"></textarea>
              </mat-form-field>
              <mat-checkbox formControlName="membersCanAssignOthers">
                Members can assign items to others
              </mat-checkbox>
              <button
                mat-flat-button
                type="submit"
                [disabled]="generalForm.invalid || !!project.archivedAt"
              >
                Save
              </button>
              <button mat-button type="button" (click)="toggleArchived(project)">
                {{ project.archivedAt ? 'Unarchive' : 'Archive' }}
              </button>
            </form>
          } @else {
            <p>{{ project.description || 'No description.' }}</p>
            <p>
              Members {{ project.settings.membersCanAssignOthers ? 'can' : 'cannot' }} assign items
              to others.
            </p>
          }
        </mat-card-content>
      </mat-card>

      <mat-card>
        <mat-card-header><mat-card-title>Members</mat-card-title></mat-card-header>
        <mat-card-content>
          @if (canAddMembers()) {
            <div class="row">
              <mat-form-field>
                <mat-label>Find user</mat-label>
                <input matInput #search (keyup.enter)="searchCandidates(search.value)" />
              </mat-form-field>
              <button mat-button type="button" (click)="searchCandidates(search.value)">
                Search
              </button>
              <mat-form-field>
                <mat-label>User</mat-label>
                <mat-select [value]="newUserId()" (valueChange)="newUserId.set($event)">
                  @for (c of candidates(); track c.id) {
                    <mat-option [value]="c.id">{{ c.displayName }} ({{ c.email }})</mat-option>
                  }
                </mat-select>
              </mat-form-field>
              @if (pmOnly()) {
                <button
                  mat-flat-button
                  type="button"
                  [disabled]="!newUserId()"
                  (click)="addMember()"
                >
                  Add as Project Manager
                </button>
              } @else {
                <mat-form-field>
                  <mat-label>Role</mat-label>
                  <mat-select [value]="newRole()" (valueChange)="newRole.set($event)">
                    @for (r of roles; track r) {
                      <mat-option [value]="r">{{ roleLabels[r] }}</mat-option>
                    }
                  </mat-select>
                </mat-form-field>
                <button
                  mat-flat-button
                  type="button"
                  [disabled]="!newUserId()"
                  (click)="addMember()"
                >
                  Add
                </button>
              }
            </div>
          }

          <table class="data">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Visibility</th>
                <th scope="col"><span class="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              @for (m of members(); track m.id) {
                <tr>
                  <td>{{ m.displayName }}{{ m.isActive ? '' : ' (deactivated)' }}</td>
                  <td>{{ m.email }}</td>
                  @if (canEditMembers()) {
                    <td>
                      <mat-select
                        [aria-label]="'Role of ' + m.displayName"
                        [value]="m.role"
                        (valueChange)="updateMember(m, { role: $event })"
                      >
                        @for (r of roles; track r) {
                          <mat-option [value]="r">{{ roleLabels[r] }}</mat-option>
                        }
                      </mat-select>
                    </td>
                    <td>
                      @if (isScoped(m)) {
                        <mat-select
                          [aria-label]="'Visibility of ' + m.displayName"
                          [value]="m.visibility"
                          (valueChange)="updateMember(m, { visibility: $event })"
                        >
                          <mat-option [value]="visibility.ALL">{{
                            visibilityLabels.ALL
                          }}</mat-option>
                          <mat-option [value]="visibility.OWN">{{
                            visibilityLabels.OWN
                          }}</mat-option>
                          @if (m.visibility === visibility.BUCKETS) {
                            <mat-option [value]="visibility.BUCKETS" disabled>{{
                              visibilityLabels.BUCKETS
                            }}</mat-option>
                          }
                        </mat-select>
                      } @else {
                        {{ visibilityLabels.ALL }}
                      }
                    </td>
                    <td class="actions">
                      <button mat-button type="button" (click)="removeMember(m)">Remove</button>
                    </td>
                  } @else {
                    <td>{{ roleLabels[m.role] }}</td>
                    <td>
                      {{ isScoped(m) ? visibilityLabels[m.visibility] : visibilityLabels.ALL }}
                    </td>
                    <td class="actions">
                      @if (pmOnly()) {
                        @if (m.role === projectRole.PM) {
                          <button
                            mat-button
                            type="button"
                            (click)="updateMember(m, { role: projectRole.MEMBER })"
                          >
                            Remove PM role
                          </button>
                          <button mat-button type="button" (click)="removeMember(m)">Remove</button>
                        } @else {
                          <button
                            mat-button
                            type="button"
                            (click)="updateMember(m, { role: projectRole.PM })"
                          >
                            Make PM
                          </button>
                        }
                      }
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
          @if (membersCursor()) {
            <button mat-button type="button" (click)="loadMoreMembers()">Load more</button>
          }
        </mat-card-content>
      </mat-card>
    }
  `,
})
export class ProjectSettingsPage implements OnInit {
  private readonly api = inject(ProjectsApiService);
  private readonly router = inject(Router);
  private readonly store = inject(SessionStore);

  /** Project key from the route (`/p/:key/settings`). */
  readonly key = input.required<string>();

  /** Role values for the template. */
  protected readonly roles = Object.values(ProjectRole);
  /** Role constants for the template. */
  protected readonly projectRole = ProjectRole;
  /** Role names for the template. */
  protected readonly roleLabels = ROLE_LABELS;
  /** Visibility values for the template. */
  protected readonly visibility = Visibility;
  /** Visibility names for the template. */
  protected readonly visibilityLabels = VISIBILITY_LABELS;

  /** The loaded project. */
  protected readonly project = signal<ProjectDto | null>(null);
  /** Loaded members. */
  protected readonly members = signal<ProjectMemberDto[]>([]);
  /** Cursor for the next page of members, or null. */
  protected readonly membersCursor = signal<string | null>(null);
  /** Users found by the add-member search. */
  protected readonly candidates = signal<MemberCandidateDto[]>([]);
  /** User chosen to add. */
  protected readonly newUserId = signal('');
  /** Role for the user being added. */
  protected readonly newRole = signal<ProjectRole>(ProjectRole.MEMBER);
  /** Last error message, if any. */
  protected readonly error = signal('');

  /** True when the caller may edit settings and archive (PM). */
  protected readonly canManageProject = computed(() => this.has(ProjectPermission.MANAGE_PROJECT));
  /** True when the caller may manage members (PM). */
  protected readonly canManageMembers = computed(() => this.has(ProjectPermission.MANAGE_MEMBERS));
  /** True when member rows are editable: PM on an unarchived project. */
  protected readonly canEditMembers = computed(
    () => this.canManageMembers() && !this.project()?.archivedAt,
  );
  /**
   * True for admins who are not PMs: they may only grant and remove the PM
   * role (SPEC §3.1), archived projects included.
   */
  protected readonly pmOnly = computed(() => assignsPmsOnly(this.project()?.myPermissions ?? []));
  /** True when the add-member controls are shown. */
  protected readonly canAddMembers = computed(() => this.canEditMembers() || this.pmOnly());

  /** General settings form (PM only). */
  protected readonly generalForm = inject(NonNullableFormBuilder).group({
    name: ['', [required, Validators.maxLength(PROJECT_NAME_MAX)]],
    description: ['', [Validators.maxLength(PROJECT_DESCRIPTION_MAX)]],
    membersCanAssignOthers: [false],
  });

  /**
   * Loads the project and its first page of members.
   */
  ngOnInit(): void {
    void this.run(async () => {
      const project = await this.api.get(this.key());
      this.setProject(project);
      await this.loadMembers(project.id);
    });
  }

  /**
   * Reports whether a member's visibility scope applies (Member and Viewer).
   *
   * @param member The member.
   * @returns True for scoped roles.
   */
  protected isScoped(member: ProjectMemberDto): boolean {
    return isScopedRole(member.role);
  }

  /**
   * Saves the general settings.
   *
   * @returns Resolves once saved.
   */
  protected async saveGeneral(): Promise<void> {
    const project = this.project();
    if (project === null) return;
    const { name, description, membersCanAssignOthers } = this.generalForm.getRawValue();
    await this.run(async () => {
      this.setProject(
        await this.api.update(project.id, {
          name,
          description,
          settings: { membersCanAssignOthers },
        }),
      );
    });
  }

  /**
   * Archives or unarchives the project after confirmation.
   *
   * @param project The project.
   * @returns Resolves once done.
   */
  protected async toggleArchived(project: ProjectDto): Promise<void> {
    const archive = project.archivedAt === null;
    if (archive && !confirm(`Archive ${project.key}? It becomes read-only for everyone.`)) return;
    await this.run(async () => {
      this.setProject(await this.api.setArchived(project.id, archive));
    });
  }

  /**
   * Appends the next page of members.
   *
   * @returns Resolves once loaded.
   */
  protected async loadMoreMembers(): Promise<void> {
    const project = this.project();
    const cursor = this.membersCursor();
    if (project === null || cursor === null) return;
    await this.run(async () => {
      const page = await this.api.members(project.id, cursor);
      this.members.update((members) => [...members, ...page.items]);
      this.membersCursor.set(page.nextCursor);
    });
  }

  /**
   * Searches users who can be added.
   *
   * @param q Search text.
   * @returns Resolves once loaded.
   */
  protected async searchCandidates(q: string): Promise<void> {
    const project = this.project();
    if (project === null) return;
    await this.run(async () => {
      this.candidates.set(await this.api.candidates(project.id, q.trim()));
      this.newUserId.set('');
    });
  }

  /**
   * Adds the chosen user with the chosen role.
   *
   * @returns Resolves once added.
   */
  protected async addMember(): Promise<void> {
    const project = this.project();
    const userId = this.newUserId();
    if (project === null || userId === '') return;
    await this.run(async () => {
      const role = this.pmOnly() ? ProjectRole.PM : this.newRole();
      const member = await this.api.addMember(project.id, { userId, role });
      this.members.update((members) => [...members, member]);
      this.candidates.update((list) => list.filter((c) => c.id !== userId));
      this.newUserId.set('');
      // Adding yourself (an admin taking the PM role) changes what you may do.
      if (userId === this.store.user()?.id) this.setProject(await this.api.get(project.id));
    });
  }

  /**
   * Changes a member's role or visibility. On failure (e.g. demoting the
   * last PM) the rows are rebuilt from the server so the selects show the
   * stored values again.
   *
   * @param member The member.
   * @param change Fields to change.
   * @returns Resolves once done.
   */
  protected async updateMember(
    member: ProjectMemberDto,
    change: UpdateMemberRequest,
  ): Promise<void> {
    const project = this.project();
    if (project === null) return;
    const ok = await this.run(async () => {
      const updated = await this.api.updateMember(project.id, member.userId, change);
      this.members.update((members) => members.map((m) => (m.id === updated.id ? updated : m)));
      // Changing your own role changes what you may do here.
      if (updated.userId === this.store.user()?.id) {
        this.setProject(await this.api.get(project.id));
      }
    });
    if (!ok) {
      const message = this.error();
      this.members.set([]);
      await this.loadMembers(project.id);
      this.error.set(message);
    }
  }

  /**
   * Removes a member after confirmation.
   *
   * @param member The member.
   * @returns Resolves once done.
   */
  protected async removeMember(member: ProjectMemberDto): Promise<void> {
    const project = this.project();
    if (project === null || !confirm(`Remove ${member.displayName} from ${project.key}?`)) return;
    await this.run(async () => {
      await this.api.removeMember(project.id, member.userId);
      this.members.update((members) => members.filter((m) => m.id !== member.id));
      // After leaving the project it is no longer visible to you.
      if (member.userId === this.store.user()?.id) await this.router.navigate(['/']);
    });
  }

  /**
   * Replaces the member list with its first page.
   *
   * @param projectId Project id.
   * @returns Resolves once loaded.
   */
  private async loadMembers(projectId: string): Promise<void> {
    const page = await this.api.members(projectId);
    this.members.set(page.items);
    this.membersCursor.set(page.nextCursor);
  }

  /**
   * Stores the project and refreshes the general form from it.
   *
   * @param project The project.
   */
  private setProject(project: ProjectDto): void {
    this.project.set(project);
    this.generalForm.setValue({
      name: project.name,
      description: project.description,
      membersCanAssignOthers: project.settings.membersCanAssignOthers,
    });
  }

  /**
   * Reports whether the caller holds a project permission.
   *
   * @param permission The permission.
   * @returns True if granted.
   */
  private has(permission: ProjectPermission): boolean {
    return this.project()?.myPermissions.includes(permission) ?? false;
  }

  /**
   * Runs an action, showing any error instead of throwing.
   *
   * @param action The work to do.
   * @returns True if the action succeeded.
   */
  private async run(action: () => Promise<void>): Promise<boolean> {
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
