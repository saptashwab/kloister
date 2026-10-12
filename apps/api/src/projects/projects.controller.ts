import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { type Page, type ProjectDto, ProjectPermission } from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { AdminOnly, CurrentAuth } from '../auth/decorators.js';
import {
  CurrentProject,
  ProjectAccessGuard,
  RequireProjectPermission,
} from './project-access.guard.js';
import type { ProjectAccess } from './project-access.service.js';
import { CreateProjectDto, ListProjectsQueryDto, UpdateProjectDto } from './projects.dto.js';
import { ProjectsService } from './projects.service.js';

/**
 * Project collection routes under `/api/v1/projects` (SPEC §8).
 *
 * Permissions: listing is open to every signed-in user (their own projects;
 * `scope=all` for admins only); creating is admin-only (SPEC §3.1).
 */
@Controller('projects')
export class ProjectsController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param projects Project operations.
   */
  constructor(private readonly projects: ProjectsService) {}

  /**
   * Lists the caller's projects, or every project for admins with `scope=all`.
   *
   * @param auth The caller.
   * @param query Scope, archived filter, search and pagination.
   * @returns One page of projects ordered by name.
   */
  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query() query: ListProjectsQueryDto,
  ): Promise<Page<ProjectDto>> {
    return this.projects.list(auth, query);
  }

  /**
   * Creates a project and assigns its first PM. Admins only.
   *
   * @param auth The admin.
   * @param body Key, name, description and PM.
   * @returns The project (201).
   */
  @Post()
  @AdminOnly()
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateProjectDto): Promise<ProjectDto> {
    return this.projects.create(auth, body);
  }
}

/**
 * Single-project routes under `/api/v1/projects/:id`, where `:id` is the
 * project uuid or key.
 *
 * Permissions: every route goes through {@link ProjectAccessGuard}; see each
 * route's {@link RequireProjectPermission}. Non-members get 404.
 */
@Controller('projects/:id')
@UseGuards(ProjectAccessGuard)
export class ProjectController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param projects Project operations.
   */
  constructor(private readonly projects: ProjectsService) {}

  /**
   * Returns the project with the caller's role and permissions.
   * Permissions: any member; admins read-only (audited).
   *
   * @param access The caller's access.
   * @returns The project.
   */
  @Get()
  @RequireProjectPermission(ProjectPermission.VIEW_ITEMS)
  get(@CurrentProject() access: ProjectAccess): ProjectDto {
    return this.projects.get(access);
  }

  /**
   * Changes name, description or settings. Permissions: PM only.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param body Fields to change.
   * @returns The updated project.
   */
  @Patch()
  @RequireProjectPermission(ProjectPermission.MANAGE_PROJECT)
  update(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Body() body: UpdateProjectDto,
  ): Promise<ProjectDto> {
    return this.projects.update(auth, access, body);
  }

  /**
   * Archives the project, making it read-only. Permissions: PM only.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @returns The updated project.
   */
  @Post('archive')
  @HttpCode(HttpStatus.OK)
  @RequireProjectPermission(ProjectPermission.MANAGE_PROJECT)
  archive(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
  ): Promise<ProjectDto> {
    return this.projects.setArchived(auth, access, true);
  }

  /**
   * Unarchives the project. Permissions: PM only; allowed while archived.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @returns The updated project.
   */
  @Post('unarchive')
  @HttpCode(HttpStatus.OK)
  @RequireProjectPermission(ProjectPermission.MANAGE_PROJECT, { allowArchived: true })
  unarchive(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
  ): Promise<ProjectDto> {
    return this.projects.setArchived(auth, access, false);
  }
}
