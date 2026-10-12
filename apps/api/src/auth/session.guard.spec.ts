import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@kloister/shared';
import type { FastifyRequest } from 'fastify';
import { makeUser } from '../../test/support/fakes.js';
import type { ApiException } from '../common/api-exception.js';
import type { AuthContext } from './auth-context.js';
import { AdminOnly, AllowPendingPasswordChange, Public } from './decorators.js';
import { SessionGuard } from './session.guard.js';
import type { SessionService } from './session.service.js';

// Route stand-ins carrying the same metadata real controllers use.
class Routes {
  @Public() open(): void {}
  plain(): void {}
  @AllowPendingPasswordChange() pendingOk(): void {}
  @AdminOnly() adminOnly(): void {}
}
const handler = (name: keyof Routes) =>
  Object.getOwnPropertyDescriptor(Routes.prototype, name)?.value as object;

function context(name: keyof Routes, request: Partial<FastifyRequest>): ExecutionContext {
  return {
    getHandler: () => handler(name),
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guardFor(auth: AuthContext | null) {
  const sessions = { validate: () => Promise.resolve(auth) } as unknown as SessionService;
  return new SessionGuard(new Reflector(), sessions);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return ((error as ApiException).getResponse() as { code: string }).code;
  }
  return 'none';
}

describe('SessionGuard', () => {
  const withCookie = () => ({ cookies: { sid: 'token' } }) as Partial<FastifyRequest>;

  it('lets public routes through without a cookie', async () => {
    await expect(guardFor(null).canActivate(context('open', { cookies: {} }))).resolves.toBe(true);
  });

  it('rejects a missing cookie with UNAUTHENTICATED', async () => {
    expect(await codeOf(guardFor(null).canActivate(context('plain', { cookies: {} })))).toBe(
      ErrorCode.UNAUTHENTICATED,
    );
  });

  it('rejects an invalid session with UNAUTHENTICATED', async () => {
    expect(await codeOf(guardFor(null).canActivate(context('plain', withCookie())))).toBe(
      ErrorCode.UNAUTHENTICATED,
    );
  });

  it('attaches the auth context for a valid session', async () => {
    const auth = { user: makeUser(), sessionId: 's1' };
    const request = withCookie();
    await expect(guardFor(auth).canActivate(context('plain', request))).resolves.toBe(true);
    expect(request.auth).toBe(auth);
  });

  it('blocks users with a pending password change except on allowed routes', async () => {
    const auth = { user: makeUser({ mustChangePassword: true }), sessionId: 's1' };
    expect(await codeOf(guardFor(auth).canActivate(context('plain', withCookie())))).toBe(
      ErrorCode.PASSWORD_CHANGE_REQUIRED,
    );
    await expect(guardFor(auth).canActivate(context('pendingOk', withCookie()))).resolves.toBe(
      true,
    );
  });

  it('enforces @AdminOnly', async () => {
    const user = { user: makeUser({ systemRole: 'USER' }), sessionId: 's1' };
    const admin = { user: makeUser({ systemRole: 'ADMIN' }), sessionId: 's2' };
    expect(await codeOf(guardFor(user).canActivate(context('adminOnly', withCookie())))).toBe(
      ErrorCode.FORBIDDEN,
    );
    await expect(guardFor(admin).canActivate(context('adminOnly', withCookie()))).resolves.toBe(
      true,
    );
  });

  it('checks the password-change requirement before admin rights', async () => {
    const admin = {
      user: makeUser({ systemRole: 'ADMIN', mustChangePassword: true }),
      sessionId: 's',
    };
    expect(await codeOf(guardFor(admin).canActivate(context('adminOnly', withCookie())))).toBe(
      ErrorCode.PASSWORD_CHANGE_REQUIRED,
    );
  });
});
