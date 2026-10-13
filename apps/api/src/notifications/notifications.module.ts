import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { NotificationJobs } from './notification-jobs.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

/**
 * In-app notifications (SPEC §6): the recipient's endpoints, the daily
 * due-date check, and {@link NotificationsService.notify} for the item and
 * note modules. Visibility comes from `ProjectAccessService`.
 */
@Module({
  imports: [ProjectsModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationJobs],
  exports: [NotificationsService],
})
export class NotificationsModule {}
