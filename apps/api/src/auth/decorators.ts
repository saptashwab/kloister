import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthContext } from './auth-context.js';

/** Metadata key set by {@link Public}. */
export const IS_PUBLIC_KEY = 'kloister:isPublic';
/** Metadata key set by {@link AdminOnly}. */
export const ADMIN_ONLY_KEY = 'kloister:adminOnly';
/** Metadata key set by {@link AllowPendingPasswordChange}. */
export const ALLOW_PENDING_PASSWORD_CHANGE_KEY = 'kloister:allowPendingPasswordChange';

/**
 * Marks a route or controller as reachable without a session.
 *
 * Every route requires a session by default (the session guard is global),
 * so public access must be opted into explicitly and is easy to audit.
 *
 * @returns The metadata decorator.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Restricts a route or controller to users with the `ADMIN` system role.
 * Other signed-in users get 403.
 *
 * @returns The metadata decorator.
 */
export const AdminOnly = (): MethodDecorator & ClassDecorator => SetMetadata(ADMIN_ONLY_KEY, true);

/**
 * Lets a signed-in user reach this route while `mustChangePassword` is set.
 * All other routes answer 403 `PASSWORD_CHANGE_REQUIRED` until the user has
 * replaced their temporary password (SPEC §5).
 *
 * @returns The metadata decorator.
 */
export const AllowPendingPasswordChange = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_PENDING_PASSWORD_CHANGE_KEY, true);

/**
 * Injects the {@link AuthContext} of the signed-in caller. Only valid on
 * routes behind the session guard (i.e. not {@link Public}).
 */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (request.auth === undefined) {
      // Reaching this means a route used @CurrentAuth without the session
      // guard having run, which is a programming error.
      throw new Error('CurrentAuth used on a route without an authenticated session');
    }
    return request.auth;
  },
);
