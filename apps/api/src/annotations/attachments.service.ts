import { randomUUID } from 'node:crypto';
import type { ReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type AnnotationCapabilitiesDto,
  API_PREFIX,
  ATTACHMENT_NAME_MAX,
  type AttachmentDto,
  AuditAction,
  ErrorCode,
  type InlineImageDto,
  inlineImagePath,
  type Page,
} from '@kloister/shared';
import type { DbClient } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import {
  ApiException,
  conflict,
  forbidden,
  invalidField,
  notFound,
} from '../common/api-exception.js';
import { type PageQueryDto, pageArgs, toPage } from '../common/pagination.js';
import { serializable } from '../common/transactions.js';
import type { Attachment } from '../generated/prisma/client.js';
import { type ItemRow, itemFacts } from '../items/item.mapper.js';
import { ItemsService } from '../items/items.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type ProjectAccess, ProjectAccessService } from '../projects/project-access.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { FileStoreService, fileTooLarge } from '../storage/file-store.service.js';
import {
  cleanFileName,
  isInlineImageType,
  sniffType,
  UNKNOWN_TYPE,
} from '../storage/file-types.js';

/** An attachment row with its uploader's name. */
type AttachmentRow = Attachment & { uploader: { displayName: string } };

/** Bytes in a megabyte, for the admin's limits. */
const MB = 1024 * 1024;

/** An upload as it arrives: the raw body and its headers. */
export interface Upload {
  /** The request body; a stream when sent as `application/octet-stream`. */
  body: unknown;
  /** The `x-file-name` header (percent-encoded), if sent. */
  fileName: string | undefined;
  /** The `content-length` header, if sent. */
  contentLength: string | undefined;
}

/** A stored file opened for sending. */
export interface OpenedFile {
  /** The file's row. */
  row: Attachment;
  /** Its bytes. */
  stream: ReadStream;
}

/**
 * Attachments and inline images (SPEC §4 `Attachment`, §5, §6).
 *
 * Permissions (SPEC §3.2 "Notes and attachments on visible items"): reading,
 * listing and downloading need a visible item (404 otherwise); uploading
 * needs `ANNOTATE_ITEMS` (PM, Lead, Member; 403 for Viewers and non-member
 * admins). The uploader, PMs, Leads and the item's team Leads may delete an
 * attachment.
 *
 * Storage rules (SPEC §5): files live outside the web root under random
 * names; size limit and per-project quota come from the admin's storage
 * settings, and inline images use the same limit and count toward the same
 * quota. Types are detected from the content; inline images must be PNG,
 * JPEG, GIF or WebP (never SVG).
 */
@Injectable()
export class AttachmentsService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param items Item lookup through the visibility filter, and audit.
   * @param access Permission rules.
   * @param settings Size limit and quota.
   * @param files File storage.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly access: ProjectAccessService,
    private readonly settings: SettingsService,
    private readonly files: FileStoreService,
  ) {}

  /**
   * Lists an item's attachments (not its inline images), newest first.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @param page Cursor and page size.
   * @returns One page of attachments.
   */
  async list(
    auth: AuthContext,
    access: ProjectAccess,
    ref: string,
    page: PageQueryDto,
  ): Promise<Page<AttachmentDto>> {
    const item = await this.items.findVisible(this.prisma, access, ref);
    const where = { workItemId: item.id, inline: false };
    if (page.cursor !== undefined) {
      const cursor = await this.prisma.attachment.count({ where: { ...where, id: page.cursor } });
      if (cursor === 0) return { items: [], nextCursor: null };
    }
    const rows = await this.prisma.attachment.findMany({
      where,
      include: { uploader: { select: { displayName: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...pageArgs(page),
    });
    return toPage(rows, page, (row) => this.toDto(auth, access, item, row));
  }

  /**
   * Stores an uploaded attachment.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @param upload The request body and headers.
   * @returns The attachment (201).
   */
  async attach(
    auth: AuthContext,
    access: ProjectAccess,
    ref: string,
    upload: Upload,
  ): Promise<AttachmentDto> {
    const { row, item } = await this.store(auth, access, ref, upload, false);
    return this.toDto(auth, access, item, row);
  }

  /**
   * Stores an image pasted or dropped into the item's description or a note.
   * It is not listed as an attachment; the returned URL is the only image
   * source the sanitizer keeps for this item.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @param upload The request body and headers.
   * @returns The image (201); 415 unless PNG, JPEG, GIF or WebP by content.
   */
  async addImage(
    auth: AuthContext,
    access: ProjectAccess,
    ref: string,
    upload: Upload,
  ): Promise<InlineImageDto> {
    const { row, item } = await this.store(auth, access, ref, upload, true);
    if (!isInlineImageType(row.mimeType)) throw new Error('stored a non-image inline');
    return {
      id: row.id,
      url: inlineImagePath(access.project.id, item.id, row.id),
      name: row.originalName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
    };
  }

  /**
   * Opens an attachment or inline image of a visible item for sending.
   *
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @param id Attachment or image id.
   * @param inline True for inline images, false for attachments.
   * @returns The row and its bytes; 404 if not found or not visible.
   */
  async open(access: ProjectAccess, ref: string, id: string, inline: boolean): Promise<OpenedFile> {
    const item = await this.items.findVisible(this.prisma, access, ref);
    const row = await this.prisma.attachment.findFirst({
      where: { id, workItemId: item.id, inline },
    });
    if (row === null) throw notFound(inline ? 'Image' : 'Attachment');
    return { row, stream: await this.files.open(access.project.id, row.storedName) };
  }

  /**
   * Deletes an attachment and its file.
   *
   * Permissions: its uploader while they may annotate the item, or a
   * moderator (PMs, Leads, the item's team Leads); 403 otherwise.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @param id Attachment id.
   * @returns Resolves once deleted (204).
   */
  async remove(auth: AuthContext, access: ProjectAccess, ref: string, id: string): Promise<void> {
    const row = await serializable(this.prisma, async (tx) => {
      const item = await this.items.findVisible(tx, access, ref);
      const attachment = await tx.attachment.findFirst({
        where: { id, workItemId: item.id, inline: false },
      });
      if (attachment === null) throw notFound('Attachment');
      if (!this.capabilities(auth, access, item, attachment).delete) throw forbidden();
      await tx.attachment.delete({ where: { id: attachment.id } });
      await this.items.record(tx, auth, access, AuditAction.ATTACHMENT_DELETED, item.id, {
        number: item.number,
        attachmentId: attachment.id,
        name: attachment.originalName,
      });
      return attachment;
    });
    await this.files.remove([{ projectId: access.project.id, storedName: row.storedName }]);
  }

  /**
   * Removes inline images that no description or note of their item uses
   * any more (pasted and then deleted, or never saved), once they are older
   * than `before`. They count toward the quota, so they are not kept forever.
   *
   * Each item is checked in its own serializable transaction, like the
   * description and note writes that read the item's images, so an image
   * saved into a text at the same moment is never deleted from under it
   * (one of the two transactions is refused and retried by its caller).
   *
   * @param before Only images uploaded before this moment.
   * @returns How many images were removed.
   */
  async removeUnusedImages(before: Date): Promise<number> {
    const items = await this.prisma.attachment.findMany({
      where: { inline: true, createdAt: { lt: before } },
      select: { workItemId: true },
      distinct: ['workItemId'],
    });
    let removed = 0;
    for (const { workItemId } of items) {
      const unused = await serializable(this.prisma, async (tx) => {
        const item = await tx.workItem.findUnique({
          where: { id: workItemId },
          select: {
            projectId: true,
            description: true,
            notes: { select: { body: true } },
            attachments: {
              where: { inline: true, createdAt: { lt: before } },
              select: { id: true, storedName: true },
            },
          },
        });
        if (item === null) return [];
        const texts = [item.description, ...item.notes.map((n) => n.body)];
        const gone = item.attachments.filter((image) => !texts.some((t) => t.includes(image.id)));
        if (gone.length > 0) {
          await tx.attachment.deleteMany({ where: { id: { in: gone.map((g) => g.id) } } });
        }
        return gone.map((g) => ({ projectId: item.projectId, storedName: g.storedName }));
      }).catch(() => []);
      await this.files.remove(unused);
      removed += unused.length;
    }
    return removed;
  }

  /**
   * Receives, checks and stores an upload, then writes its row.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @param upload The request body and headers.
   * @param inline True for inline images.
   * @returns The new row and the item.
   */
  private async store(
    auth: AuthContext,
    access: ProjectAccess,
    ref: string,
    upload: Upload,
    inline: boolean,
  ): Promise<{ row: AttachmentRow; item: ItemRow }> {
    // Permission first, so nothing is read from a refused request.
    await this.annotatable(this.prisma, access, ref);
    if (!(upload.body instanceof Readable)) {
      throw invalidField('file', 'Send the file as the request body (application/octet-stream)');
    }
    const { maxFileSizeMb, projectQuotaMb, personalQuotaMb } = await this.settings.getStorage();
    const quotaMb = access.project.ownerId === null ? projectQuotaMb : personalQuotaMb;
    const maxBytes = maxFileSizeMb * MB;
    const declared = Number(upload.contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) throw fileTooLarge(maxBytes);
    // A declared size over the remaining quota is refused before anything is
    // written; the locked check below still decides for every upload.
    if (Number.isFinite(declared)) {
      await this.assertQuota(this.prisma, access.project.id, declared, quotaMb * MB, false);
    }

    const file = await this.files.receive(upload.body, maxBytes);
    const storedName = randomUUID();
    let kept = false;
    try {
      const detected = sniffType(file.head);
      if (inline && !isInlineImageType(detected)) {
        throw new ApiException(
          HttpStatus.UNSUPPORTED_MEDIA_TYPE,
          ErrorCode.UNSUPPORTED_FILE_TYPE,
          'Only PNG, JPEG, GIF and WebP images can be pasted or dropped in',
        );
      }
      return await this.prisma.$transaction(async (tx) => {
        const item = await this.annotatable(tx, access, ref);
        await this.assertQuota(tx, access.project.id, file.sizeBytes, quotaMb * MB, true);
        const row = await tx.attachment.create({
          data: {
            workItemId: item.id,
            uploaderId: auth.user.id,
            originalName: cleanFileName(upload.fileName, ATTACHMENT_NAME_MAX),
            storedName,
            sizeBytes: file.sizeBytes,
            mimeType: detected ?? UNKNOWN_TYPE,
            sha256: file.sha256,
            inline,
          },
          include: { uploader: { select: { displayName: true } } },
        });
        if (!inline) {
          await this.items.record(tx, auth, access, AuditAction.ATTACHMENT_ADDED, item.id, {
            number: item.number,
            attachmentId: row.id,
            name: row.originalName,
            sizeBytes: row.sizeBytes,
          });
        }
        // In place before the row commits; a failed commit removes it below.
        await this.files.keep(file, access.project.id, storedName);
        kept = true;
        return { row, item };
      });
    } catch (error) {
      await this.files.discard(file);
      if (kept) await this.files.remove([{ projectId: access.project.id, storedName }]);
      throw error;
    }
  }

  /**
   * Refuses an upload that would take the project over its quota. With
   * `lock`, the project row is locked first, so concurrent uploads are
   * counted one after another.
   *
   * @param db Database or transaction client.
   * @param projectId Project id.
   * @param sizeBytes The upload's size.
   * @param quotaBytes The quota.
   * @param lock Lock the project row (inside the transaction that stores the upload).
   */
  private async assertQuota(
    db: DbClient,
    projectId: string,
    sizeBytes: number,
    quotaBytes: number,
    lock: boolean,
  ): Promise<void> {
    if (lock) {
      await db.$queryRaw`SELECT 1 FROM "Project" WHERE "id" = ${projectId}::uuid FOR UPDATE`;
    }
    const [usage] = await db.$queryRaw<{ used: bigint }[]>`
      SELECT COALESCE(SUM(a."sizeBytes"), 0)::bigint AS "used"
      FROM "Attachment" a JOIN "WorkItem" w ON w."id" = a."workItemId"
      WHERE w."projectId" = ${projectId}::uuid`;
    if (Number(usage?.used ?? 0) + sizeBytes > quotaBytes) {
      throw conflict(
        `This project has used its storage quota of ${Math.floor(quotaBytes / MB)} MB`,
        ErrorCode.QUOTA_EXCEEDED,
      );
    }
  }

  /**
   * Loads a visible item the caller may annotate.
   *
   * @param db Database or transaction client.
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @returns The item; 404 if invisible, 403 if not annotatable.
   */
  private async annotatable(db: DbClient, access: ProjectAccess, ref: string): Promise<ItemRow> {
    const item = await this.items.findVisible(db, access, ref);
    if (!this.access.canAnnotateItem(access, itemFacts(item))) throw forbidden();
    return item;
  }

  /**
   * What the caller may do with an attachment.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param item The item.
   * @param row The attachment.
   * @returns The capabilities.
   */
  private capabilities(
    auth: AuthContext,
    access: ProjectAccess,
    item: ItemRow,
    row: Pick<Attachment, 'uploaderId'>,
  ): AnnotationCapabilitiesDto {
    const facts = itemFacts(item);
    const own = row.uploaderId === auth.user.id && this.access.canAnnotateItem(access, facts);
    return { edit: false, delete: own || this.access.canModerateAnnotations(access, facts) };
  }

  /**
   * Converts an attachment to its API shape.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param item The item.
   * @param row The attachment with its uploader's name.
   * @returns The DTO.
   */
  private toDto(
    auth: AuthContext,
    access: ProjectAccess,
    item: ItemRow,
    row: AttachmentRow,
  ): AttachmentDto {
    return {
      id: row.id,
      name: row.originalName,
      sizeBytes: row.sizeBytes,
      mimeType: row.mimeType,
      uploaderId: row.uploaderId,
      uploaderName: row.uploader.displayName,
      createdAt: row.createdAt.toISOString(),
      url: `${API_PREFIX}/projects/${access.project.id}/items/${item.id}/attachments/${row.id}`,
      can: this.capabilities(auth, access, item, row),
    };
  }
}
