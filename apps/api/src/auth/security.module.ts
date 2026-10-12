import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';

/**
 * Password hashing and session storage, shared by the auth endpoints, the
 * admin user endpoints and the admin bootstrap command.
 */
@Module({
  imports: [SettingsModule],
  providers: [PasswordService, SessionService],
  exports: [PasswordService, SessionService, SettingsModule],
})
export class SecurityModule {}
