import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FileStoreService } from '../storage/file-store.service.js';
import { AttachmentsService } from './attachments.service.js';

/** Inline images unused for this long are removed. */
export const UNUSED_IMAGE_GRACE_MS = 24 * 60 * 60 * 1000;

/** Uploads still in the incoming folder after this long were abandoned. */
export const INCOMING_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Scheduled clean-up every night at 03:30 server time: inline images that no
 * description or note uses any more, so they stop counting toward the
 * project's quota (SPEC §5), and abandoned uploads in the incoming folder.
 */
@Injectable()
export class AnnotationJobs {
  private readonly logger = new Logger(AnnotationJobs.name);

  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param attachments Attachment and image operations.
   * @param files File storage.
   */
  constructor(
    private readonly attachments: AttachmentsService,
    private readonly files: FileStoreService,
  ) {}

  /**
   * Removes unused inline images older than a day and abandoned uploads.
   * Failures are logged and retried the next night.
   *
   * @returns Resolves once done.
   */
  @Cron('30 3 * * *', { name: 'unused-inline-images' })
  async removeUnusedImages(): Promise<void> {
    try {
      const removed = await this.attachments.removeUnusedImages(
        new Date(Date.now() - UNUSED_IMAGE_GRACE_MS),
      );
      const abandoned = await this.files.sweepIncoming(INCOMING_MAX_AGE_MS);
      this.logger.log(`Removed ${removed} unused inline images and ${abandoned} abandoned uploads`);
    } catch (error) {
      this.logger.error(`Inline image clean-up failed: ${String(error)}`);
    }
  }
}
