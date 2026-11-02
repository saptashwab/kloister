import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TrashService } from './trash.service.js';

/**
 * Scheduled purge every night at 03:45 server time (M12): delete batches
 * older than the admin's trash retention are removed for good.
 */
@Injectable()
export class TrashJobs {
  private readonly logger = new Logger(TrashJobs.name);

  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param trash Trash operations.
   */
  constructor(private readonly trash: TrashService) {}

  /**
   * Purges expired batches. Failures are logged and retried the next night.
   *
   * @returns Resolves once done.
   */
  @Cron('45 3 * * *', { name: 'trash-purge' })
  async purgeExpired(): Promise<void> {
    try {
      const purged = await this.trash.purgeExpired(new Date());
      this.logger.log(`Purged ${purged} expired trash batches`);
    } catch (error) {
      this.logger.error(`Trash purge failed: ${String(error)}`);
    }
  }
}
