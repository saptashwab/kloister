import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ProjectPermission } from '@kloister/shared';
import type { FastifyRequest } from 'fastify';
import { type ProjectAccess, ProjectAccessService } from './project-access.service.js';

/** Metadata key set by {@link RequireProjectPermission}. */
export const PROJECT_PERMISSION_KEY = 'kloister:projectPermission';

/** Methods that never change data, so they are allowed on archived projects. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** What {@link RequireProjectPermission} stores on a route. */
export interface ProjectPermissionRequirement {
  /** The permission the route needs. */
  permission: ProjectPermission;
  /** Allow the route on archived projects even though it writes. */
  allowArchived: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by {@link ProjectAccessGuard} on project-scoped routes. */
    projectAccess?: ProjectAccess;
  }
}

/**
 * Declares the project permission a route under `/projects/:id/…` needs.
 * Routes guarded by {@link ProjectAccessGuard} without this decorator are
 * refused, so a forgotten decorator fails closed.
 *
 * @param permission The permission required (SPEC §3.2).
 * @param options Set `allowArchived` for the few writes allowed on archived
 *   projects (unarchive).
 * @param options.allowArchived Skip the archived-project check.
 * @returns The metadata decorator.
 */
export const RequireProjectPermission = (
  permission: ProjectPermission,
  options: { allowArchived?: boolean } = {},
): MethodDecorator =>
  SetMetadata(PROJECT_PERMISSION_KEY, {
    permission,
    allowArchived: options.allowArchived ?? false,
  } satisfies ProjectPermissionRequirement);

/**
 * Injects the {@link ProjectAccess} resolved by {@link ProjectAccessGuard}.
 */
export const CurrentProject = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ProjectAccess => {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (request.projectAccess === undefined) {
      // Reaching this means a route used @CurrentProject without the guard.
      throw new Error('CurrentProject used on a route without ProjectAccessGuard');
    }
    return request.projectAccess;
  },
);

/**
 * Project-level authorization guard (SPEC §3.4) for routes with an `:id`
 * project parameter (uuid or key). Runs after the global session guard.
 *
 * Permissions, in order:
 * 1. The caller must be a member, or a system admin (read-only, audited as
 *    `ADMIN_CROSS_PROJECT_ACCESS`); otherwise 404 `NOT_FOUND`.
 * 2. Their role must grant the route's {@link RequireProjectPermission}
 *    (403 `FORBIDDEN`); a route without one is refused.
 * 3. Writes (any method but GET/HEAD/OPTIONS) to archived projects get 409
 *    `PROJECT_ARCHIVED`, unless the route sets `allowArchived`.
 *
 * Because guards run before body validation, a non-member never learns
 * anything about a project from validation errors.
 */
@Injectable()
export class ProjectAccessGuard implements CanActivate {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param reflector Reads route metadata.
   * @param access Resolves and checks project access.
   */
  constructor(
    private readonly reflector: Reflector,
    private readonly access: ProjectAccessService,
  ) {}

  /**
   * Resolves the caller's project access and checks the route's permission.
   *
   * @param context The current request.
   * @returns True when the caller may proceed; throws otherwise.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.get<ProjectPermissionRequirement | undefined>(
      PROJECT_PERMISSION_KEY,
      context.getHandler(),
    );
    if (requirement === undefined) {
      throw new Error(`Route ${context.getHandler().name} has no @RequireProjectPermission`);
    }
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (request.auth === undefined) {
      // The global session guard always runs first on non-public routes.
      throw new Error('ProjectAccessGuard ran without an authenticated session');
    }
    const ref = (request.params as Record<string, string | undefined>)['id'] ?? '';
    const via = `${request.method} ${request.routeOptions.url ?? request.url}`;
    const access = await this.access.resolve(request.auth, ref, via);
    // Reads stay open on archived projects whatever permission they need
    // (e.g. member candidates); every write is refused unless the route opts out.
    const isWrite = !READ_METHODS.has(request.method);
    this.access.assert(access, requirement.permission, isWrite && !requirement.allowArchived);
    request.projectAccess = access;
    return true;
  }
}
