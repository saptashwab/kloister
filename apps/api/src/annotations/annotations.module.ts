import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ItemsModule } from '../items/items.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { AnnotationJobs } from './annotation-jobs.js';
import { AttachmentsController, InlineImagesController } from './attachments.controller.js';
import { AttachmentsService } from './attachments.service.js';
import { NotesController } from './notes.controller.js';
import { NotesService } from './notes.service.js';

/**
 * Notes with `@mention`, attachments, and images pasted or dropped into
 * descriptions and notes (SPEC §4, §5, §6; M5). Items are found through
 * `ItemsService` and permissions decided by `ProjectAccessService`, like
 * every other item route.
 */
@Module({
  imports: [
    AuditModule,
    ProjectsModule,
    ItemsModule,
    NotificationsModule,
    SettingsModule,
    StorageModule,
  ],
  controllers: [NotesController, AttachmentsController, InlineImagesController],
  providers: [NotesService, AttachmentsService, AnnotationJobs],
})
export class AnnotationsModule {}
