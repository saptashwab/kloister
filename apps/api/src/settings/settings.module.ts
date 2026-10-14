import { Module } from '@nestjs/common';
import { SettingsService } from './settings.service.js';

/**
 * Reads and writes the admin-editable settings. Every feature that needs a
 * setting imports this; the admin endpoints live in `AdminSettingsModule`,
 * `BrandingModule` and `BackupsModule`.
 */
@Module({
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
