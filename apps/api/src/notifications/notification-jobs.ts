import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DUE_DATE_CRON } from './due-dates.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Scheduled notification work: the due-date check every day at 09:00 server
 * time (SPEC §6), on the server's local clock.
 */
@Injectable()
export class NotificationJobs {
  private readonly logger = new Logger(NotificationJobs.name);

  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param notifications Notification operations.
   */
  constructor(private readonly notifications: NotificationsService) {}

  /**
   * Runs the daily due-date check. Failures are logged; the next day's run
   * catches up on overdue items (within a week).
   *
   * @returns Resolves once done.
   */
  @Cron(DUE_DATE_CRON, { name: 'due-date-notifications' })
  async dueDates(): Promise<void> {
    try {
      const created = await this.notifications.checkDueDates(new Date());
      this.logger.log(`Due-date check created ${created} notifications`);
    } catch (error) {
      this.logger.error(`Due-date check failed: ${String(error)}`);
    }
  }
}
