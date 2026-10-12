import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { CSRF_HEADER, CSRF_HEADER_VALUE, ErrorCode } from '@kloister/shared';
import type { FastifyRequest } from 'fastify';
import { ApiException } from '../common/api-exception.js';

/** Methods that never change state and so need no CSRF header. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard requiring `X-Requested-With: kloister` on every state-changing
 * request, public ones (login) included (SPEC §5).
 *
 * Browsers will not attach a custom header to a cross-site form post or
 * simple request, so combined with `SameSite=Strict` this blocks CSRF.
 *
 * Permissions: runs before the session guard; failing requests get 403
 * `CSRF_HEADER_MISSING` regardless of authentication.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  /**
   * Allows safe methods; requires the CSRF header on everything else.
   *
   * @param context The current request.
   * @returns True when the request is safe or carries the header.
   */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (SAFE_METHODS.has(request.method)) return true;
    if (request.headers[CSRF_HEADER] === CSRF_HEADER_VALUE) return true;
    throw new ApiException(
      HttpStatus.FORBIDDEN,
      ErrorCode.CSRF_HEADER_MISSING,
      `Missing or invalid ${CSRF_HEADER} header`,
    );
  }
}
