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
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  type CloseSprintResult,
  type Page,
  ProjectPermission,
  type SprintDto,
} from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { PageQueryDto } from '../common/pagination.js';
import {
  CurrentProject,
  ProjectAccessGuard,
  RequireProjectPermission,
} from '../projects/project-access.guard.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import { CloseSprintDto, CreateSprintDto, UpdateSprintDto } from './board.dto.js';
import { SprintsService } from './sprints.service.js';

/**
 * Sprints under `/api/v1/projects/:id/sprints` (SPEC §8 `sprints`).
 *
 * Permissions: every route goes through {@link ProjectAccessGuard}. Any
 * member lists sprints; changes, starting and closing need `MANAGE_BOARD`
 * (PM and Lead).
 */
@Controller('projects/:id/sprints')
@UseGuards(ProjectAccessGuard)
export class SprintsController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param sprints Sprint operations.
   */
  constructor(private readonly sprints: SprintsService) {}

  /**
   * Lists sprints by start date. Permissions: any member; any admin.
   *
   * @param access The caller's access.
   * @param query Pagination.
   * @returns One page of sprints.
   */
  @Get()
  @RequireProjectPermission(ProjectPermission.VIEW_ITEMS)
  list(
    @CurrentProject() access: ProjectAccess,
    @Query() query: PageQueryDto,
  ): Promise<Page<SprintDto>> {
    return this.sprints.list(access, query);
  }

  /**
   * Plans a sprint. Permissions: `MANAGE_BOARD`.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param body Name, dates and iteration path.
   * @returns The new sprint (201).
   */
  @Post()
  @RequireProjectPermission(ProjectPermission.MANAGE_BOARD)
  create(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Body() body: CreateSprintDto,
  ): Promise<SprintDto> {
    return this.sprints.create(auth, access, body);
  }

  /**
   * Changes a sprint. Permissions: `MANAGE_BOARD`.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param sprintId Sprint id.
   * @param body Fields to change.
   * @returns The updated sprint.
   */
  @Patch(':sprintId')
  @RequireProjectPermission(ProjectPermission.MANAGE_BOARD)
  update(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('sprintId', ParseUUIDPipe) sprintId: string,
    @Body() body: UpdateSprintDto,
  ): Promise<SprintDto> {
    return this.sprints.update(auth, access, sprintId, body);
  }

  /**
   * Makes the sprint the active one. Permissions: `MANAGE_BOARD`.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param sprintId Sprint id.
   * @returns The started sprint.
   */
  @Post(':sprintId/start')
  @HttpCode(HttpStatus.OK)
  @RequireProjectPermission(ProjectPermission.MANAGE_BOARD)
  start(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('sprintId', ParseUUIDPipe) sprintId: string,
  ): Promise<SprintDto> {
    return this.sprints.start(auth, access, sprintId);
  }

  /**
   * Closes the sprint, optionally moving unfinished items. Permissions:
   * `MANAGE_BOARD`.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param sprintId Sprint id.
   * @param body Where unfinished items go.
   * @returns The closed sprint and how many items moved.
   */
  @Post(':sprintId/close')
  @HttpCode(HttpStatus.OK)
  @RequireProjectPermission(ProjectPermission.MANAGE_BOARD)
  close(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('sprintId', ParseUUIDPipe) sprintId: string,
    @Body() body: CloseSprintDto,
  ): Promise<CloseSprintResult> {
    return this.sprints.close(auth, access, sprintId, body);
  }

  /**
   * Deletes a sprint; its items stay without one. Permissions: `MANAGE_BOARD`.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param sprintId Sprint id.
   * @returns Resolves once deleted (204).
   */
  @Delete(':sprintId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission(ProjectPermission.MANAGE_BOARD)
  remove(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('sprintId', ParseUUIDPipe) sprintId: string,
  ): Promise<void> {
    return this.sprints.remove(auth, access, sprintId);
  }
}
