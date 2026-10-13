import { Module } from '@nestjs/common';
import { FileStoreService } from './file-store.service.js';

/**
 * File storage for attachments and inline images (SPEC §5), outside the web
 * root. Used by the annotations module (uploads, downloads) and the items
 * module (removing files with deleted items).
 */
@Module({
  providers: [FileStoreService],
  exports: [FileStoreService],
})
export class StorageModule {}
