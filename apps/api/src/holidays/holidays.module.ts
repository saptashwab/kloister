import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { AdminHolidaysController, ProjectHolidaysController } from './holidays.controller.js';
import { HolidaysService } from './holidays.service.js';

/**
 * Whole-day holidays for the timeline (SPEC §6.4, M9.1): instance-wide and
 * per project. Exports {@link HolidaysService} so the timeline planner and
 * exports use the same calendar.
 */
@Module({
  imports: [AuditModule, ProjectsModule],
  controllers: [ProjectHolidaysController, AdminHolidaysController],
  providers: [HolidaysService],
  exports: [HolidaysService],
})
export class HolidaysModule {}
