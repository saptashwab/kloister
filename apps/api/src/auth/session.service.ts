import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { DbClient } from '../audit/audit.service.js';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type { AuthContext } from './auth-context.js';

/** Name of the session cookie. Neutral on purpose: no product name in it. */
export const SESSION_COOKIE = 'sid';

/**
 * How stale `lastSeenAt` may get before a request refreshes it. Writing on
 * every request would turn each read into a write; a minute of slack is
 * negligible against an idle timeout measured in hours.
 */
const TOUCH_INTERVAL_MS = 60_000;

/** Request details stored with a session for the user's and admins' benefit. */
export interface SessionClientInfo {
  /** `User-Agent` header, truncated. */
  userAgent?: string;
  /** Client IP as resolved through the trusted proxy. */
  ip?: string;
}

/** A freshly created session. */
export interface NewSession {
  /** Session id. */
  id: string;
  /** Raw token for the cookie; never stored server-side. */
  token: string;
  /** Absolute expiry. */
  expiresAt: Date;
}

/**
 * Hashes a session token for storage and lookup.
 *
 * SHA-256 (not argon2) is right here: the token already has 256 bits of
 * entropy, so slow hashing adds nothing and would slow every request.
 *
 * @param token Raw token from the cookie.
 * @returns Hex digest.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Server-side sessions stored in Postgres (SPEC §5): creation, validation
 * with idle and absolute timeouts, and revocation.
 */
@Injectable()
export class SessionService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param settings Supplies the timeouts.
   * @param config Supplies the cookie path.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Starts a session for a user who has just proven their identity.
   *
   * @param userId The user.
   * @param client Request details to record.
   * @param db Optional transaction client.
   * @returns The new session including its raw token.
   */
  async create(
    userId: string,
    client: SessionClientInfo,
    db: DbClient = this.prisma,
  ): Promise<NewSession> {
    const { absoluteTimeoutMinutes } = await this.settings.getSecurity();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + absoluteTimeoutMinutes * 60_000);
    const session = await db.session.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        expiresAt,
        userAgent: client.userAgent?.slice(0, 512) ?? null,
        ip: client.ip ?? null,
      },
    });
    return { id: session.id, token, expiresAt };
  }

  /**
   * Resolves a cookie token to the signed-in user.
   *
   * Expired or idle sessions are deleted on sight. Sessions of deactivated
   * users are rejected (they are also deleted at deactivation time; this is
   * a second line of defence).
   *
   * @param token Raw token from the cookie.
   * @returns The auth context, or null if the token is not a live session.
   */
  async validate(token: string): Promise<AuthContext | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (session === null) return null;

    const { idleTimeoutMinutes } = await this.settings.getSecurity();
    const now = Date.now();
    const idleDeadline = session.lastSeenAt.getTime() + idleTimeoutMinutes * 60_000;
    if (session.expiresAt.getTime() <= now || idleDeadline <= now || !session.user.isActive) {
      await this.prisma.session.deleteMany({ where: { id: session.id } });
      return null;
    }

    if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { lastSeenAt: new Date(now) },
      });
    }
    return { user: session.user, sessionId: session.id };
  }

  /**
   * Ends one session (logout).
   *
   * @param sessionId The session to delete.
   * @returns Resolves once deleted; a missing session is not an error.
   */
  async revoke(sessionId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id: sessionId } });
  }

  /**
   * Ends all of a user's sessions, optionally keeping the current one.
   * Used on password change/reset and deactivation (SPEC §5).
   *
   * @param userId The user.
   * @param exceptSessionId Session to keep, e.g. the one changing its password.
   * @param db Optional transaction client.
   * @returns Number of sessions deleted.
   */
  async revokeAllForUser(
    userId: string,
    exceptSessionId?: string,
    db: DbClient = this.prisma,
  ): Promise<number> {
    const result = await db.session.deleteMany({
      where: { userId, ...(exceptSessionId === undefined ? {} : { id: { not: exceptSessionId } }) },
    });
    return result.count;
  }

  /**
   * Cookie attributes required by SPEC §5: `httpOnly`, `Secure`,
   * `SameSite=Strict`, `Path=/<app_name>/`.
   *
   * @param expiresAt When the browser should drop the cookie; omit when clearing.
   * @returns Options for `reply.setCookie` / `reply.clearCookie`.
   */
  cookieOptions(expiresAt?: Date): CookieSerializeOptions {
    return {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: this.config.cookiePath,
      ...(expiresAt === undefined ? {} : { expires: expiresAt }),
    };
  }
}
