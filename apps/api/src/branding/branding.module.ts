import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { AdminBrandingController, PublicBrandingController } from './branding.controller.js';
import { BrandingService } from './branding.service.js';

/**
 * Branding (SPEC §6): the public name, logo, font and default theme, and the
 * admin screens that change them. Files live in `BRANDING_DIR`.
 */
@Module({
  imports: [AuditModule, SettingsModule],
  controllers: [PublicBrandingController, AdminBrandingController],
  providers: [BrandingService],
})
export class BrandingModule {}
