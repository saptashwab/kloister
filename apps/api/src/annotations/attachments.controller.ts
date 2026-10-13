import {
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  type AttachmentDto,
  FILE_NAME_HEADER,
  type InlineImageDto,
  type Page,
  ProjectPermission as P,
} from '@kloister/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { PageQueryDto } from '../common/pagination.js';
import {
  CurrentProject,
  ProjectAccessGuard,
  RequireProjectPermission,
} from '../projects/project-access.guard.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import { contentDisposition } from '../storage/file-types.js';
import { AttachmentsService, type OpenedFile } from './attachments.service.js';

/**
 * Headers on every stored file sent back (SPEC §5): the browser must not
 * guess another type, and nothing in the file may run or load anything even
 * if it is opened directly.
 *
 * @param reply The response.
 * @param cache The `Cache-Control` value.
 */
function protect(reply: FastifyReply, cache: string): void {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
  reply.header('Cache-Control', cache);
}

/**
 * Item attachments under `/api/v1/projects/:id/items/:item/attachments`
 * (SPEC §8 `items/…/attachments`). Uploads send the raw file as an
 * `application/octet-stream` body with its name in the `x-file-name` header.
 *
 * Permissions: every route goes through {@link ProjectAccessGuard}
 * (non-members 404, archived projects read-only). Listing and downloading
 * need a visible item; uploading needs `ANNOTATE_ITEMS` (SPEC §3.2, 403 for
 * Viewers and non-member admins before the body is read); deleting needs
 * the uploader, a PM, a Lead or the item's team Lead.
 */
@Controller('projects/:id/items/:item/attachments')
@UseGuards(ProjectAccessGuard)
export class AttachmentsController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param attachments Attachment operations.
   */
  constructor(private readonly attachments: AttachmentsService) {}

  /**
   * Lists the item's attachments, newest first. Permissions: visible items.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @param query Pagination.
   * @returns One page of attachments.
   */
  @Get()
  @RequireProjectPermission(P.VIEW_ITEMS)
  list(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Query() query: PageQueryDto,
  ): Promise<Page<AttachmentDto>> {
    return this.attachments.list(auth, access, item, query);
  }

  /**
   * Uploads an attachment. Permissions: `ANNOTATE_ITEMS` on a visible item.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @param request The request, whose body is the file.
   * @param fileName The percent-encoded file name.
   * @param contentLength The declared size.
   * @returns The attachment (201); 413 over the size limit, 409 over the quota.
   */
  @Post()
  @RequireProjectPermission(P.ANNOTATE_ITEMS)
  upload(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Req() request: FastifyRequest,
    @Headers(FILE_NAME_HEADER) fileName: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
  ): Promise<AttachmentDto> {
    return this.attachments.attach(auth, access, item, {
      body: request.body,
      fileName,
      contentLength,
    });
  }

  /**
   * Downloads an attachment, always as a download (`Content-Disposition:
   * attachment`, `nosniff`). Permissions: visible items only.
   *
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @param attachmentId Attachment id.
   * @param reply The response, for the headers.
   * @returns The file.
   */
  @Get(':attachmentId')
  @RequireProjectPermission(P.VIEW_ITEMS)
  async download(
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const file = await this.attachments.open(access, item, attachmentId, false);
    protect(reply, 'private, no-store');
    return send(file, 'attachment');
  }

  /**
   * Deletes an attachment. Permissions: the uploader, PMs, Leads and the
   * item's team Leads.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @param attachmentId Attachment id.
   * @returns Resolves once deleted (204).
   */
  @Delete(':attachmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission(P.ANNOTATE_ITEMS)
  remove(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ): Promise<void> {
    return this.attachments.remove(auth, access, item, attachmentId);
  }
}

/**
 * Images pasted or dropped into an item's description or notes, under
 * `/api/v1/projects/:id/items/:item/images` (SPEC §5, §6). The sanitizer
 * keeps only `<img>` sources that point here, for the same item.
 *
 * Permissions: every route goes through {@link ProjectAccessGuard}.
 * Viewing needs a visible item (SPEC §5: served only to users who can see
 * it); uploading needs `ANNOTATE_ITEMS`, as for attachments.
 */
@Controller('projects/:id/items/:item/images')
@UseGuards(ProjectAccessGuard)
export class InlineImagesController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param attachments Attachment and image operations.
   */
  constructor(private readonly attachments: AttachmentsService) {}

  /**
   * Uploads an image. Permissions: `ANNOTATE_ITEMS` on a visible item.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @param request The request, whose body is the image.
   * @param fileName The percent-encoded file name.
   * @param contentLength The declared size.
   * @returns The image and its URL (201); 415 unless PNG, JPEG, GIF or WebP.
   */
  @Post()
  @RequireProjectPermission(P.ANNOTATE_ITEMS)
  upload(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Req() request: FastifyRequest,
    @Headers(FILE_NAME_HEADER) fileName: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
  ): Promise<InlineImageDto> {
    return this.attachments.addImage(auth, access, item, {
      body: request.body,
      fileName,
      contentLength,
    });
  }

  /**
   * Sends an image with its detected type and `nosniff`. Browsers must ask
   * again each time (`no-cache`), so an image is never shown from a cache to
   * someone who can no longer see its item. Permissions: visible items.
   *
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @param imageId Image id.
   * @param reply The response, for the headers.
   * @returns The image.
   */
  @Get(':imageId')
  @RequireProjectPermission(P.VIEW_ITEMS)
  async view(
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const file = await this.attachments.open(access, item, imageId, true);
    protect(reply, 'private, no-cache');
    return send(file, 'inline');
  }
}

/**
 * Wraps an opened file for sending.
 *
 * @param file The row and its bytes.
 * @param kind `attachment` (download) or `inline`.
 * @returns The streamable file with its type, size and name.
 */
function send(file: OpenedFile, kind: 'attachment' | 'inline'): StreamableFile {
  return new StreamableFile(file.stream, {
    type: file.row.mimeType,
    length: file.row.sizeBytes,
    disposition: contentDisposition(kind, file.row.originalName),
  });
}
