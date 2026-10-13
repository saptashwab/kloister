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
import { type LabelDto, type Page, ProjectPermission } from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { PageQueryDto } from '../common/pagination.js';
import {
  CurrentProject,
  ProjectAccessGuard,
  RequireProjectPermission,
} from '../projects/project-access.guard.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import { CreateLabelDto, UpdateLabelDto } from './board.dto.js';
import { LabelsService } from './labels.service.js';

/**
 * Project labels under `/api/v1/projects/:id/labels` (SPEC §8 `labels`).
 *
 * Permissions: every route goes through {@link ProjectAccessGuard}. Any
 * member lists labels; changes need `MANAGE_BOARD` (PM and Lead).
 */
@Controller('projects/:id/labels')
@UseGuards(ProjectAccessGuard)
export class LabelsController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param labels Label operations.
   */
  constructor(private readonly labels: LabelsService) {}

  /**
   * Lists labels by name. Permissions: any member; any admin.
   *
   * @param access The caller's access.
   * @param query Pagination.
   * @returns One page of labels.
   */
  @Get()
  @RequireProjectPermission(ProjectPermission.VIEW_ITEMS)
  list(
    @CurrentProject() access: ProjectAccess,
    @Query() query: PageQueryDto,
  ): Promise<Page<LabelDto>> {
    return this.labels.list(access, query);
  }

  /**
   * Creates a label. Permissions: `MANAGE_BOARD`.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param body Name and colour.
   * @returns The new label (201).
   */
  @Post()
  @RequireProjectPermission(ProjectPermission.MANAGE_BOARD)
  create(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Body() body: CreateLabelDto,
  ): Promise<LabelDto> {
    return this.labels.create(auth, access, body);
  }

  /**
   * Renames or recolours a label. Permissions: `MANAGE_BOARD`.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param labelId Label id.
   * @param body Fields to change.
   * @returns The updated label.
   */
  @Patch(':labelId')
  @RequireProjectPermission(ProjectPermission.MANAGE_BOARD)
  update(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('labelId', ParseUUIDPipe) labelId: string,
    @Body() body: UpdateLabelDto,
  ): Promise<LabelDto> {
    return this.labels.update(auth, access, labelId, body);
  }

  /**
   * Deletes a label and removes it from items. Permissions: `MANAGE_BOARD`.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param labelId Label id.
   * @returns Resolves once deleted (204).
   */
  @Delete(':labelId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission(ProjectPermission.MANAGE_BOARD)
  remove(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('labelId', ParseUUIDPipe) labelId: string,
  ): Promise<void> {
    return this.labels.remove(auth, access, labelId);
  }
}
