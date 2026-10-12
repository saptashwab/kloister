import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode, SystemRole } from '@kloister/shared';
import type { FastifyRequest } from 'fastify';
import { ApiException } from '../common/api-exception.js';
import { ADMIN_ONLY_KEY, ALLOW_PENDING_PASSWORD_CHANGE_KEY, IS_PUBLIC_KEY } from './decorators.js';
import { SESSION_COOKIE, SessionService } from './session.service.js';

/**
 * Global authentication and system-role guard (SPEC §3.4).
 *
 * Permissions, in order:
 * 1. Routes marked `@Public()` pass without a session.
 * 2. Otherwise a live session cookie is required (401 `UNAUTHENTICATED`).
 * 3. Users with `mustChangePassword` may only reach routes marked
 *    `@AllowPendingPasswordChange()` (403 `PASSWORD_CHANGE_REQUIRED`).
 * 4. Routes marked `@AdminOnly()` require the `ADMIN` system role (403 `FORBIDDEN`).
 *
 * Project-level permissions are checked later by `ProjectAccessService` (M2).
 */
@Injectable()
export class SessionGuard implements CanActivate {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param reflector Reads route metadata.
   * @param sessions Validates session tokens.
   */
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Applies the checks listed on the class, attaching the auth context to the request.
   *
   * @param context The current request.
   * @returns True when the caller may proceed; throws otherwise.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = request.cookies[SESSION_COOKIE];
    const auth = token === undefined || token === '' ? null : await this.sessions.validate(token);
    if (auth === null) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHENTICATED, 'Not signed in');
    }
    request.auth = auth;

    if (
      auth.user.mustChangePassword &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD_CHANGE_KEY, targets)
    ) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.PASSWORD_CHANGE_REQUIRED,
        'You must change your password before continuing',
      );
    }

    if (
      this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY_KEY, targets) &&
      auth.user.systemRole !== SystemRole.ADMIN
    ) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Administrator access required',
      );
    }
    return true;
  }
}
