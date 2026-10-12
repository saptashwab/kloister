import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';

/**
 * Liveness endpoint used by the deploy scripts (SPEC §8, §9.4 step 11).
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
