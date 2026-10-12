import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { MembersController } from './members.controller.js';
import { MembersService } from './members.service.js';
import { ProjectAccessGuard } from './project-access.guard.js';
import { ProjectAccessService } from './project-access.service.js';
import { ProjectController, ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';

/**
 * Projects, members and project-level authorization. Exports
 * {@link ProjectAccessService} and {@link ProjectAccessGuard} so later
 * modules (items, buckets, export) enforce access the same way (SPEC §3.4).
 */
@Module({
  imports: [AuditModule],
  controllers: [ProjectsController, ProjectController, MembersController],
  providers: [ProjectAccessService, ProjectAccessGuard, ProjectsService, MembersService],
  exports: [ProjectAccessService, ProjectAccessGuard],
})
export class ProjectsModule {}
