import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ChecklistController } from './checklist.controller.js';
import { ChecklistService } from './checklist.service.js';
import { DependenciesService } from './dependencies.service.js';
import { ItemsController } from './items.controller.js';
import { ItemsService } from './items.service.js';
import { WorkController } from './work.controller.js';
import { WorkService } from './work.service.js';

/**
 * Work items with their hierarchy, dependencies, team assignment, checklist
 * and bucket/status rules (SPEC §4, M3), plus a person's work across
 * projects (SPEC §6). Every rule goes through
 * `ProjectAccessService` from `ProjectsModule`. Exports {@link ItemsService}
 * so notes and attachments find items through the same visibility filter.
 */
@Module({
  imports: [AuditModule, ProjectsModule, NotificationsModule, StorageModule],
  controllers: [ItemsController, ChecklistController, WorkController],
  providers: [ItemsService, DependenciesService, ChecklistService, WorkService],
  exports: [ItemsService],
})
export class ItemsModule {}
