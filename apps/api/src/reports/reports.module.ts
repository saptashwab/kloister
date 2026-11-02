import { Module } from '@nestjs/common';
import { ItemsModule } from '../items/items.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { CalendarService } from './calendar.service.js';
import { CalendarController, ReportsController } from './reports.controller.js';

/**
 * Project reports and the My work calendar (SPEC §6.5, M13), computed from
 * the items the caller can see through the rules of `ItemsModule` (which
 * provides the report calculations, also used by the Excel export) and
 * `ProjectsModule`.
 */
@Module({
  imports: [ItemsModule, ProjectsModule],
  controllers: [ReportsController, CalendarController],
  providers: [CalendarService],
})
export class ReportsModule {}
