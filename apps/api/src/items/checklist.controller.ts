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
  UseGuards,
} from '@nestjs/common';
import { type ChecklistItemDto, ProjectPermission as P } from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { ReorderDto } from '../board/board.dto.js';
import {
  CurrentProject,
  ProjectAccessGuard,
  RequireProjectPermission,
} from '../projects/project-access.guard.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import { ChecklistService } from './checklist.service.js';
import { CreateChecklistItemDto, UpdateChecklistItemDto } from './items.dto.js';

/**
 * Item checklists under `/api/v1/projects/:id/items/:item/checklist`
 * (SPEC §8 `items/…/checklist`).
 *
 * Permissions: every route goes through {@link ProjectAccessGuard}. Reading
 * needs a visible item (404 otherwise); changes count as editing the item
 * (`EDIT_ANY_ITEM`, or `EDIT_OWN_ITEMS` on own items, or leading its team).
 */
@Controller('projects/:id/items/:item/checklist')
@UseGuards(ProjectAccessGuard)
export class ChecklistController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param checklist Checklist operations.
   */
  constructor(private readonly checklist: ChecklistService) {}

  /**
   * Lists the checklist in order. Permissions: visible items only.
   *
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @returns The lines.
   */
  @Get()
  @RequireProjectPermission(P.VIEW_ITEMS)
  list(
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
  ): Promise<ChecklistItemDto[]> {
    return this.checklist.list(access, item);
  }

  /**
   * Appends a line. Permissions: as for editing the item.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @param body Text and state.
   * @returns The new line (201).
   */
  @Post()
  @RequireProjectPermission([P.EDIT_ANY_ITEM, P.EDIT_OWN_ITEMS])
  add(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Body() body: CreateChecklistItemDto,
  ): Promise<ChecklistItemDto> {
    return this.checklist.add(auth, access, item, body);
  }

  /**
   * Edits or ticks a line. Permissions: as for editing the item.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @param lineId Line id.
   * @param body Fields to change.
   * @returns The updated line.
   */
  @Patch(':lineId')
  @RequireProjectPermission([P.EDIT_ANY_ITEM, P.EDIT_OWN_ITEMS])
  update(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() body: UpdateChecklistItemDto,
  ): Promise<ChecklistItemDto> {
    return this.checklist.update(auth, access, item, lineId, body);
  }

  /**
   * Reorders a line. Permissions: as for editing the item.
   *
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @param lineId Line id.
   * @param body The line to place it after.
   * @returns The moved line.
   */
  @Post(':lineId/move')
  @HttpCode(HttpStatus.OK)
  @RequireProjectPermission([P.EDIT_ANY_ITEM, P.EDIT_OWN_ITEMS])
  move(
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() body: ReorderDto,
  ): Promise<ChecklistItemDto> {
    return this.checklist.move(access, item, lineId, body);
  }

  /**
   * Removes a line. Permissions: as for editing the item.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @param lineId Line id.
   * @returns Resolves once removed (204).
   */
  @Delete(':lineId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission([P.EDIT_ANY_ITEM, P.EDIT_OWN_ITEMS])
  remove(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
  ): Promise<void> {
    return this.checklist.remove(auth, access, item, lineId);
  }
}
