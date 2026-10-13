import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { BucketsController } from './buckets.controller.js';
import { BucketsService } from './buckets.service.js';
import { LabelsController } from './labels.controller.js';
import { LabelsService } from './labels.service.js';
import { SprintsController } from './sprints.controller.js';
import { SprintsService } from './sprints.service.js';

/**
 * Board structure: buckets with their entry rules, labels and sprints
 * (SPEC §4, §4.2). Authorization comes from `ProjectsModule`'s
 * `ProjectAccessGuard`.
 */
@Module({
  imports: [AuditModule, ProjectsModule],
  controllers: [BucketsController, LabelsController, SprintsController],
  providers: [BucketsService, LabelsService, SprintsService],
})
export class BoardModule {}
