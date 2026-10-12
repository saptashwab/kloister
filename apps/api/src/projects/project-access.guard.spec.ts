import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditAction, ErrorCode, ProjectPermission } from '@kloister/shared';
import type { FastifyRequest } from 'fastify';
import { fakeAudit, fakePrisma, makeProject, makeUser } from '../../test/support/fakes.js';
import type { ApiException } from '../common/api-exception.js';
import {
  PROJECT_PERMISSION_KEY,
  ProjectAccessGuard,
  type ProjectPermissionRequirement,
} from './project-access.guard.js';
import { ProjectAccessService } from './project-access.service.js';

const ME = '11111111-1111-4111-8111-111111111111';

/**
 * Builds a guard, a request and an execution context for one route.
 *
 * @param requirement The route's permission metadata, or undefined for none.
 * @param members The caller's memberships.
 * @param systemRole The caller's system role.
 * @param archived Whether the project is archived.
 * @param method HTTP method of the request.
 * @returns Guard, request, context and captured audit records.
 */
function setup(
  requirement: ProjectPermissionRequirement | undefined,
  members: object[],
  systemRole: 'ADMIN' | 'USER' = 'USER',
  archived = false,
  method = 'PATCH',
) {
  const { fake, prisma } = fakePrisma();
  const audit = fakeAudit();
  fake.project.findUnique.mockResolvedValue({
    ...makeProject({ archivedAt: archived ? new Date() : null }),
    members,
  });
  const handler = (): void => undefined;
  if (requirement !== undefined)
    Reflect.defineMetadata(PROJECT_PERMISSION_KEY, requirement, handler);
  const request = {
    method,
    url: '/api/v1/projects/KLO',
    routeOptions: { url: '/api/v1/projects/:id' },
    params: { id: 'KLO' },
    auth: { user: makeUser({ id: ME, systemRole }), sessionId: 's' },
  } as unknown as FastifyRequest;
  const context = {
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const guard = new ProjectAccessGuard(
    new Reflector(),
    new ProjectAccessService(prisma, audit.service),
  );
  return { guard, request, context, audit };
}

/**
 * Awaits a promise expected to reject with an ApiException.
 *
 * @param promise The call under test.
 * @returns The exception's status and code.
 */
async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const e = error as ApiException;
    return { status: e.getStatus(), code: (e.getResponse() as { code: string }).code };
  }
  throw new Error('expected rejection');
}

const pm = { role: 'PM', visibility: 'ALL', allowedBucketIds: [] };
const manage = { permission: ProjectPermission.MANAGE_PROJECT, allowArchived: false };

describe('ProjectAccessGuard', () => {
  it('attaches the access when the role grants the permission', async () => {
    const { guard, request, context } = setup(manage, [pm]);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.projectAccess?.role).toBe('PM');
  });

  it('fails closed on routes without a permission decorator', async () => {
    const { guard, context } = setup(undefined, [pm]);
    await expect(guard.canActivate(context)).rejects.toThrow(/RequireProjectPermission/);
  });

  it('answers 404 to non-members and 403 to members lacking the permission', async () => {
    expect(await rejection(setup(manage, []).guard.canActivate(setup(manage, []).context))).toEqual(
      { status: 404, code: ErrorCode.NOT_FOUND },
    );
    const lead = setup(manage, [{ ...pm, role: 'LEAD' }]);
    expect(await rejection(lead.guard.canActivate(lead.context))).toEqual({
      status: 403,
      code: ErrorCode.FORBIDDEN,
    });
  });

  it('audits non-member admins with the route, even when the action is then refused', async () => {
    const { guard, context, audit } = setup(manage, [], 'ADMIN');
    expect((await rejection(guard.canActivate(context))).status).toBe(403);
    expect(audit.records).toEqual([
      expect.objectContaining({
        action: AuditAction.ADMIN_CROSS_PROJECT_ACCESS,
        meta: { via: 'PATCH /api/v1/projects/:id' },
      }),
    ]);
  });

  it('refuses writes to archived projects unless the route allows it', async () => {
    const archived = setup(manage, [pm], 'USER', true);
    expect(await rejection(archived.guard.canActivate(archived.context))).toEqual({
      status: 409,
      code: ErrorCode.PROJECT_ARCHIVED,
    });
    // Reads are allowed whatever permission they need (e.g. member candidates).
    const read = setup(manage, [pm], 'USER', true, 'GET');
    await expect(read.guard.canActivate(read.context)).resolves.toBe(true);
    const unarchive = setup({ ...manage, allowArchived: true }, [pm], 'USER', true);
    await expect(unarchive.guard.canActivate(unarchive.context)).resolves.toBe(true);
  });
});
