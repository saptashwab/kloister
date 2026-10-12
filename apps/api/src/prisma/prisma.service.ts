import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppConfig } from '../config/app-config.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * The single Prisma client for the process, injectable anywhere.
 *
 * It connects lazily on the first query, so the app (and tests that never
 * touch the database) can start without Postgres being reachable.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param config Supplies the connection string.
   */
  constructor(config: AppConfig) {
    super({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) });
  }

  /**
   * Closes the connection pool on shutdown.
   *
   * @returns Resolves once the pool is closed.
   */
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
