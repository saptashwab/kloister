import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { type Page, ProjectPermission, type TeamDto } from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { PageQueryDto } from '../common/pagination.js';
import {
  CurrentProject,
  ProjectAccessGuard,
  RequireProjectPermission,
} from './project-access.guard.js';
import type { ProjectAccess } from './project-access.service.js';
import { CreateTeamDto, SetTeamMemberDto, UpdateTeamDto } from './teams.dto.js';
import { TeamsService } from './teams.service.js';

/**
 * Optional project teams under `/api/v1/projects/:id/teams` (SPEC §3.5, §8).
 *
 * Permissions: every route goes through {@link ProjectAccessGuard}. Any
 * member may list teams; only PMs change them (`MANAGE_MEMBERS`), not team
 * Leads and not admins acting through their PM-assignment right.
 */
@Controller('projects/:id/teams')
@UseGuards(ProjectAccessGuard)
export class TeamsController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param teams Team operations.
   */
  constructor(private readonly teams: TeamsService) {}

  /**
   * Lists teams with their members. Permissions: any member; any admin
   * (audited if not a member).
   *
   * @param access The caller's access.
   * @param query Pagination.
   * @returns One page of teams ordered by name.
   */
  @Get()
  @RequireProjectPermission(ProjectPermission.VIEW_ITEMS)
  list(
    @CurrentProject() access: ProjectAccess,
    @Query() query: PageQueryDto,
  ): Promise<Page<TeamDto>> {
    return this.teams.list(access, query);
  }

  /**
   * Creates a team. Permissions: PM only.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param body Name and description.
   * @returns The new team (201).
   */
  @Post()
  @RequireProjectPermission(ProjectPermission.MANAGE_MEMBERS)
  create(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Body() body: CreateTeamDto,
  ): Promise<TeamDto> {
    return this.teams.create(auth, access, body);
  }

  /**
   * Renames a team or changes its description. Permissions: PM only.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param teamId Team id.
   * @param body Fields to change.
   * @returns The updated team.
   */
  @Patch(':teamId')
  @RequireProjectPermission(ProjectPermission.MANAGE_MEMBERS)
  update(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() body: UpdateTeamDto,
  ): Promise<TeamDto> {
    return this.teams.update(auth, access, teamId, body);
  }

  /**
   * Deletes a team; its members stay in the project. Permissions: PM only.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param teamId Team id.
   * @returns Resolves once deleted (204).
   */
  @Delete(':teamId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission(ProjectPermission.MANAGE_MEMBERS)
  remove(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('teamId', ParseUUIDPipe) teamId: string,
  ): Promise<void> {
    return this.teams.remove(auth, access, teamId);
  }

  /**
   * Adds a project member to the team or changes their team role.
   * Permissions: PM only.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param teamId Team id.
   * @param userId The user's id.
   * @param body Team role.
   * @returns The updated team.
   */
  @Put(':teamId/members/:userId')
  @RequireProjectPermission(ProjectPermission.MANAGE_MEMBERS)
  setMember(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: SetTeamMemberDto,
  ): Promise<TeamDto> {
    return this.teams.setMember(auth, access, teamId, userId, body);
  }

  /**
   * Removes a user from the team. Permissions: PM only.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param teamId Team id.
   * @param userId The user's id.
   * @returns The updated team.
   */
  @Delete(':teamId/members/:userId')
  @RequireProjectPermission(ProjectPermission.MANAGE_MEMBERS)
  removeMember(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<TeamDto> {
    return this.teams.removeMember(auth, access, teamId, userId);
  }
}
