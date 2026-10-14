import { randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  type BrandingFileDto,
  brandingFileUrl,
  type BrandingSettingsDto,
  ErrorCode,
  FONT_MAX_BYTES,
  FontWeight,
  LOGO_MAX_BYTES,
  type PublicBrandingDto,
  UiFont,
  type UpdateBrandingRequest,
} from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { AuditService } from '../audit/audit.service.js';
import { ApiException, invalidField, notFound } from '../common/api-exception.js';
import { serializable } from '../common/transactions.js';
import { AppConfig } from '../config/app-config.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  BRANDING_FILES_KEY,
  BRANDING_SETTINGS_KEY,
  type BrandingFiles,
  SettingsService,
  type StoredBrandingFile,
} from '../settings/settings.service.js';
import { fileTooLarge, type ReceivedFile, receiveInto } from '../storage/file-store.service.js';
import { cleanFileName, isInlineImageType, sniffFont, sniffType } from '../storage/file-types.js';

/** The uploadable branding files. */
export type BrandingSlot = keyof BrandingFiles;

/** An upload as it arrives: the raw body and its headers. */
export interface BrandingUpload {
  /** The request body; a stream when sent as `application/octet-stream`. */
  body: unknown;
  /** The `x-file-name` header (percent-encoded), if sent. */
  fileName: string | undefined;
  /** The `content-length` header, if sent. */
  contentLength: string | undefined;
}

/** A branding file opened for sending. */
export interface OpenedBrandingFile {
  /** Its record. */
  file: StoredBrandingFile;
  /** Its content. */
  stream: ReadStream;
}

/** Folder inside the branding directory for uploads still being checked. */
const INCOMING = '.incoming';

/** Longest original file name kept for display. */
const NAME_MAX = 120;

/** Characters of the SHA-256 used to version public URLs. */
const VERSION_LENGTH = 16;

/**
 * Maps a font weight in a URL to its slot.
 *
 * @param weight `regular` or `bold`.
 * @returns The slot.
 */
export function fontSlot(weight: FontWeight): BrandingSlot {
  return weight === FontWeight.BOLD ? 'fontBold' : 'fontRegular';
}

/**
 * Admin branding (SPEC §6): app name, logo, and the UI font, a preset or
 * uploaded files (docs/DESIGN.md §6). Uploaded files are checked by content,
 * stored under random names in the branding folder outside the web root
 * (`BRANDING_DIR`) and served by the app itself.
 *
 * Changes are audited: `SETTINGS_UPDATED` for name and font,
 * `BRANDING_FILE_UPLOADED` / `BRANDING_FILE_REMOVED` for files.
 */
@Injectable()
export class BrandingService {
  private readonly logger = new Logger(BrandingService.name);

  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param settings Stored settings.
   * @param audit Audit log.
   * @param config Branding folder.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  /**
   * What every visitor needs, including the sign-in page: name, logo and
   * font locations and the default theme; nothing else.
   *
   * Permissions: public.
   *
   * @returns The public branding.
   */
  async publicBranding(): Promise<PublicBrandingDto> {
    const [branding, files, theme] = await Promise.all([
      this.settings.getBranding(),
      this.settings.getBrandingFiles(),
      this.settings.getTheme(),
    ]);
    // An uploaded font without its regular file falls back to Figtree.
    const uploaded = branding.font === UiFont.UPLOADED && files.fontRegular !== null;
    const font = branding.font === UiFont.UPLOADED && !uploaded ? UiFont.FIGTREE : branding.font;
    return {
      appName: branding.appName,
      logoUrl: files.logo === null ? null : brandingFileUrl('logo', version(files.logo)),
      font,
      fontFiles:
        uploaded && files.fontRegular !== null
          ? {
              regular: brandingFileUrl('fonts/regular', version(files.fontRegular)),
              bold:
                files.fontBold === null
                  ? null
                  : brandingFileUrl('fonts/bold', version(files.fontBold)),
            }
          : null,
      theme,
    };
  }

  /**
   * The branding settings as admins edit them.
   *
   * @returns Name, chosen font and the uploaded files.
   */
  async adminBranding(): Promise<BrandingSettingsDto> {
    const [branding, files] = await Promise.all([
      this.settings.getBranding(),
      this.settings.getBrandingFiles(),
    ]);
    return {
      appName: branding.appName,
      font: branding.font,
      logo: toDto(files.logo),
      fontFiles: { regular: toDto(files.fontRegular), bold: toDto(files.fontBold) },
    };
  }

  /**
   * Saves the app name and font. Choosing the uploaded font needs its
   * regular file.
   *
   * @param auth The admin.
   * @param body Name and font.
   * @returns The branding settings.
   */
  async save(auth: AuthContext, body: UpdateBrandingRequest): Promise<BrandingSettingsDto> {
    await serializable(this.prisma, async (tx) => {
      if (body.font === UiFont.UPLOADED) {
        const files = await this.settings.getBrandingFiles(tx);
        if (files.fontRegular === null) {
          throw invalidField('font', 'Upload a regular font file before choosing it');
        }
      }
      const value = { appName: body.appName, font: body.font };
      await this.settings.save(BRANDING_SETTINGS_KEY, value, tx);
      await this.audit.record(
        {
          actorId: auth.user.id,
          action: AuditAction.SETTINGS_UPDATED,
          entityType: 'AppSetting',
          meta: { key: BRANDING_SETTINGS_KEY, value },
        },
        tx,
      );
    });
    return this.adminBranding();
  }

  /**
   * Stores a new logo or font file, replacing the previous one. The file is
   * checked by content: the logo must be PNG, JPEG, GIF or WebP (never SVG),
   * a font WOFF2, WOFF, TTF or OTF.
   *
   * @param auth The admin.
   * @param slot Which file.
   * @param upload The raw body and headers.
   * @returns The branding settings; 413 over the size limit, 415 for other types.
   */
  async upload(
    auth: AuthContext,
    slot: BrandingSlot,
    upload: BrandingUpload,
  ): Promise<BrandingSettingsDto> {
    if (!(upload.body instanceof Readable)) {
      throw invalidField('file', 'Send the file as the request body (application/octet-stream)');
    }
    const maxBytes = slot === 'logo' ? LOGO_MAX_BYTES : FONT_MAX_BYTES;
    const declared = Number(upload.contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) throw fileTooLarge(maxBytes);
    const received = await receiveInto(this.incoming(), upload.body, maxBytes);
    let previous: StoredBrandingFile | null;
    let storedName: string | null = null;
    try {
      const type = detect(slot, received);
      const file: StoredBrandingFile = {
        storedName: randomUUID(),
        name: cleanFileName(upload.fileName, NAME_MAX),
        type,
        sizeBytes: received.sizeBytes,
        sha256: received.sha256,
        uploadedAt: new Date().toISOString(),
      };
      await mkdir(this.config.brandingDir, { recursive: true, mode: 0o750 });
      await rename(received.tempPath, this.path(file.storedName));
      storedName = file.storedName;
      previous = await serializable(this.prisma, async (tx) => {
        const files = await this.settings.getBrandingFiles(tx);
        const old = files[slot];
        await this.settings.save(BRANDING_FILES_KEY, toJson({ ...files, [slot]: file }), tx);
        await this.audit.record(
          {
            actorId: auth.user.id,
            action: AuditAction.BRANDING_FILE_UPLOADED,
            entityType: 'AppSetting',
            meta: {
              file: slot,
              name: file.name,
              type,
              sizeBytes: file.sizeBytes,
              sha256: file.sha256,
            },
          },
          tx,
        );
        return old;
      });
    } catch (error) {
      // Nothing recorded: remove the new file wherever it is now.
      await rm(received.tempPath, { force: true });
      if (storedName !== null) await this.deleteStored(storedName);
      throw error;
    }
    if (previous !== null) await this.deleteStored(previous.storedName);
    return this.adminBranding();
  }

  /**
   * Removes the logo or a font file. Removing the regular font also removes
   * the bold one and, when the uploaded font was chosen, switches back to
   * Figtree.
   *
   * @param auth The admin.
   * @param slot Which file.
   * @returns The branding settings.
   */
  async remove(auth: AuthContext, slot: BrandingSlot): Promise<BrandingSettingsDto> {
    const removed = await serializable(this.prisma, async (tx) => {
      const files = await this.settings.getBrandingFiles(tx);
      // Nothing to remove: a bold file alone stays when no regular one exists.
      if (files[slot] === null) return [];
      const slots: BrandingSlot[] = slot === 'fontRegular' ? ['fontRegular', 'fontBold'] : [slot];
      const gone = slots.filter((s) => files[s] !== null);
      const next = { ...files };
      for (const s of slots) next[s] = null;
      await this.settings.save(BRANDING_FILES_KEY, toJson(next), tx);
      let fontReset = false;
      if (slot === 'fontRegular') {
        const branding = await this.settings.getBranding(tx);
        if (branding.font === UiFont.UPLOADED) {
          await this.settings.save(
            BRANDING_SETTINGS_KEY,
            { appName: branding.appName, font: UiFont.FIGTREE },
            tx,
          );
          fontReset = true;
        }
      }
      // One entry names every file removed and whether the font changed.
      await this.audit.record(
        {
          actorId: auth.user.id,
          action: AuditAction.BRANDING_FILE_REMOVED,
          entityType: 'AppSetting',
          meta: { file: slot, removed: gone, fontReset },
        },
        tx,
      );
      return gone.flatMap((s) => (files[s] === null ? [] : [files[s]]));
    });
    for (const file of removed) await this.deleteStored(file.storedName);
    return this.adminBranding();
  }

  /**
   * Opens a branding file for sending.
   *
   * Permissions: public; these files are part of every page's look.
   *
   * @param slot Which file.
   * @returns The record and content; 404 when there is none.
   */
  async open(slot: BrandingSlot): Promise<OpenedBrandingFile> {
    const file = (await this.settings.getBrandingFiles())[slot];
    if (file === null) throw notFound(slot === 'logo' ? 'Logo' : 'Font file');
    const path = this.path(file.storedName);
    try {
      await stat(path);
    } catch {
      this.logger.warn(`Branding file missing: ${file.storedName}`);
      throw notFound(slot === 'logo' ? 'Logo' : 'Font file');
    }
    return { file, stream: createReadStream(path) };
  }

  /**
   * The ETag of a branding file.
   *
   * @param file Its record.
   * @returns A strong ETag from its hash.
   */
  etag(file: StoredBrandingFile): string {
    return `"${file.sha256}"`;
  }

  /**
   * Folder for uploads still being checked.
   *
   * @returns The path.
   */
  private incoming(): string {
    return join(this.config.brandingDir, INCOMING);
  }

  /**
   * Path of a stored file. Stored names are uuids the app chose.
   *
   * @param storedName Stored name.
   * @returns The path.
   */
  private path(storedName: string): string {
    return join(this.config.brandingDir, storedName);
  }

  /**
   * Deletes a stored file after its record is gone. Failures are logged.
   *
   * @param storedName Stored name.
   * @returns Resolves once attempted.
   */
  private async deleteStored(storedName: string): Promise<void> {
    try {
      await rm(this.path(storedName), { force: true });
    } catch (error) {
      this.logger.error(`Could not delete branding file ${storedName}: ${String(error)}`);
    }
  }
}

/**
 * Detects the type of an uploaded branding file from its content.
 *
 * @param slot Which file it is meant to be.
 * @param received The upload.
 * @returns The type; 415 when it is not an accepted one.
 */
function detect(slot: BrandingSlot, received: ReceivedFile): string {
  if (slot === 'logo') {
    const type = sniffType(received.head);
    if (isInlineImageType(type)) return type;
    throw new ApiException(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      ErrorCode.UNSUPPORTED_FILE_TYPE,
      'The logo must be a PNG, JPEG, GIF or WebP image',
    );
  }
  const type = sniffFont(received.head);
  if (type !== null) return type;
  throw new ApiException(
    HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    ErrorCode.UNSUPPORTED_FILE_TYPE,
    'Fonts must be WOFF2, WOFF, TTF or OTF files',
  );
}

/**
 * The short version of a file used in its public URL.
 *
 * @param file The record.
 * @returns A prefix of its SHA-256.
 */
function version(file: StoredBrandingFile): string {
  return file.sha256.slice(0, VERSION_LENGTH);
}

/**
 * A file record as admins see it.
 *
 * @param file The record, or null.
 * @returns The DTO, or null.
 */
function toDto(file: StoredBrandingFile | null): BrandingFileDto | null {
  return file === null
    ? null
    : { name: file.name, type: file.type, sizeBytes: file.sizeBytes, uploadedAt: file.uploadedAt };
}

/**
 * One file record as a JSON value.
 *
 * @param file The record, or null.
 * @returns A plain object, or null.
 */
function fileJson(file: StoredBrandingFile | null): Prisma.InputJsonObject | null {
  return file === null
    ? null
    : {
        storedName: file.storedName,
        name: file.name,
        type: file.type,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        uploadedAt: file.uploadedAt,
      };
}

/**
 * The file records as a JSON value for `AppSetting`.
 *
 * @param files The records.
 * @returns A plain object.
 */
function toJson(files: BrandingFiles): Prisma.InputJsonObject {
  return {
    logo: fileJson(files.logo),
    fontRegular: fileJson(files.fontRegular),
    fontBold: fileJson(files.fontBold),
  };
}
