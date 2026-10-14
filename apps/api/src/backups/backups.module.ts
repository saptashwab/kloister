import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { BackupsController } from './backups.controller.js';
import { BackupsService, COMMAND_RUNNER } from './backups.service.js';
import { spawnCommand } from './pg-dump.js';

/**
 * Postgres backups (SPEC §6, §9.1): the daily pg_dump, "run now" and the
 * retention clean-up. pg_dump connects to the local database only; nothing
 * calls out to other hosts.
 */
@Module({
  imports: [AuditModule, SettingsModule],
  controllers: [BackupsController],
  providers: [BackupsService, { provide: COMMAND_RUNNER, useValue: spawnCommand }],
})
export class BackupsModule {}
