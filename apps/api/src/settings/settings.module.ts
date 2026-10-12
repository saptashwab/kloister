import { Module } from '@nestjs/common';
import { SettingsService } from './settings.service.js';

/** Admin-editable application settings. Admin endpoints are added in M6. */
@Module({
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
