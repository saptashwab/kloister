import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from '../audit/audit.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { CsrfGuard } from './csrf.guard.js';
import { LoginRateLimitGuard } from './login-rate-limit.guard.js';
import { SecurityModule } from './security.module.js';
import { SessionGuard } from './session.guard.js';

/**
 * Login/logout/password endpoints plus the global guards.
 *
 * Guard order matters and follows registration order: the CSRF check runs
 * first, then authentication and system-role checks. The login rate limit is
 * a route guard on `POST /auth/login` only.
 */
@Module({
  imports: [SecurityModule, AuditModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    LoginRateLimitGuard,
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class AuthModule {}
