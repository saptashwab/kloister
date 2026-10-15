import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ProjectPermission as P } from '@kloister/shared';
import type { FastifyReply } from 'fastify';
import type { ReadStream } from 'node:fs';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import {
  CurrentProject,
  ProjectAccessGuard,
  RequireProjectPermission,
} from '../projects/project-access.guard.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import { SnapshotQueryDto } from './snapshots.dto.js';
import { SnapshotsService } from './snapshots.service.js';

/** Scoped project snapshots, including archived projects and owner-only personal spaces. */
@Controller('projects/:id/snapshots')
@UseGuards(ProjectAccessGuard)
export class ProjectSnapshotsController {
  /**
   * Receives the scoped snapshot builder.
   * @param snapshots Server-calculated eligibility and content.
   */
  constructor(private readonly snapshots: SnapshotsService) {}
  /**
   * Previews every eligible page without exporting unreadable content.
   * @param auth Caller.
   * @param access Guarded project.
   * @param query Scope and filters.
   * @returns Scope, filters, count and included details.
   */
  @Get('preview')
  @RequireProjectPermission(P.VIEW_ITEMS)
  async preview(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Query() query: SnapshotQueryDto,
  ) {
    const preview = await this.snapshots.preview(auth, query, access);
    return {
      scope: preview.scope,
      mode: preview.mode,
      count: preview.count,
      filters: preview.filters,
      details:
        'Items, checklists, notes, readable dependencies, files and activity; offline ZIP also includes original rich text and permitted file bytes.',
    };
  }
  /**
   * Downloads a readable snapshot; the API rechecks the scope on every request.
   * @param auth Caller.
   * @param access Guarded project.
   * @param query Confirmed scope and file option.
   * @param reply Binary download response.
   * @returns Download response.
   */
  @Get()
  @RequireProjectPermission(P.VIEW_ITEMS)
  async download(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Query() query: SnapshotQueryDto,
    @Res() reply: FastifyReply,
  ) {
    return sendSnapshot(
      reply,
      await this.snapshots.download(auth, query, access),
      query.offline === true,
    );
  }
}

/** My work snapshots never include administrative cross-project reach. */
@Controller('me/snapshots')
export class WorkSnapshotsController {
  /**
   * Receives the scoped snapshot builder.
   * @param snapshots My work eligibility and content.
   */
  constructor(private readonly snapshots: SnapshotsService) {}
  /**
   * Previews only the caller's eligible work.
   * @param auth Caller.
   * @param query Source and narrowing filters.
   * @returns Scope, filters, count and included details.
   */
  @Get('preview')
  async preview(@CurrentAuth() auth: AuthContext, @Query() query: SnapshotQueryDto) {
    const preview = await this.snapshots.preview(auth, query);
    return {
      scope: preview.scope,
      mode: preview.mode,
      count: preview.count,
      filters: preview.filters,
      details:
        'Items, checklists, notes, readable dependencies, files and activity; offline ZIP includes original rich text and permitted files.',
    };
  }
  /**
   * Downloads only work currently eligible for the caller.
   * @param auth Caller.
   * @param query Previewed scope and file option.
   * @param reply Binary download response.
   * @returns Download response.
   */
  @Get()
  async download(
    @CurrentAuth() auth: AuthContext,
    @Query() query: SnapshotQueryDto,
    @Res() reply: FastifyReply,
  ) {
    return sendSnapshot(reply, await this.snapshots.download(auth, query), query.offline === true);
  }
}

/**
 * Sends local bytes as a private, non-cacheable download.
 * @param reply Response.
 * @param bytes Complete content; generation failures never produce a partial successful file.
 * @param offline ZIP rather than workbook.
 * @returns Download response.
 */
function sendSnapshot(reply: FastifyReply, bytes: Buffer | ReadStream, offline: boolean) {
  return reply
    .header(
      'Content-Type',
      offline
        ? 'application/zip'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    .header('Content-Disposition', `attachment; filename="snapshot.${offline ? 'zip' : 'xlsx'}"`)
    .header('Cache-Control', 'no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .send(bytes);
}
