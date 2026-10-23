import { UserPicker } from '../../ui/user-picker';
import { Component, computed, inject, input, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Router, RouterLink } from '@angular/router';
import { NgTemplateOutlet } from '@angular/common';
import { phoneLayout, RowCardStyles } from '../../ui/row-cards';
import { MatTabsModule } from '@angular/material/tabs';
import {
  assignsPmsOnly,
  type BucketDto,
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
import { Dialogs } from '../../ui/dialogs';
import { ROLE_LABELS, VISIBILITY_LABELS } from '../../core/labels';
import { ItemsApiService } from '../../core/items-api.service';
import { ProjectContext } from '../../core/project-context';
import { ProjectsApiService } from '../../core/projects-api.service';
import { ProjectsNav } from '../../core/projects-nav';
import { Skeleton } from '../../ui/feedback';
import { SessionStore } from '../../core/session.store';
import { required } from '../../core/validators';
import { ProjectBoardSettings } from './project-board-settings';
import { ProjectTeamsComponent } from './project-teams';

/**
 * Project settings (SPEC §6): general settings and archiving, members with
 * their role and visibility, and optional teams.
 *
 * Every member can open it read-only; editing controls appear only when
 * `myPermissions` includes `MANAGE_PROJECT` or `MANAGE_MEMBERS` (PM). Admins
 * who are not PMs get controls to grant and remove the PM role only. The API
 * enforces the same rules and answers 404 to non-members.
 *
 * Members with the `BUCKETS` scope get a bucket picker. The board settings
 * (buckets, labels, the status → bucket map) follow; buckets and labels need
 * `MANAGE_BOARD` (PM, Lead).
 */
@Component({
  selector: 'app-project-settings',
  host: { class: 'k-page' },
  imports: [
    NgTemplateOutlet,
    RowCardStyles,
    MatTabsModule,
    RouterLink,
    UserPicker,
    ReactiveFormsModule,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    ProjectTeamsComponent,
    ProjectBoardSettings,
    Skeleton,
  ],
  template: `
    @if (!project() && !error()) {
      <app-skeleton label="Loading the settings" />
    }

    @if (error()) {
      <p class="k-alert" role="alert">{{ error() }}</p>
    }

    @if (project(); as project) {
      <app-row-card-styles />
      <ng-template #memberRole let-m>
        @if (canEditMembers()) {
          <mat-select
            [aria-label]="'Role of ' + m.displayName"
            [value]="m.role"
            (valueChange)="updateMember(m, { role: $event })"
          >
            @for (r of roles; track r) {
              <mat-option [value]="r">{{ roleLabels[r] }}</mat-option>
            }
          </mat-select>
        } @else {
          {{ roleName(m) }}
        }
      </ng-template>
      <ng-template #memberVisibility let-m>
        @if (canEditMembers()) {
          @if (isScoped(m)) {
            <mat-select
              [aria-label]="'Visibility of ' + m.displayName"
              [value]="m.visibility"
              (valueChange)="updateMember(m, { visibility: $event })"
            >
              <mat-option [value]="visibility.ALL">{{ visibilityLabels.ALL }}</mat-option>
              <mat-option [value]="visibility.OWN">{{ visibilityLabels.OWN }}</mat-option>
              <mat-option [value]="visibility.TEAMS">{{ visibilityLabels.TEAMS }}</mat-option>
              <mat-option [value]="visibility.BUCKETS">{{ visibilityLabels.BUCKETS }}</mat-option>
            </mat-select>
            @if (m.visibility === visibility.BUCKETS) {
              <mat-select
                multiple
                placeholder="Choose buckets"
                [aria-label]="'Buckets visible to ' + m.displayName"
                [value]="m.allowedBucketIds"
                (valueChange)="pendingBuckets.set(m.userId, $event)"
                (openedChange)="$event || saveBuckets(m)"
              >
                @for (b of buckets(); track b.id) {
                  <mat-option [value]="b.id">{{ b.name }}</mat-option>
                }
              </mat-select>
            }
          } @else {
            {{ visibilityLabels.ALL }}
          }
        } @else {
          {{ isScoped(m) ? visibilityName(m) : visibilityLabels.ALL }}
          @if (isScoped(m) && m.visibility === visibility.BUCKETS) {
            ({{ bucketNames(m) }})
          }
        }
      </ng-template>
      <ng-template #memberActions let-m>
        @if (canEditMembers()) {
          <button mat-button type="button" (click)="removeMember(m)">Remove</button>
        } @else {
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
              <button mat-button type="button" (click)="updateMember(m, { role: projectRole.PM })">
                Make PM
              </button>
            }
          }
        }
      </ng-template>
      <nav
        mat-tab-nav-bar
        mat-stretch-tabs="false"
        [tabPanel]="settingsPanel"
        aria-label="Settings sections"
      >
        @for (tab of tabs(); track tab.id) {
          <a
            mat-tab-link
            [routerLink]="['/p', project.key ?? 'personal', 'settings', tab.id]"
            [active]="current() === tab.id"
            >{{ tab.label }}</a
          >
        }
      </nav>
      <mat-tab-nav-panel #settingsPanel>
        @if (current() === 'general') {
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
                  @if (project.ownerId === null) {
                    <mat-checkbox formControlName="membersCanAssignOthers">
                      Members can assign items to others
                    </mat-checkbox>
                  }

                  <button
                    mat-flat-button
                    type="submit"
                    [disabled]="generalForm.invalid || !!project.archivedAt"
                  >
                    Save
                  </button>
                  @if (project.ownerId === null) {
                    <button mat-button type="button" (click)="toggleArchived(project)">
                      {{ project.archivedAt ? 'Unarchive' : 'Archive' }}
                    </button>
                  }
                </form>
              } @else {
                <p>{{ project.description || 'No description.' }}</p>
                <p>
                  Members {{ project.settings.membersCanAssignOthers ? 'can' : 'cannot' }} assign
                  items to others.
                </p>
              }
            </mat-card-content>
          </mat-card>
        }

        @if (project.ownerId === null && current() === 'members') {
          <mat-card>
            <mat-card-header><mat-card-title>Members</mat-card-title></mat-card-header>
            <mat-card-content>
              @if (canAddMembers()) {
                <div class="row">
                  <app-user-picker
                    label="User"
                    [searchUsers]="findCandidates"
                    [(selected)]="selectedCandidate"
                    (selectedChange)="newUserId.set($event[0]?.id ?? '')"
                  />
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

              @if (phone()) {
                <ul class="k-row-cards" aria-label="Members">
                  @for (m of members(); track m.id) {
                    <li class="k-row-card">
                      <div class="k-row-card-title">
                        {{ m.displayName }}{{ m.isActive ? '' : ' (deactivated)' }}
                      </div>
                      <dl>
                        <dt>Email</dt>
                        <dd>{{ m.email }}</dd>
                        <dt>Role</dt>
                        <dd>
                          <ng-container *ngTemplateOutlet="memberRole; context: { $implicit: m }" />
                        </dd>
                        <dt>Visibility</dt>
                        <dd>
                          <ng-container
                            *ngTemplateOutlet="memberVisibility; context: { $implicit: m }"
                          />
                        </dd>
                      </dl>
                      <div class="k-row-card-actions">
                        <ng-container
                          *ngTemplateOutlet="memberActions; context: { $implicit: m }"
                        />
                      </div>
                    </li>
                  }
                </ul>
              } @else {
                <div
                  class="k-table-scroll"
                  tabindex="0"
                  role="region"
                  aria-label="Scrollable table"
                >
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
                          <td>
                            <ng-container
                              *ngTemplateOutlet="memberRole; context: { $implicit: m }"
                            />
                          </td>
                          <td>
                            <ng-container
                              *ngTemplateOutlet="memberVisibility; context: { $implicit: m }"
                            />
                          </td>
                          <td class="actions">
                            <ng-container
                              *ngTemplateOutlet="memberActions; context: { $implicit: m }"
                            />
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
            </mat-card-content>
          </mat-card>
        }
        @if (project.ownerId === null && current() === 'teams') {
          <app-project-teams
            [projectId]="project.id"
            [members]="members()"
            [canEdit]="canEditMembers()"
          />
        }

        @if (current() === 'buckets' || current() === 'labels') {
          <app-project-board-settings
            [section]="current() === 'labels' ? 'labels' : 'board'"
            [project]="project"
            [(buckets)]="buckets"
            (bucketsChange)="ctx?.buckets.set($event)"
            [canManageBoard]="canManageBoard()"
            [canManageProject]="canManageProject() && !project.archivedAt"
            (projectChange)="boardSettingsSaved($event)"
          />
        }
      </mat-tab-nav-panel>
    }
  `,
})
export class ProjectSettingsPage implements OnInit {
  private readonly api = inject(ProjectsApiService);
  private readonly nav = inject(ProjectsNav);
  private readonly dialogs = inject(Dialogs);
  private readonly router = inject(Router);
  private readonly store = inject(SessionStore);
  private readonly itemsApi = inject(ItemsApiService);
  /** The project shell's shared state, kept in step with changes made here. */
  protected readonly ctx = inject(ProjectContext, { optional: true });

  /** Project key from the route (`/p/:key/settings/:section`). */
  readonly key = input.required<string>();
  /** Settings tab from the route; unknown or hidden tabs show General (M8.5). */
  readonly section = input<string>('general');
  /**
   * A member's role in words (member templates are untyped).
   *
   * @param m The member.
   * @returns E.g. "Project Manager".
   */
  protected roleName(m: ProjectMemberDto): string {
    return this.roleLabels[m.role];
  }

  /**
   * A member's visibility in words.
   *
   * @param m The member.
   * @returns E.g. "Own items".
   */
  protected visibilityName(m: ProjectMemberDto): string {
    return this.visibilityLabels[m.visibility];
  }

  /** True at phone width, where member rows become cards. */
  protected readonly phone = phoneLayout();

  /** Tabs this space offers: members and teams only in ordinary projects. */
  protected readonly tabs = computed(() => {
    const shared = this.project()?.ownerId === null;
    return [
      { id: 'general', label: 'General' },
      ...(shared
        ? [
            { id: 'members', label: 'Members' },
            { id: 'teams', label: 'Teams' },
          ]
        : []),
      { id: 'buckets', label: 'Buckets' },
      { id: 'labels', label: 'Labels' },
    ];
  });
  /** The tab shown. */
  protected readonly current = computed(() => {
    const section = this.section();
    return this.tabs().some((t) => t.id === section) ? section : 'general';
  });

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
  /** Bucket lists picked for members but not yet saved, by user id. */
  protected readonly pendingBuckets = new Map<string, string[]>();
  /** Buckets in column order, for the `BUCKETS` scope picker and board settings. */
  protected readonly buckets = signal<BucketDto[]>([]);
  /** Users found by the add-member search. */
  protected readonly selectedCandidate = signal<MemberCandidateDto[]>([]);
  /** Scoped active non-member search; administrators retain their existing candidate API.
   * @param q Search text.
   * @returns Authorized candidates.
   */
  protected readonly findCandidates = async (q: string): Promise<MemberCandidateDto[]> => {
    const project = this.project();
    return project ? this.api.candidates(project.id, q) : [];
  };
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
  /** True when buckets and labels are editable: `MANAGE_BOARD` on an unarchived project. */
  protected readonly canManageBoard = computed(
    () => this.has(ProjectPermission.MANAGE_BOARD) && !this.project()?.archivedAt,
  );
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
      // The project shell has usually loaded the project already; another
      // request would mean another audit entry for non-member admins.
      const known = this.ctx?.project();
      const project =
        known !== null &&
        known !== undefined &&
        (known.key === this.key() || (known.ownerId !== null && this.key() === 'personal'))
          ? known
          : await this.api.get(this.key());
      this.setProject(project);
      const [buckets] = await Promise.all([
        this.itemsApi.buckets(project.id),
        project.ownerId !== null ? Promise.resolve() : this.loadMembers(project.id),
      ]);
      this.buckets.set(buckets);
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
   * Names the buckets a member with the `BUCKETS` scope sees.
   *
   * @param member The member.
   * @returns Comma-separated bucket names.
   */
  protected bucketNames(member: ProjectMemberDto): string {
    const names = member.allowedBucketIds
      .map((id) => this.buckets().find((b) => b.id === id)?.name)
      .filter((name) => name !== undefined);
    return names.length > 0 ? names.join(', ') : 'none';
  }

  /**
   * Saves the buckets picked for a member once the picker closes, so one
   * request carries the whole selection.
   *
   * @param member The member.
   * @returns Resolves once saved.
   */
  protected async saveBuckets(member: ProjectMemberDto): Promise<void> {
    const picked = this.pendingBuckets.get(member.userId);
    this.pendingBuckets.delete(member.userId);
    if (picked === undefined) return;
    await this.updateMember(member, { allowedBucketIds: picked });
  }

  /**
   * Takes the project after the board settings changed it, and reloads the
   * members: deleting a bucket also removes it from their bucket lists.
   *
   * @param project The updated project.
   * @returns Resolves once reloaded.
   */
  protected async boardSettingsSaved(project: ProjectDto): Promise<void> {
    this.setProject(project);
    await this.run(() => this.loadMembers(project.id));
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
      const saved = await this.api.update(project.id, {
        name,
        description,
        ...(project.ownerId !== null ? {} : { settings: { membersCanAssignOthers } }),
      });
      // Saved: the form shows the stored values again.
      this.generalForm.markAsPristine();
      this.setProject(saved);
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
    if (
      archive &&
      !(await this.dialogs.confirm({
        title: `Archive ${project.key}?`,
        message: 'It becomes read-only for everyone until a PM unarchives it.',
        confirm: 'Archive',
      }))
    )
      return;
    await this.run(async () => {
      this.setProject(await this.api.setArchived(project.id, archive));
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
      this.selectedCandidate.set([]);
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
    if (project === null) return;
    const confirmed = await this.dialogs.confirm({
      title: `Remove ${member.displayName} from ${project.key}?`,
      message: 'They lose access to the project, its teams and their assignments in it.',
      confirm: 'Remove',
      danger: true,
    });
    if (!confirmed) return;
    await this.run(async () => {
      await this.api.removeMember(project.id, member.userId);
      this.members.update((members) => members.filter((m) => m.id !== member.id));
      // After leaving the project it is no longer visible to you.
      if (member.userId === this.store.user()?.id) await this.router.navigate(['/']);
    });
  }

  /**
   * Replaces the member list with every member, following pagination: the
   * teams section needs all of them to choose from.
   *
   * @param projectId Project id.
   * @returns Resolves once loaded.
   */
  private async loadMembers(projectId: string): Promise<void> {
    const all: ProjectMemberDto[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.api.members(projectId, cursor);
      all.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    this.members.set(all);
  }

  /**
   * Stores the project and refreshes the general form from it.
   *
   * @param project The project.
   */
  protected setProject(project: ProjectDto): void {
    this.project.set(project);
    this.ctx?.project.set(project);
    // Name or archive state may have changed: refresh the sidebar's list.
    void this.nav.refresh();
    // Keep the user's unsaved edits when the project is refreshed for
    // another reason (e.g. a bucket was deleted below).
    if (!this.generalForm.pristine) return;
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
