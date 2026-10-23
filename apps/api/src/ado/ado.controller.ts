import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import { ProjectPermission as P } from '@kloister/shared';
import type { FastifyReply } from 'fastify';
import { CurrentAuth } from '../auth/decorators.js';
import type { AuthContext } from '../auth/auth-context.js';
import { PageQueryDto } from '../common/pagination.js';
import {
  CurrentProject,
  ProjectAccessGuard,
  RequireProjectPermission,
} from '../projects/project-access.guard.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import {
  ApplyDto,
  CancelDto,
  DestinationDto,
  ExportDto,
  ImportDto,
  ReviewPolicyDto,
  SampleDto,
} from './ado.dto.js';
import { AdoService } from './ado.service.js';

/** Project-scoped offline transfer endpoints; team leadership and system administration add no rights. */
@Controller('projects/:id/ado')
@UseGuards(ProjectAccessGuard)
export class AdoController {
  /**
   * Receives the durable transfer lifecycle.
   * @param ado Transfer service.
   */
  constructor(private readonly ado: AdoService) {}

  /**
   * Reads PM-only transfer configuration.
   * @param access Project access.
   * @returns Destination or null before setup.
   */
  @Get('destination')
  @RequireProjectPermission(P.IMPORT_ADO)
  destination(@CurrentProject() access: ProjectAccess) {
    return this.ado.destination(access);
  }

  /**
   * Reads the sanitized profile needed by an exporting PM/Lead.
   * @param access Project access.
   * @returns Read-only export configuration.
   */
  @Get('profile')
  @RequireProjectPermission(P.EXPORT_ADO)
  profile(@CurrentProject() access: ProjectAccess) {
    return this.ado.destination(access);
  }

  /**
   * Saves reviewed destination settings, PM only.
   * @param auth Acting PM.
   * @param access Project access.
   * @param body Replacement with config revision.
   * @returns Saved profile.
   */
  @Put('destination')
  @RequireProjectPermission(P.IMPORT_ADO)
  configure(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Body() body: DestinationDto,
  ) {
    return this.ado.configure(auth, access, body);
  }

  /**
   * Sets whether Detailed review is mandatory, PM only.
   * @param auth Acting PM.
   * @param access Project access.
   * @param body New policy.
   * @returns Saved destination.
   */
  @Put('review-policy')
  @RequireProjectPermission(P.IMPORT_ADO)
  reviewPolicy(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Body() body: ReviewPolicyDto,
  ) {
    return this.ado.setReviewPolicy(auth, access, body.requireDetailedReview);
  }

  /**
   * Reads a sample ADO export to suggest mappings, PM only; nothing is stored.
   * @param access Project access.
   * @param body Exported CSV.
   * @returns Distinct values found in the file.
   */
  @Post('sample')
  @RouteConfig({ bodyLimit: 24 * 1024 * 1024 })
  @RequireProjectPermission(P.IMPORT_ADO)
  sample(@CurrentProject() access: ProjectAccess, @Body() body: SampleDto) {
    return this.ado.sample(access, body.csv);
  }

  /**
   * Previews outbound rows, PM/Lead only; never accepts remote observations.
   * @param access Project access.
   * @param body Outbound selection and resolutions.
   * @returns Preview and blockers.
   */
  @Post('export/preview')
  @RequireProjectPermission(P.EXPORT_ADO)
  previewExport(@CurrentProject() access: ProjectAccess, @Body() body: ExportDto) {
    return this.ado.previewExport(access, body);
  }

  /**
   * Reserves exact outgoing files and pending references, PM/Lead only.
   * @param auth Acting exporter.
   * @param access Project access.
   * @param body Reviewed digest and retry key.
   * @returns Recoverable batch.
   */
  @Post('export/prepare')
  @RequireProjectPermission(P.EXPORT_ADO)
  prepare(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Body() body: ExportDto,
  ) {
    return this.ado.prepare(auth, access, body);
  }

  /**
   * Uploads a bounded incoming preview, project PM only.
   * @param auth Acting PM.
   * @param access Project access.
   * @param body CSV and explicit review choices.
   * @returns Persisted preview.
   */
  @Post('import/preview')
  @RouteConfig({ bodyLimit: 24 * 1024 * 1024 })
  @RequireProjectPermission(P.IMPORT_ADO)
  previewImport(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Body() body: ImportDto,
  ) {
    return this.ado.previewImport(auth, access, body);
  }

  /**
   * Lists recoverable transfer history, project PM only.
   * @param access Project access.
   * @param page Cursor/limit.
   * @returns Safe history page.
   */
  @Get('batches')
  @RequireProjectPermission(P.IMPORT_ADO)
  history(@CurrentProject() access: ProjectAccess, @Query() page: PageQueryDto) {
    return this.ado.history(access, page);
  }

  /**
   * Recovers a scoped review, project PM only.
   * @param access Project access.
   * @param batchId Scoped batch UUID.
   * @returns Review or compact receipt.
   */
  @Get('batches/:batchId')
  @RequireProjectPermission(P.IMPORT_ADO)
  recover(
    @CurrentProject() access: ProjectAccess,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
  ) {
    return this.ado.recover(access, batchId);
  }

  /**
   * Downloads reserved outbound files, PM/Lead only, without confirming import.
   * @param access Project access.
   * @param batchId Scoped batch UUID.
   * @param reply Fastify binary response.
   * @returns ZIP response.
   */
  @Get('batches/:batchId/download')
  @RequireProjectPermission(P.EXPORT_ADO)
  async download(
    @CurrentProject() access: ProjectAccess,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const result = await this.ado.download(access, batchId);
    await reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${result.filename}"`)
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(result.bytes);
  }

  /**
   * Applies the revalidated preview atomically, PM only.
   * @param auth Acting PM.
   * @param access Project access.
   * @param batchId Scoped preview UUID.
   * @param body Exact reviewed digest.
   * @returns Durable receipt.
   */
  @Post('batches/:batchId/apply')
  @RequireProjectPermission(P.IMPORT_ADO)
  apply(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
    @Body() body: ApplyDto,
  ) {
    return this.ado.apply(auth, access, batchId, body.digest);
  }

  /**
   * Cancels a pending create after explicit duplicate-risk acknowledgement, PM only.
   * @param auth Acting PM.
   * @param access Project access.
   * @param batchId Scoped pending batch.
   * @param body Duplicate risk acknowledgement.
   * @returns Cancelled receipt.
   */
  @Post('batches/:batchId/cancel')
  @RequireProjectPermission(P.IMPORT_ADO)
  cancel(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('batchId', new ParseUUIDPipe()) batchId: string,
    @Body() body: CancelDto,
  ) {
    return this.ado.cancel(auth, access, batchId, body.duplicateRiskAcknowledged);
  }
}
