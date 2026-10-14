import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AddMemberRequest,
  CreateProjectRequest,
  CreateTeamRequest,
  MemberCandidateDto,
  Page,
  ProjectDto,
  ProjectMemberDto,
  SetTeamMemberRequest,
  TeamDto,
  UpdateMemberRequest,
  UpdateProjectRequest,
  UpdateTeamRequest,
} from '@kloister/shared';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from './api';

/** Filters for {@link ProjectsApiService.list}. */
export interface ProjectListFilter {
  /** `all` lists every project and is for admins only. */
  scope?: 'mine' | 'all';
  /** Include archived projects. */
  includeArchived?: boolean;
  /** Cursor from the previous page. */
  cursor?: string;
}

/**
 * Client for the project and membership endpoints. The API decides every
 * permission (non-members get 404, other refusals 403); the UI only hides
 * controls based on `ProjectDto.myPermissions`.
 */
@Injectable({ providedIn: 'root' })
export class ProjectsApiService {
  private readonly http = inject(HttpClient);

  /**
   * Lists projects ordered by name.
   *
   * @param filter Scope, archived filter and cursor.
   * @returns One page of projects.
   */
  list(filter: ProjectListFilter = {}): Promise<Page<ProjectDto>> {
    let params = new HttpParams();
    if (filter.scope) params = params.set('scope', filter.scope);
    if (filter.includeArchived) params = params.set('includeArchived', 'true');
    if (filter.cursor) params = params.set('cursor', filter.cursor);
    return firstValueFrom(this.http.get<Page<ProjectDto>>(apiUrl('projects'), { params }));
  }

  /**
   * Creates a project with its first PM (admins only).
   *
   * @param request Key, name, description and PM.
   * @returns The project.
   */
  create(request: CreateProjectRequest): Promise<ProjectDto> {
    return firstValueFrom(this.http.post<ProjectDto>(apiUrl('projects'), request));
  }

  /**
   * Loads one project.
   *
   * @param ref Project key or id.
   * @returns The project with the caller's role and permissions.
   */
  get(ref: string): Promise<ProjectDto> {
    if (ref === 'personal')
      return firstValueFrom(this.http.post<ProjectDto>(apiUrl('me/personal'), {}));
    return firstValueFrom(this.http.get<ProjectDto>(apiUrl(`projects/${encodeURIComponent(ref)}`)));
  }

  /**
   * Changes project name, description or settings (PM only).
   *
   * @param id Project id.
   * @param request Fields to change.
   * @returns The updated project.
   */
  update(id: string, request: UpdateProjectRequest): Promise<ProjectDto> {
    return firstValueFrom(this.http.patch<ProjectDto>(apiUrl(`projects/${id}`), request));
  }

  /**
   * Archives or unarchives a project (PM only).
   *
   * @param id Project id.
   * @param archived True to archive.
   * @returns The updated project.
   */
  setArchived(id: string, archived: boolean): Promise<ProjectDto> {
    const action = archived ? 'archive' : 'unarchive';
    return firstValueFrom(this.http.post<ProjectDto>(apiUrl(`projects/${id}/${action}`), {}));
  }

  /**
   * Lists members.
   *
   * @param id Project id.
   * @param cursor Cursor from the previous page.
   * @returns One page of members.
   */
  members(id: string, cursor?: string): Promise<Page<ProjectMemberDto>> {
    const params = cursor ? new HttpParams().set('cursor', cursor) : new HttpParams();
    return firstValueFrom(
      this.http.get<Page<ProjectMemberDto>>(apiUrl(`projects/${id}/members`), { params }),
    );
  }

  /**
   * Searches users who can be added (PM only).
   *
   * @param id Project id.
   * @param q Search text.
   * @returns Matching active non-members.
   */
  candidates(id: string, q: string): Promise<MemberCandidateDto[]> {
    const params = q ? new HttpParams().set('q', q) : new HttpParams();
    return firstValueFrom(
      this.http.get<MemberCandidateDto[]>(apiUrl(`projects/${id}/member-candidates`), { params }),
    );
  }

  /**
   * Adds a member (PM only).
   *
   * @param id Project id.
   * @param request User, role and visibility.
   * @returns The new member.
   */
  addMember(id: string, request: AddMemberRequest): Promise<ProjectMemberDto> {
    return firstValueFrom(
      this.http.post<ProjectMemberDto>(apiUrl(`projects/${id}/members`), request),
    );
  }

  /**
   * Changes a member's role or visibility (PM only).
   *
   * @param id Project id.
   * @param userId Member's user id.
   * @param request Fields to change.
   * @returns The updated member.
   */
  updateMember(
    id: string,
    userId: string,
    request: UpdateMemberRequest,
  ): Promise<ProjectMemberDto> {
    return firstValueFrom(
      this.http.patch<ProjectMemberDto>(apiUrl(`projects/${id}/members/${userId}`), request),
    );
  }

  /**
   * Removes a member (PM only).
   *
   * @param id Project id.
   * @param userId Member's user id.
   * @returns Resolves once removed.
   */
  removeMember(id: string, userId: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(apiUrl(`projects/${id}/members/${userId}`)));
  }

  /**
   * Lists the project's teams with their members.
   *
   * @param id Project id.
   * @param cursor Cursor from the previous page.
   * @returns One page of teams.
   */
  teams(id: string, cursor?: string): Promise<Page<TeamDto>> {
    const params = cursor ? new HttpParams().set('cursor', cursor) : new HttpParams();
    return firstValueFrom(this.http.get<Page<TeamDto>>(apiUrl(`projects/${id}/teams`), { params }));
  }

  /**
   * Creates a team (PM only).
   *
   * @param id Project id.
   * @param request Name and description.
   * @returns The new team.
   */
  createTeam(id: string, request: CreateTeamRequest): Promise<TeamDto> {
    return firstValueFrom(this.http.post<TeamDto>(apiUrl(`projects/${id}/teams`), request));
  }

  /**
   * Renames a team (PM only).
   *
   * @param id Project id.
   * @param teamId Team id.
   * @param request Fields to change.
   * @returns The updated team.
   */
  updateTeam(id: string, teamId: string, request: UpdateTeamRequest): Promise<TeamDto> {
    return firstValueFrom(
      this.http.patch<TeamDto>(apiUrl(`projects/${id}/teams/${teamId}`), request),
    );
  }

  /**
   * Deletes a team (PM only).
   *
   * @param id Project id.
   * @param teamId Team id.
   * @returns Resolves once deleted.
   */
  deleteTeam(id: string, teamId: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(apiUrl(`projects/${id}/teams/${teamId}`)));
  }

  /**
   * Adds a project member to a team or changes their team role (PM only).
   *
   * @param id Project id.
   * @param teamId Team id.
   * @param userId User id.
   * @param request Team role.
   * @returns The updated team.
   */
  setTeamMember(
    id: string,
    teamId: string,
    userId: string,
    request: SetTeamMemberRequest,
  ): Promise<TeamDto> {
    return firstValueFrom(
      this.http.put<TeamDto>(apiUrl(`projects/${id}/teams/${teamId}/members/${userId}`), request),
    );
  }

  /**
   * Removes a user from a team (PM only).
   *
   * @param id Project id.
   * @param teamId Team id.
   * @param userId User id.
   * @returns The updated team.
   */
  removeTeamMember(id: string, teamId: string, userId: string): Promise<TeamDto> {
    return firstValueFrom(
      this.http.delete<TeamDto>(apiUrl(`projects/${id}/teams/${teamId}/members/${userId}`)),
    );
  }
}
