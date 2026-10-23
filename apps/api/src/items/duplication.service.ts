import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ErrorCode, inlineImagePath, ItemStatus, type WorkItemDetailDto } from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { conflict, invalidField } from '../common/api-exception.js';
import { inlineSources, rewriteImages } from './snapshot-images.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { FileStoreService } from '../storage/file-store.service.js';
import { isInlineImageType, sniffType } from '../storage/file-types.js';
import type { DuplicateDto } from './duplication.dto.js';
import { sanitizeItemText } from './item-rich-text.js';
import { ItemsService } from './items.service.js';

/** Atomic same-space duplication through the ordinary scoped creation path. */
@Injectable()
export class DuplicationService {
  /**
   * Receives scoped item creation, storage and quota collaborators.
   * @param prisma Database transactions.
   * @param items Ordinary creation and source visibility.
   * @param files Content-checked independent file storage.
   * @param settings Current size and storage limits.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly files: FileStoreService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Creates every confirmed copy or rolls back the batch and its files.
   * Permissions: create guard, fully readable source, ordinary destination/assignment checks.
   * @param auth Caller and creator of all copies.
   * @param access Same-space access resolved by the project guard.
   * @param ref Fully readable source identifier.
   * @param dto Confirmed titles, assignments and explicit keep options.
   * @returns Independent items with reset progress and new numbers.
   */
  async duplicate(
    auth: AuthContext,
    access: ProjectAccess,
    ref: string,
    dto: DuplicateDto,
  ): Promise<WorkItemDetailDto[]> {
    const limits = await this.settings.getStorage();
    const kept: { projectId: string; storedName: string }[] = [];
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // The project lock serializes numbering and quota consumption for the entire batch.
          await tx.$queryRaw`SELECT 1 FROM "Project" WHERE "id" = ${access.project.id}::uuid FOR UPDATE`;
          const sourceRow = await this.items.findVisible(tx, access, ref);
          const source = await this.items.detail(tx, access, sourceRow);
          const imageSources = inlineSources(source.description);
          const imageIds = imageSources.map((path) => path.split('/').at(-1) ?? '');
          if (
            imageSources.some(
              (path, index) =>
                path !== inlineImagePath(access.project.id, source.id, imageIds[index] ?? ''),
            )
          )
            throw invalidField('description', 'A description image has an invalid source');
          const files = await tx.attachment.findMany({
            where: {
              workItemId: source.id,
              OR: [
                { inline: true, id: { in: imageIds } },
                ...(dto.attachments === true ? [{ inline: false }] : []),
              ],
            },
          });
          if (imageIds.some((id) => !files.some((f) => f.inline && f.id === id)))
            throw invalidField(
              'description',
              'A description image is no longer readable; refresh the source',
            );
          const quota =
            (access.project.ownerId === null ? limits.projectQuotaMb : limits.personalQuotaMb) *
            1024 *
            1024;
          const [usage] = await tx.$queryRaw<
            { used: bigint }[]
          >`SELECT COALESCE(SUM(a."sizeBytes"), 0)::bigint AS "used" FROM "Attachment" a JOIN "WorkItem" w ON w."id" = a."workItemId" WHERE w."projectId" = ${access.project.id}::uuid`;
          if (
            Number(usage?.used ?? 0) +
              files.reduce((sum, f) => sum + f.sizeBytes, 0) * dto.copies.length >
            quota
          )
            throw conflict('The copies would exceed the storage quota', ErrorCode.QUOTA_EXCEEDED);
          const result: WorkItemDetailDto[] = [];
          for (const copy of dto.copies) {
            const item = await this.items.create(
              auth,
              access,
              {
                type: source.type,
                title: copy.title,
                priority: source.priority,
                labelIds: source.labelIds,
                bucketId: dto.bucketId ?? null,
                teamId: dto.teamId ?? null,
                parentId: dto.parentId ?? null,
                assigneeIds: copy.assigneeIds,
                status: ItemStatus.NOT_STARTED,
                ...(dto.keepDates === true
                  ? {
                      startDate: source.startDate,
                      dueDate: source.dueDate,
                      dueTime: source.dueTime,
                    }
                  : {}),
                ...(dto.keepSprint === true ? { sprintId: source.sprintId } : {}),
              },
              tx,
            );
            await tx.checklistItem.createMany({
              data: source.checklistItems.map((line, index) => ({
                workItemId: item.id,
                text: line.text,
                done: false,
                position: index + 1,
              })),
            });
            const copiedImages = new Map<string, string>();
            for (const file of files) {
              // Each file is independently bound to the readable source, copied and sniffed again.
              await this.items.findVisible(tx, access, source.id);
              const received = await this.files.receive(
                await this.files.open(access.project.id, file.storedName),
                limits.maxFileSizeMb * 1024 * 1024,
              );
              const storedName = randomUUID();
              try {
                const detected = sniffType(received.head);
                if (
                  received.sha256 !== file.sha256 ||
                  received.sizeBytes !== file.sizeBytes ||
                  (file.inline && !isInlineImageType(detected))
                )
                  throw invalidField('file', 'Source file content has changed or is invalid');
                const added = await tx.attachment.create({
                  data: {
                    workItemId: item.id,
                    uploaderId: auth.user.id,
                    originalName: file.originalName,
                    storedName,
                    sizeBytes: received.sizeBytes,
                    sha256: received.sha256,
                    mimeType: file.mimeType,
                    inline: file.inline,
                  },
                });
                await this.files.keep(received, access.project.id, storedName);
                kept.push({ projectId: access.project.id, storedName });
                if (file.inline)
                  copiedImages.set(
                    inlineImagePath(access.project.id, source.id, file.id),
                    inlineImagePath(access.project.id, item.id, added.id),
                  );
              } finally {
                await this.files.discard(received);
              }
            }
            const description = rewriteImages(source.description, (path) => {
              const copied = copiedImages.get(path);
              if (copied === undefined)
                throw invalidField('description', 'A description image could not be copied');
              return copied;
            });
            const safe = await sanitizeItemText(tx, access.project.id, item.id, description);
            await tx.workItem.update({ where: { id: item.id }, data: { description: safe.html } });
            const row = await this.items.findVisible(tx, access, item.id);
            result.push(await this.items.detail(tx, access, row));
          }
          return result;
        },
        { timeout: 120_000 },
      );
    } catch (error) {
      await this.files.remove(kept);
      throw error;
    }
  }
}
