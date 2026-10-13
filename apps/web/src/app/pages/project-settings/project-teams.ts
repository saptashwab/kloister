import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import {
  ProjectRole,
  type ProjectMemberDto,
  TEAM_NAME_MAX,
  type TeamDto,
  TeamRole,
} from '@kloister/shared';
import { errorMessage } from '../../core/api';
import { TEAM_ROLE_LABELS } from '../../core/labels';
import { ProjectsApiService } from '../../core/projects-api.service';

/**
 * Optional project teams (SPEC §3.5) inside the project settings page.
 *
 * Everyone who can open the project sees the teams and their members. Only
 * PMs (`canEdit`) get controls to create, rename and delete teams and to set
 * who is in them; project Viewers are offered the team Member role only. The
 * API enforces the same rules.
 */
@Component({
  selector: 'app-project-teams',
  imports: [MatButtonModule, MatCardModule, MatFormFieldModule, MatInputModule, MatSelectModule],
  template: `
    <mat-card>
      <mat-card-header><mat-card-title>Teams</mat-card-title></mat-card-header>
      <mat-card-content>
        <p>
          Teams are optional. Team leads get Lead rights on their team's items; everyone else keeps
          their project role.
        </p>

        @if (error()) {
          <p class="error" role="alert">{{ error() }}</p>
        }

        @if (canEdit()) {
          <div class="row">
            <mat-form-field>
              <mat-label>New team name</mat-label>
              <input
                matInput
                #teamName
                [attr.maxlength]="nameMax"
                (keyup.enter)="createTeam(teamName)"
              />
            </mat-form-field>
            <button mat-button type="button" (click)="createTeam(teamName)">Create team</button>
          </div>

          @if (teams().length > 0) {
            <div class="row">
              <mat-form-field>
                <mat-label>Team</mat-label>
                <mat-select [value]="addTeamId()" (valueChange)="addTeamId.set($event)">
                  @for (t of teams(); track t.id) {
                    <mat-option [value]="t.id">{{ t.name }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
              <mat-form-field>
                <mat-label>Project member</mat-label>
                <mat-select [value]="addUserId()" (valueChange)="addUserId.set($event)">
                  @for (m of addableMembers(); track m.userId) {
                    <mat-option [value]="m.userId">{{ m.displayName }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
              <mat-form-field>
                <mat-label>Team role</mat-label>
                <mat-select [value]="addRole()" (valueChange)="addRole.set($event)">
                  @for (r of rolesFor(addUserId()); track r) {
                    <mat-option [value]="r">{{ roleLabels[r] }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
              <button
                mat-flat-button
                type="button"
                [disabled]="!addTeamId() || !addUserId()"
                (click)="addToTeam()"
              >
                Add to team
              </button>
            </div>
          }
        }

        @for (team of teams(); track team.id) {
          <section class="team">
            <h3>
              {{ team.name }}
              @if (canEdit()) {
                <button mat-button type="button" (click)="renameTeam(team)">Rename</button>
                <button mat-button type="button" (click)="deleteTeam(team)">Delete</button>
              }
            </h3>
            <table class="data">
              <tbody>
                @for (m of team.members; track m.userId) {
                  <tr>
                    <td>{{ m.displayName }}{{ m.isActive ? '' : ' (deactivated)' }}</td>
                    @if (canEdit()) {
                      <td>
                        <mat-select
                          [aria-label]="'Team role of ' + m.displayName"
                          [value]="m.role"
                          (valueChange)="setRole(team, m.userId, $event)"
                        >
                          @for (r of rolesFor(m.userId); track r) {
                            <mat-option [value]="r">{{ roleLabels[r] }}</mat-option>
                          }
                        </mat-select>
                      </td>
                      <td class="actions">
                        <button mat-button type="button" (click)="removeFromTeam(team, m.userId)">
                          Remove
                        </button>
                      </td>
                    } @else {
                      <td>{{ roleLabels[m.role] }}</td>
                    }
                  </tr>
                } @empty {
                  <tr>
                    <td>No members yet.</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        } @empty {
          <p>No teams.</p>
        }
      </mat-card-content>
    </mat-card>
  `,
})
export class ProjectTeamsComponent {
  private readonly api = inject(ProjectsApiService);

  /** Project id. */
  readonly projectId = input.required<string>();
  /** Project members, to choose team members from and to know who is a Viewer. */
  readonly members = input.required<ProjectMemberDto[]>();
  /** True when the caller may change teams (PM of an unarchived project). */
  readonly canEdit = input(false);

  /** Team role names for the template. */
  protected readonly roleLabels = TEAM_ROLE_LABELS;
  /** Longest team name. */
  protected readonly nameMax = TEAM_NAME_MAX;
  /** Loaded teams. */
  protected readonly teams = signal<TeamDto[]>([]);
  /** Team chosen in the add row. */
  protected readonly addTeamId = signal('');
  /** Member chosen in the add row. */
  protected readonly addUserId = signal('');
  /** Team role chosen in the add row. */
  protected readonly addRole = signal<TeamRole>(TeamRole.MEMBER);
  /** Last error message, if any. */
  protected readonly error = signal('');

  /** Project members not yet in the team chosen in the add row. */
  protected readonly addableMembers = computed(() => {
    const team = this.teams().find((t) => t.id === this.addTeamId());
    const inTeam = new Set(team?.members.map((m) => m.userId) ?? []);
    return this.members().filter((m) => !inTeam.has(m.userId));
  });

  /**
   * Loads the teams whenever the project or its member list changes (a
   * removed project member also leaves their teams).
   */
  constructor() {
    effect(() => {
      const projectId = this.projectId();
      this.members();
      void this.run(async () => this.teams.set(await this.loadAll(projectId)));
    });
  }

  /**
   * Team roles a member may hold: project Viewers may only be team Members.
   *
   * @param userId The member's user id.
   * @returns Allowed team roles.
   */
  protected rolesFor(userId: string): TeamRole[] {
    const member = this.members().find((m) => m.userId === userId);
    return member?.role === ProjectRole.VIEWER ? [TeamRole.MEMBER] : Object.values(TeamRole);
  }

  /**
   * Creates a team from the name input, clearing it only on success so a
   * rejected name (e.g. a duplicate) can be corrected.
   *
   * @param input The team name input.
   * @returns Resolves once created.
   */
  protected async createTeam(input: HTMLInputElement): Promise<void> {
    const name = input.value.trim();
    if (name === '') return;
    const ok = await this.run(async () => {
      const team = await this.api.createTeam(this.projectId(), { name });
      this.teams.update((teams) => [...teams, team].sort((a, b) => a.name.localeCompare(b.name)));
    });
    if (ok) input.value = '';
  }

  /**
   * Renames a team after prompting for the new name.
   *
   * @param team The team.
   * @returns Resolves once renamed.
   */
  protected async renameTeam(team: TeamDto): Promise<void> {
    const name = prompt('New team name', team.name)?.trim();
    if (!name || name === team.name) return;
    await this.run(async () =>
      this.replace(await this.api.updateTeam(this.projectId(), team.id, { name })),
    );
  }

  /**
   * Deletes a team after confirmation. Its members stay in the project.
   *
   * @param team The team.
   * @returns Resolves once deleted.
   */
  protected async deleteTeam(team: TeamDto): Promise<void> {
    if (!confirm(`Delete the team ${team.name}? Its members stay in the project.`)) return;
    await this.run(async () => {
      await this.api.deleteTeam(this.projectId(), team.id);
      this.teams.update((teams) => teams.filter((t) => t.id !== team.id));
    });
  }

  /**
   * Adds the chosen member to the chosen team.
   *
   * @returns Resolves once added.
   */
  protected async addToTeam(): Promise<void> {
    const teamId = this.addTeamId();
    const userId = this.addUserId();
    if (teamId === '' || userId === '') return;
    const role = this.rolesFor(userId).includes(this.addRole()) ? this.addRole() : TeamRole.MEMBER;
    await this.run(async () => {
      this.replace(await this.api.setTeamMember(this.projectId(), teamId, userId, { role }));
      this.addUserId.set('');
    });
  }

  /**
   * Changes a member's team role. On failure the teams are reloaded so the
   * select shows the stored role again.
   *
   * @param team The team.
   * @param userId The member's user id.
   * @param role The new role.
   * @returns Resolves once done.
   */
  protected async setRole(team: TeamDto, userId: string, role: TeamRole): Promise<void> {
    const ok = await this.run(async () =>
      this.replace(await this.api.setTeamMember(this.projectId(), team.id, userId, { role })),
    );
    if (!ok) {
      const message = this.error();
      this.teams.set([]);
      await this.run(async () => this.teams.set(await this.loadAll(this.projectId())));
      this.error.set(message);
    }
  }

  /**
   * Removes a member from a team.
   *
   * @param team The team.
   * @param userId The member's user id.
   * @returns Resolves once removed.
   */
  protected async removeFromTeam(team: TeamDto, userId: string): Promise<void> {
    await this.run(async () =>
      this.replace(await this.api.removeTeamMember(this.projectId(), team.id, userId)),
    );
  }

  /**
   * Loads every team of the project, following pagination.
   *
   * @param projectId Project id.
   * @returns All teams ordered by name.
   */
  private async loadAll(projectId: string): Promise<TeamDto[]> {
    const all: TeamDto[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.api.teams(projectId, cursor);
      all.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return all;
  }

  /**
   * Replaces one team in the list with a fresher copy.
   *
   * @param team The updated team.
   */
  private replace(team: TeamDto): void {
    this.teams.update((teams) => teams.map((t) => (t.id === team.id ? team : t)));
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
