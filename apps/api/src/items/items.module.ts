import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { ChecklistController } from './checklist.controller.js';
import { ChecklistService } from './checklist.service.js';
import { DependenciesService } from './dependencies.service.js';
import { ItemsController } from './items.controller.js';
import { ItemsService } from './items.service.js';

/**
 * Work items with their hierarchy, dependencies, team assignment, checklist
 * and bucket/status rules (SPEC §4, M3). Every rule goes through
 * `ProjectAccessService` from `ProjectsModule`.
 */
@Module({
  imports: [AuditModule, ProjectsModule],
  controllers: [ItemsController, ChecklistController],
  providers: [ItemsService, DependenciesService, ChecklistService],
})
export class ItemsModule {}
