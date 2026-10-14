import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpStatus,
  Param,
  Put,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  type BrandingSettingsDto,
  FILE_NAME_HEADER,
  FontWeight,
  type PublicBrandingDto,
} from '@kloister/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthContext } from '../auth/auth-context.js';
import { AdminOnly, CurrentAuth, Public } from '../auth/decorators.js';
import { notFound } from '../common/api-exception.js';
import { BrandingBody } from '../settings/settings.dto.js';
import { contentDisposition } from '../storage/file-types.js';
import { type BrandingSlot, BrandingService, fontSlot } from './branding.service.js';

/**
 * Checks a font weight from a URL.
 *
 * @param weight The path segment.
 * @returns The slot; 404 for anything but `regular` and `bold`.
 */
function weightSlot(weight: string): BrandingSlot {
  if (weight !== FontWeight.REGULAR && weight !== FontWeight.BOLD) throw notFound('Font file');
  return fontSlot(weight);
}

/**
 * Public branding under `/api/v1/branding` (SPEC §6): the app name, logo,
 * font and default theme every page needs, including the sign-in page.
 *
 * Permissions: public, read-only, and limited to what is drawn on screen.
 * Files are sent by the app from its own origin with
 * `X-Content-Type-Options: nosniff`, a sandboxing Content-Security-Policy
 * and `Cross-Origin-Resource-Policy: same-origin` (docs/DESIGN.md §6).
 */
@Controller('branding')
@Public()
export class PublicBrandingController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param branding Branding logic.
   */
  constructor(private readonly branding: BrandingService) {}

  /**
   * Returns the app name, logo and font locations and the default theme.
   *
   * @returns The public branding.
   */
  @Get()
  get(): Promise<PublicBrandingDto> {
    return this.branding.publicBranding();
  }

  /**
   * Sends the logo.
   *
   * @param request For `If-None-Match`.
   * @param reply For the protective headers.
   * @returns The image, 304 when unchanged, or 404.
   */
  @Get('logo')
  logo(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile | undefined> {
    return this.send('logo', request, reply);
  }

  /**
   * Sends an uploaded font file.
   *
   * @param weight `regular` or `bold`.
   * @param request For `If-None-Match`.
   * @param reply For the protective headers.
   * @returns The font, 304 when unchanged, or 404.
   */
  @Get('fonts/:weight')
  font(
    @Param('weight') weight: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile | undefined> {
    return this.send(weightSlot(weight), request, reply);
  }

  /**
   * Sends a branding file with protective headers. Browsers revalidate
   * with the ETag (the file's hash); the versioned URL changes on upload.
   *
   * @param slot Which file.
   * @param request For `If-None-Match`.
   * @param reply For the headers.
   * @returns The file, or nothing with 304.
   */
  private async send(
    slot: BrandingSlot,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<StreamableFile | undefined> {
    const opened = await this.branding.open(slot);
    const etag = this.branding.etag(opened.file);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Cache-Control', 'no-cache');
    reply.header('ETag', etag);
    if (request.headers['if-none-match'] === etag) {
      opened.stream.destroy();
      reply.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    return new StreamableFile(opened.stream, {
      type: opened.file.type,
      length: opened.file.sizeBytes,
      // A fixed name: the admin's original file name is not public.
      disposition: contentDisposition('inline', slot === 'logo' ? 'logo' : 'font'),
    });
  }
}

/**
 * Branding settings under `/api/v1/admin/settings/branding` (SPEC §6 Admin):
 * app name, logo upload and the UI font (a preset or uploaded files).
 * Uploads send the raw file as an `application/octet-stream` body with its
 * name in the `x-file-name` header.
 *
 * Permissions: admin-only (others get 403, checked before any of an upload
 * is read); every change is audited.
 */
@Controller('admin/settings/branding')
@AdminOnly()
export class AdminBrandingController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param branding Branding logic.
   */
  constructor(private readonly branding: BrandingService) {}

  /**
   * Returns the branding settings.
   *
   * @returns Name, font and uploaded files.
   */
  @Get()
  get(): Promise<BrandingSettingsDto> {
    return this.branding.adminBranding();
  }

  /**
   * Saves the app name and the font.
   *
   * @param auth The admin.
   * @param body Name and font.
   * @returns The branding settings.
   */
  @Put()
  put(@CurrentAuth() auth: AuthContext, @Body() body: BrandingBody): Promise<BrandingSettingsDto> {
    return this.branding.save(auth, body);
  }

  /**
   * Uploads a new logo (PNG, JPEG, GIF or WebP by content, at most 1 MB).
   *
   * @param auth The admin.
   * @param request The raw body.
   * @param fileName The `x-file-name` header.
   * @param contentLength The declared size.
   * @returns The branding settings.
   */
  @Put('logo')
  putLogo(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Headers(FILE_NAME_HEADER) fileName: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
  ): Promise<BrandingSettingsDto> {
    return this.branding.upload(auth, 'logo', { body: request.body, fileName, contentLength });
  }

  /**
   * Removes the logo.
   *
   * @param auth The admin.
   * @returns The branding settings.
   */
  @Delete('logo')
  deleteLogo(@CurrentAuth() auth: AuthContext): Promise<BrandingSettingsDto> {
    return this.branding.remove(auth, 'logo');
  }

  /**
   * Uploads the regular or bold font file (WOFF2, WOFF, TTF or OTF by
   * content, at most 10 MB).
   *
   * @param auth The admin.
   * @param weight `regular` or `bold`.
   * @param request The raw body.
   * @param fileName The `x-file-name` header.
   * @param contentLength The declared size.
   * @returns The branding settings.
   */
  @Put('fonts/:weight')
  putFont(
    @CurrentAuth() auth: AuthContext,
    @Param('weight') weight: string,
    @Req() request: FastifyRequest,
    @Headers(FILE_NAME_HEADER) fileName: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
  ): Promise<BrandingSettingsDto> {
    return this.branding.upload(auth, weightSlot(weight), {
      body: request.body,
      fileName,
      contentLength,
    });
  }

  /**
   * Removes a font file; removing the regular one removes both and switches
   * an uploaded font back to Figtree.
   *
   * @param auth The admin.
   * @param weight `regular` or `bold`.
   * @returns The branding settings.
   */
  @Delete('fonts/:weight')
  deleteFont(
    @CurrentAuth() auth: AuthContext,
    @Param('weight') weight: string,
  ): Promise<BrandingSettingsDto> {
    return this.branding.remove(auth, weightSlot(weight));
  }
}
