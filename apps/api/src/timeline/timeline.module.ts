import { Module } from '@nestjs/common';
import { HolidaysModule } from '../holidays/holidays.module.js';
import { ItemsModule } from '../items/items.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { TimelineController } from './timeline.controller.js';
import { TimelineService } from './timeline.service.js';

/**
 * The project timeline (SPEC §6.4, M9): visible dependency links and
 * rescheduling with dependent moves, built on the item rules of
 * `ItemsModule` and the access rules of `ProjectsModule`.
 */
@Module({
  imports: [ItemsModule, ProjectsModule, HolidaysModule],
  controllers: [TimelineController],
  providers: [TimelineService],
})
export class TimelineModule {}
