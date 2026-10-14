import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AdminSettingsController } from './admin-settings.controller.js';
import { AdminSettingsService } from './admin-settings.service.js';
import { SettingsModule } from './settings.module.js';

/**
 * The admin settings screens' endpoints (SPEC §6 Admin): security, storage
 * with disk usage, log retention and the default theme. Kept apart from
 * {@link SettingsModule}, which every feature imports to read settings.
 */
@Module({
  imports: [AuditModule, SettingsModule],
  controllers: [AdminSettingsController],
  providers: [AdminSettingsService],
})
export class AdminSettingsModule {}
