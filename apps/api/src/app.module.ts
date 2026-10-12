import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';

/**
 * Root module. Feature modules (auth, projects, items, …) are added here as
 * each milestone lands.
 */
@Module({
  imports: [HealthModule],
})
export class AppModule {}
