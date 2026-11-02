import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ProjectPermission as P,
  type RestoreBatchResult,
  type TrashBatchDto,
} from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import {
  CurrentProject,
  ProjectAccessGuard,
  RequireProjectPermission,
} from '../projects/project-access.guard.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import { TrashService } from './trash.service.js';

/**
 * A project's trash under `/api/v1/projects/:id/trash` (M12): deleted items
 * by delete batch, restore and permanent delete.
 *
 * Permissions: every route goes through {@link ProjectAccessGuard}
 * (non-members 404, archived projects read-only); listing and restoring need
 * a delete permission, permanent deletion `MANAGE_PROJECT` (PMs). The service
 * lists only items the caller could see and applies the restore rule.
 */
@Controller('projects/:id/trash')
@UseGuards(ProjectAccessGuard)
export class TrashController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param trash Trash operations.
   */
  constructor(private readonly trash: TrashService) {}

  /**
   * Lists the delete batches, newest first, with the caller's visible items.
   * Permissions: `DELETE_ANY_ITEM` or `DELETE_OWN_ITEMS`.
   *
   * @param access The caller's access.
   * @returns The batches.
   */
  @Get()
  @RequireProjectPermission([P.DELETE_ANY_ITEM, P.DELETE_OWN_ITEMS])
  list(@CurrentProject() access: ProjectAccess): Promise<TrashBatchDto[]> {
    return this.trash.list(access);
  }

  /**
   * Restores a delete batch. Permissions: `DELETE_ANY_ITEM`, or
   * `DELETE_OWN_ITEMS` for a single item the caller deleted or whose team
   * they lead; 404 unless its deleted item is visible.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param batchId The delete batch.
   * @returns How many items came back.
   */
  @Post(':batchId/restore')
  @HttpCode(HttpStatus.OK)
  @RequireProjectPermission([P.DELETE_ANY_ITEM, P.DELETE_OWN_ITEMS])
  restore(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('batchId', ParseUUIDPipe) batchId: string,
  ): Promise<RestoreBatchResult> {
    return this.trash.restore(auth, access, batchId);
  }

  /**
   * Deletes a batch for good. Permissions: `MANAGE_PROJECT` (PMs).
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param batchId The delete batch.
   * @returns Resolves once removed (204).
   */
  @Delete(':batchId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission(P.MANAGE_PROJECT)
  purge(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('batchId', ParseUUIDPipe) batchId: string,
  ): Promise<void> {
    return this.trash.purge(auth, access, batchId);
  }
}
