import { AuditAction, ErrorCode } from '@kloister/shared';
import {
  fakeAudit,
  fakePrisma,
  fakeSettings,
  makeConfig,
  makeUser,
} from '../../test/support/fakes.js';
import type { ApiException } from '../common/api-exception.js';
import type { AuthContext } from './auth-context.js';
import { AuthService } from './auth.service.js';
import type { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';

/** Password fake: the hash `hash:<pw>` matches password `<pw>`. */
const passwords = {
  hash: (pw: string) => Promise.resolve(`hash:${pw}`),
  verify: (hash: string, pw: string) => Promise.resolve(hash === `hash:${pw}`),
  verifyDummy: () => Promise.resolve(false),
  needsRehash: () => false,
} as unknown as PasswordService;

/**
 * Awaits a promise expected to reject with an ApiException.
 *
 * @param promise The call under test.
 * @returns The exception's status and body.
 */
async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const e = error as ApiException;
    return { status: e.getStatus(), body: e.getResponse() as { code: string; message: string } };
  }
  throw new Error('expected rejection');
}

describe('AuthService', () => {
  function setup(threshold = 3) {
    const { fake, prisma } = fakePrisma();
    const audit = fakeAudit();
    const settings = fakeSettings({ lockoutThreshold: threshold, lockoutMinutes: 15 });
    const sessions = new SessionService(prisma, settings, makeConfig());
    fake.session.create.mockResolvedValue({ id: 'new-session' });
    const service = new AuthService(prisma, passwords, sessions, settings, audit.service);
    return { fake, audit, service };
  }

  describe('login', () => {
    it('fails uniformly for an unknown email and audits it', async () => {
      const { fake, audit, service } = setup();
      fake.user.findUnique.mockResolvedValue(null);
      const err = await rejection(
        service.login(' Nobody@Example.org ', 'pw', { ip: '203.0.113.1' }),
      );
      expect(err.status).toBe(401);
      expect(err.body.code).toBe(ErrorCode.INVALID_CREDENTIALS);
      expect(fake.user.findUnique).toHaveBeenCalledWith({ where: { email: 'nobody@example.org' } });
      expect(audit.records).toEqual([
        expect.objectContaining({
          action: AuditAction.LOGIN_FAILED,
          meta: { email: 'nobody@example.org', reason: 'unknown_email', ip: '203.0.113.1' },
        }),
      ]);
    });

    it('does not keep a non-email value (e.g. a mistyped password) in the audit log', async () => {
      const { fake, audit, service } = setup();
      fake.user.findUnique.mockResolvedValue(null);
      await rejection(service.login('my secret password', 'pw', {}));
      expect(audit.records[0]?.meta).toMatchObject({ email: null, reason: 'unknown_email' });
    });

    it('rejects a deactivated account with the same error, even with the right password', async () => {
      const { fake, service } = setup();
      fake.user.findUnique.mockResolvedValue(
        makeUser({ isActive: false, passwordHash: 'hash:pw' }),
      );
      const err = await rejection(service.login('user@example.org', 'pw', {}));
      expect(err.body.code).toBe(ErrorCode.INVALID_CREDENTIALS);
      expect(fake.session.create).not.toHaveBeenCalled();
    });

    it('rejects a locked account with the same error, even with the right password', async () => {
      const { fake, service } = setup();
      fake.user.findUnique.mockResolvedValue(
        makeUser({ lockedUntil: new Date(Date.now() + 60_000), passwordHash: 'hash:pw' }),
      );
      const err = await rejection(service.login('user@example.org', 'pw', {}));
      expect(err.body.code).toBe(ErrorCode.INVALID_CREDENTIALS);
      expect(fake.session.create).not.toHaveBeenCalled();
    });

    it('counts a wrong password without locking below the threshold', async () => {
      const { fake, audit, service } = setup(3);
      fake.user.findUnique.mockResolvedValue(makeUser({ passwordHash: 'hash:pw' }));
      fake.user.update.mockResolvedValue({ failedLoginCount: 2 });
      await rejection(service.login('user@example.org', 'bad', {}));
      expect(fake.user.update).toHaveBeenCalledTimes(1);
      expect(audit.records.map((r) => r.action)).toEqual([AuditAction.LOGIN_FAILED]);
    });

    it('locks the account when the threshold is reached', async () => {
      const { fake, audit, service } = setup(3);
      fake.user.findUnique.mockResolvedValue(makeUser({ passwordHash: 'hash:pw' }));
      fake.user.update.mockResolvedValueOnce({ failedLoginCount: 3 }).mockResolvedValueOnce({});
      await rejection(service.login('user@example.org', 'bad', {}));
      const lockCall = fake.user.update.mock.calls[1]?.[0] as { data: { lockedUntil: Date } };
      const minutes = (lockCall.data.lockedUntil.getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(14.9);
      expect(minutes).toBeLessThanOrEqual(15);
      expect(audit.records.map((r) => r.action)).toEqual([
        AuditAction.LOGIN_FAILED,
        AuditAction.ACCOUNT_LOCKED,
      ]);
    });

    it('allows login again after the lock expires', async () => {
      const { fake, service } = setup();
      const user = makeUser({ lockedUntil: new Date(Date.now() - 1000), passwordHash: 'hash:pw' });
      fake.user.findUnique.mockResolvedValue(user);
      fake.user.update.mockResolvedValue({ ...user, lockedUntil: null });
      const result = await service.login('user@example.org', 'pw', {});
      expect(result.session.id).toBe('new-session');
    });

    it('resets counters, records the login and creates a session on success', async () => {
      const { fake, audit, service } = setup();
      const user = makeUser({ failedLoginCount: 2, passwordHash: 'hash:pw' });
      fake.user.findUnique.mockResolvedValue(user);
      fake.user.update.mockResolvedValue({ ...user, failedLoginCount: 0 });
      const result = await service.login('user@example.org', 'pw', { ip: '203.0.113.9' });
      expect(fake.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ failedLoginCount: 0, lockedUntil: null }) as unknown,
        }),
      );
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.session.token.length).toBeGreaterThan(30);
      expect(audit.records.map((r) => r.action)).toEqual([AuditAction.LOGIN_SUCCEEDED]);
    });
  });

  describe('changePassword', () => {
    const auth = (): AuthContext => ({
      user: makeUser({ passwordHash: 'hash:old-password-1', mustChangePassword: true }),
      sessionId: 'current',
    });

    it('rejects and audits a wrong current password', async () => {
      const { audit, service } = setup();
      const err = await rejection(service.changePassword(auth(), 'nope', 'new-password-123'));
      expect(err.status).toBe(400);
      expect(err.body.code).toBe(ErrorCode.INVALID_CREDENTIALS);
      expect(audit.records.map((r) => r.action)).toEqual([AuditAction.PASSWORD_CHANGE_FAILED]);
    });

    it('rejects reusing the current password', async () => {
      const { service } = setup();
      const err = await rejection(
        service.changePassword(auth(), 'old-password-1', 'old-password-1'),
      );
      expect(err.body.code).toBe(ErrorCode.VALIDATION_FAILED);
    });

    it('stores the new hash, clears mustChangePassword and ends other sessions', async () => {
      const { fake, audit, service } = setup();
      fake.user.update.mockImplementation((args: unknown) =>
        Promise.resolve(makeUser((args as { data: object }).data)),
      );
      fake.session.deleteMany.mockResolvedValue({ count: 2 });
      const user = await service.changePassword(auth(), 'old-password-1', 'new-password-123');
      expect(user.mustChangePassword).toBe(false);
      expect(fake.user.update).toHaveBeenCalledWith({
        where: { id: auth().user.id },
        data: { passwordHash: 'hash:new-password-123', mustChangePassword: false },
      });
      expect(fake.session.deleteMany).toHaveBeenCalledWith({
        where: { userId: auth().user.id, id: { not: 'current' } },
      });
      expect(audit.records).toEqual([
        expect.objectContaining({
          action: AuditAction.PASSWORD_CHANGED,
          meta: { otherSessionsEnded: 2 },
        }),
      ]);
    });
  });
});
