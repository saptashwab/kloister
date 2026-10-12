import { AuditAction, ErrorCode } from '@kloister/shared';
import {
  fakeAudit,
  fakePrisma,
  fakeSettings,
  makeConfig,
  makeUser,
} from '../../test/support/fakes.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { PasswordService } from '../auth/password.service.js';
import { SessionService } from '../auth/session.service.js';
import type { ApiException } from '../common/api-exception.js';
import { UsersService } from './users.service.js';

const passwords = {
  hash: (pw: string) => Promise.resolve(`hash:${pw}`),
  generateTemporary: () => 'temporary-password-xyz',
} as unknown as PasswordService;

const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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

describe('UsersService', () => {
  const actor: AuthContext = {
    user: makeUser({ id: ADMIN_ID, systemRole: 'ADMIN' }),
    sessionId: 'admin-session',
  };

  function setup() {
    const { fake, prisma } = fakePrisma();
    const audit = fakeAudit();
    const sessions = new SessionService(prisma, fakeSettings(), makeConfig());
    const service = new UsersService(prisma, passwords, sessions, audit.service);
    fake.user.update.mockImplementation((args: unknown) =>
      Promise.resolve(makeUser({ id: TARGET_ID, ...(args as { data: object }).data })),
    );
    return { fake, audit, service };
  }

  describe('create', () => {
    it('normalises the email, forces a password change and returns the temporary password once', async () => {
      const { fake, audit, service } = setup();
      fake.user.create.mockImplementation((args: unknown) =>
        Promise.resolve(makeUser({ id: TARGET_ID, ...(args as { data: object }).data })),
      );
      const result = await service.create(actor, {
        email: ' New@Example.org ',
        displayName: 'New',
      });
      expect(result.temporaryPassword).toBe('temporary-password-xyz');
      expect(fake.user.create).toHaveBeenCalledWith({
        data: {
          email: 'new@example.org',
          displayName: 'New',
          systemRole: 'USER',
          passwordHash: 'hash:temporary-password-xyz',
          mustChangePassword: true,
        },
      });
      expect(JSON.stringify(audit.records)).not.toContain('temporary-password-xyz');
      expect(audit.records[0]?.action).toBe(AuditAction.USER_CREATED);
    });

    it('maps a duplicate email to 409 CONFLICT', async () => {
      const { fake, service } = setup();
      fake.user.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
      const err = await rejection(
        service.create(actor, { email: 'dup@example.org', displayName: 'Dup' }),
      );
      expect(err).toEqual({ status: 409, code: ErrorCode.CONFLICT });
    });
  });

  describe('update', () => {
    it('returns 404 for an unknown user', async () => {
      const { fake, service } = setup();
      fake.user.findUnique.mockResolvedValue(null);
      const err = await rejection(service.update(actor, TARGET_ID, { displayName: 'X' }));
      expect(err).toEqual({ status: 404, code: ErrorCode.NOT_FOUND });
    });

    it.each([[{ systemRole: 'USER' as const }], [{ isActive: false }]])(
      'refuses to remove the last active admin (%j)',
      async (change) => {
        const { fake, service } = setup();
        fake.user.findUnique.mockResolvedValue(
          makeUser({ id: TARGET_ID, systemRole: 'ADMIN', isActive: true }),
        );
        fake.user.count.mockResolvedValue(0);
        const err = await rejection(service.update(actor, TARGET_ID, change));
        expect(err).toEqual({ status: 409, code: ErrorCode.LAST_ADMIN });
        expect(fake.user.update).not.toHaveBeenCalled();
      },
    );

    it('runs in a serializable transaction', async () => {
      const { fake, service } = setup();
      fake.user.findUnique.mockResolvedValue(makeUser({ id: TARGET_ID }));
      await service.update(actor, TARGET_ID, { displayName: 'Renamed' });
      expect(fake.$transaction.mock.calls[0]?.[1]).toEqual({ isolationLevel: 'Serializable' });
    });

    it('turns a serialization conflict into 409 CONFLICT', async () => {
      const { fake, service } = setup();
      fake.$transaction.mockRejectedValue(Object.assign(new Error('conflict'), { code: 'P2034' }));
      const err = await rejection(service.update(actor, TARGET_ID, { displayName: 'X' }));
      expect(err).toEqual({ status: 409, code: ErrorCode.CONFLICT });
    });

    it('demotes an admin when another active admin remains', async () => {
      const { fake, audit, service } = setup();
      fake.user.findUnique.mockResolvedValue(makeUser({ id: TARGET_ID, systemRole: 'ADMIN' }));
      fake.user.count.mockResolvedValue(1);
      const user = await service.update(actor, TARGET_ID, { systemRole: 'USER' });
      expect(user.systemRole).toBe('USER');
      expect(audit.records[0]?.meta).toEqual({
        changes: { systemRole: { from: 'ADMIN', to: 'USER' } },
      });
    });

    it('ends all sessions when deactivating', async () => {
      const { fake, audit, service } = setup();
      fake.user.findUnique.mockResolvedValue(makeUser({ id: TARGET_ID }));
      fake.session.deleteMany.mockResolvedValue({ count: 3 });
      await service.update(actor, TARGET_ID, { isActive: false });
      expect(fake.session.deleteMany).toHaveBeenCalledWith({ where: { userId: TARGET_ID } });
      expect(audit.records[0]?.meta).toMatchObject({ sessionsEnded: 3 });
    });

    it('writes nothing when no field changes', async () => {
      const { fake, audit, service } = setup();
      fake.user.findUnique.mockResolvedValue(makeUser({ id: TARGET_ID, displayName: 'Same' }));
      await service.update(actor, TARGET_ID, { displayName: 'Same' });
      expect(fake.user.update).not.toHaveBeenCalled();
      expect(audit.records).toEqual([]);
    });
  });

  describe('resetPassword', () => {
    it('refuses an admin resetting their own password', async () => {
      const { service } = setup();
      const err = await rejection(service.resetPassword(actor, ADMIN_ID));
      expect(err).toEqual({ status: 400, code: ErrorCode.VALIDATION_FAILED });
    });

    it('sets a temporary password, clears lockout and ends every session', async () => {
      const { fake, audit, service } = setup();
      fake.user.findUnique.mockResolvedValue(makeUser({ id: TARGET_ID }));
      fake.session.deleteMany.mockResolvedValue({ count: 1 });
      const result = await service.resetPassword(actor, TARGET_ID);
      expect(result.temporaryPassword).toBe('temporary-password-xyz');
      expect(fake.user.update).toHaveBeenCalledWith({
        where: { id: TARGET_ID },
        data: {
          passwordHash: 'hash:temporary-password-xyz',
          mustChangePassword: true,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      expect(fake.session.deleteMany).toHaveBeenCalledWith({ where: { userId: TARGET_ID } });
      expect(audit.records[0]?.action).toBe(AuditAction.PASSWORD_RESET);
    });
  });

  describe('bootstrapAdmin', () => {
    it('does nothing when an active admin exists', async () => {
      const { fake, service } = setup();
      fake.user.count.mockResolvedValue(1);
      await expect(service.bootstrapAdmin('a@example.org', 'A')).resolves.toEqual({
        created: false,
        reason: 'admin_exists',
      });
      expect(fake.user.create).not.toHaveBeenCalled();
    });

    it('creates an admin who must change the password', async () => {
      const { fake, audit, service } = setup();
      fake.user.count.mockResolvedValue(0);
      fake.user.create.mockImplementation((args: unknown) =>
        Promise.resolve(makeUser((args as { data: object }).data)),
      );
      const result = await service.bootstrapAdmin('Admin@Example.org', 'Admin');
      expect(result).toMatchObject({
        created: true,
        temporaryPassword: 'temporary-password-xyz',
        user: { email: 'admin@example.org', systemRole: 'ADMIN', mustChangePassword: true },
      });
      expect(audit.records[0]).toMatchObject({
        action: AuditAction.ADMIN_BOOTSTRAPPED,
        actorId: null,
      });
    });
  });
});
