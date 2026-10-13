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
import { type BucketDto, type Page, ProjectPermission } from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { PageQueryDto } from '../common/pagination.js';
import {
  CurrentProject,
  ProjectAccessGuard,
  RequireProjectPermission,
} from '../projects/project-access.guard.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import { CreateBucketDto, DeleteBucketQueryDto, ReorderDto, UpdateBucketDto } from './board.dto.js';
import { BucketsService } from './buckets.service.js';

/**
 * Board buckets under `/api/v1/projects/:id/buckets` (SPEC §8 `buckets`).
 *
 * Permissions: every route goes through {@link ProjectAccessGuard}
 * (non-members 404, archived projects read-only). Any member lists buckets;
 * changes need `MANAGE_BOARD` (PM and Lead).
 */
@Controller('projects/:id/buckets')
@UseGuards(ProjectAccessGuard)
export class BucketsController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param buckets Bucket operations.
   */
  constructor(private readonly buckets: BucketsService) {}

  /**
   * Lists buckets in board order. Permissions: any member; any admin.
   *
   * @param access The caller's access.
   * @param query Pagination.
   * @returns One page of buckets.
   */
  @Get()
  @RequireProjectPermission(ProjectPermission.VIEW_ITEMS)
  list(
    @CurrentProject() access: ProjectAccess,
    @Query() query: PageQueryDto,
  ): Promise<Page<BucketDto>> {
    return this.buckets.list(access, query);
  }

  /**
   * Adds a bucket as the last column. Permissions: `MANAGE_BOARD`.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param body Name and entry rule.
   * @returns The new bucket (201).
   */
  @Post()
  @RequireProjectPermission(ProjectPermission.MANAGE_BOARD)
  create(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Body() body: CreateBucketDto,
  ): Promise<BucketDto> {
    return this.buckets.create(auth, access, body);
  }

  /**
   * Renames a bucket or changes its rule. Permissions: `MANAGE_BOARD`.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param bucketId Bucket id.
   * @param body Fields to change.
   * @returns The updated bucket.
   */
  @Patch(':bucketId')
  @RequireProjectPermission(ProjectPermission.MANAGE_BOARD)
  update(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('bucketId', ParseUUIDPipe) bucketId: string,
    @Body() body: UpdateBucketDto,
  ): Promise<BucketDto> {
    return this.buckets.update(auth, access, bucketId, body);
  }

  /**
   * Moves a bucket in the column order. Permissions: `MANAGE_BOARD`.
   *
   * @param access The caller's access.
   * @param bucketId Bucket id.
   * @param body The bucket to place it after.
   * @returns The moved bucket.
   */
  @Post(':bucketId/move')
  @HttpCode(HttpStatus.OK)
  @RequireProjectPermission(ProjectPermission.MANAGE_BOARD)
  move(
    @CurrentProject() access: ProjectAccess,
    @Param('bucketId', ParseUUIDPipe) bucketId: string,
    @Body() body: ReorderDto,
  ): Promise<BucketDto> {
    return this.buckets.move(access, bucketId, body);
  }

  /**
   * Deletes a bucket, moving its items with `?moveItemsTo=`. Permissions:
   * `MANAGE_BOARD`.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param bucketId Bucket id.
   * @param query Target bucket for the items.
   * @returns Resolves once deleted (204).
   */
  @Delete(':bucketId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission(ProjectPermission.MANAGE_BOARD)
  remove(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('bucketId', ParseUUIDPipe) bucketId: string,
    @Query() query: DeleteBucketQueryDto,
  ): Promise<void> {
    return this.buckets.remove(auth, access, bucketId, query);
  }
}
