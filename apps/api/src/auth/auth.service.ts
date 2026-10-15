import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditAction, ErrorCode, type UserDto } from '@kloister/shared';
import { AuditService } from '../audit/audit.service.js';
import { ApiException } from '../common/api-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { normalizeEmail, toUserDto } from '../users/user.mapper.js';
import type { AuthContext } from './auth-context.js';
import { PasswordService } from './password.service.js';
import { type NewSession, type SessionClientInfo, SessionService } from './session.service.js';

/**
 * One message for every login failure, so responses never reveal whether an
 * email exists, the account is deactivated, or it is locked.
 */
const LOGIN_FAILED_MESSAGE = 'Invalid email or password, or the account is temporarily locked';

/**
 * Loose email shape check used only to decide what to keep in audit entries.
 *
 * @param value Normalised submitted email.
 * @returns True for `local@domain` without spaces, at most 254 characters.
 */
function looksLikeEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(value);
}

/** Result of a successful login. */
export interface LoginResult {
  /** The signed-in user. */
  user: UserDto;
  /** The new session (its token goes into the cookie). */
  session: NewSession;
}

/**
 * Login, logout and self-service password change (SPEC §5).
 */
@Injectable()
export class AuthService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param passwords Hashing.
   * @param sessions Session storage.
   * @param settings Lockout settings.
   * @param audit Audit log.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Verifies credentials and starts a session.
   *
   * Lockout: each wrong password increments `failedLoginCount`; reaching the
   * threshold locks the account for the configured period and resets the
   * counter. A successful login clears both. Unknown, deactivated and locked
   * accounts fail with the same error and similar timing.
   *
   * Permissions: public; per-IP rate limiting is applied by the controller.
   *
   * @param rawEmail Submitted email.
   * @param password Submitted password.
   * @param client Request details for the session and audit log.
   * @returns The user and new session.
   */
  async login(rawEmail: string, password: string, client: SessionClientInfo): Promise<LoginResult> {
    const email = normalizeEmail(rawEmail);
    const user = await this.prisma.user.findUnique({ where: { email } });
    const now = new Date();

    if (user === null || !user.isActive || (user.lockedUntil !== null && user.lockedUntil > now)) {
      await this.passwords.verifyDummy(password);
      const reason = user === null ? 'unknown_email' : !user.isActive ? 'inactive' : 'locked';
      await this.audit.record({
        actorId: null,
        action: AuditAction.LOGIN_FAILED,
        entityType: 'User',
        entityId: user?.id ?? null,
        // For unknown accounts, keep the submitted value only if it looks
        // like an email: a password typed into the email field must not end
        // up in the audit log.
        meta: {
          email: user !== null || looksLikeEmail(email) ? email : null,
          reason,
          ip: client.ip ?? null,
        },
      });
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.INVALID_CREDENTIALS,
        LOGIN_FAILED_MESSAGE,
      );
    }

    if (!(await this.passwords.verify(user.passwordHash, password))) {
      await this.registerFailure(user.id, email, client);
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.INVALID_CREDENTIALS,
        LOGIN_FAILED_MESSAGE,
      );
    }

    // Upgrade the hash if the library's recommended parameters have moved on.
    const passwordHash = this.passwords.needsRehash(user.passwordHash)
      ? await this.passwords.hash(password)
      : undefined;

    const [updated, session] = await this.prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: now,
          ...(passwordHash ? { passwordHash } : {}),
        },
      });
      const newSession = await this.sessions.create(user.id, client, tx);
      await this.audit.record(
        {
          actorId: user.id,
          action: AuditAction.LOGIN_SUCCEEDED,
          entityType: 'User',
          entityId: user.id,
          meta: { ip: client.ip ?? null },
        },
        tx,
      );
      return [updatedUser, newSession] as const;
    });

    return { user: toUserDto(updated), session };
  }

  /**
   * Counts a wrong password and locks the account at the threshold.
   *
   * @param userId The account.
   * @param email Normalised email, for the audit entry.
   * @param client Request details for the audit entry.
   * @returns Resolves once recorded.
   */
  private async registerFailure(
    userId: string,
    email: string,
    client: SessionClientInfo,
  ): Promise<void> {
    const { lockoutThreshold, lockoutMinutes } = await this.settings.getSecurity();
    // Atomic increment so concurrent attempts cannot under-count.
    const { failedLoginCount } = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    await this.audit.record({
      actorId: null,
      action: AuditAction.LOGIN_FAILED,
      entityType: 'User',
      entityId: userId,
      meta: { email, reason: 'bad_password', ip: client.ip ?? null },
    });
    if (failedLoginCount >= lockoutThreshold) {
      const lockedUntil = new Date(Date.now() + lockoutMinutes * 60_000);
      await this.prisma.user.update({
        where: { id: userId },
        data: { lockedUntil, failedLoginCount: 0 },
      });
      await this.audit.record({
        actorId: null,
        action: AuditAction.ACCOUNT_LOCKED,
        entityType: 'User',
        entityId: userId,
        meta: { lockedUntil: lockedUntil.toISOString(), ip: client.ip ?? null },
      });
    }
  }

  /**
   * Ends the caller's current session.
   *
   * @param auth The signed-in caller.
   * @returns Resolves once the session is deleted.
   */
  async logout(auth: AuthContext): Promise<void> {
    await this.sessions.revoke(auth.sessionId);
    await this.audit.record({
      actorId: auth.user.id,
      action: AuditAction.LOGOUT,
      entityType: 'User',
      entityId: auth.user.id,
    });
  }

  /**
   * Replaces the caller's password after re-checking the current one, clears
   * `mustChangePassword`, and ends the user's other sessions (SPEC §5).
   *
   * Permissions: the signed-in user, for their own account only. Allowed
   * while a password change is pending.
   *
   * @param auth The signed-in caller.
   * @param currentPassword Must match the stored hash.
   * @param newPassword Replacement (length validated by the DTO).
   * @returns The updated user.
   */
  async changePassword(
    auth: AuthContext,
    currentPassword: string,
    newPassword: string,
  ): Promise<UserDto> {
    if (!(await this.passwords.verify(auth.user.passwordHash, currentPassword))) {
      // Audited so repeated guessing from a hijacked session leaves a trace;
      // the route is also rate limited per IP.
      await this.audit.record({
        actorId: auth.user.id,
        action: AuditAction.PASSWORD_CHANGE_FAILED,
        entityType: 'User',
        entityId: auth.user.id,
      });
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_CREDENTIALS,
        'Current password is incorrect',
      );
    }
    if (currentPassword === newPassword) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_FAILED,
        'The new password must differ from the current one',
      );
    }
    const passwordHash = await this.passwords.hash(newPassword);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.user.updateMany({
        where: {
          id: auth.user.id,
          mustChangePassword: true,
          introductionState: 'AWAITING_INITIAL_PASSWORD',
        },
        data: { introductionState: 'READY' },
      });
      const user = await tx.user.update({
        where: { id: auth.user.id },
        data: { passwordHash, mustChangePassword: false },
      });
      const revoked = await this.sessions.revokeAllForUser(auth.user.id, auth.sessionId, tx);
      await this.audit.record(
        {
          actorId: auth.user.id,
          action: AuditAction.PASSWORD_CHANGED,
          entityType: 'User',
          entityId: auth.user.id,
          meta: { otherSessionsEnded: revoked },
        },
        tx,
      );
      return user;
    });
    return toUserDto(updated);
  }
}
