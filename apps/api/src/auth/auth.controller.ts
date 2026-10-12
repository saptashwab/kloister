import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { UserDto } from '@kloister/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthContext } from './auth-context.js';
import { ChangePasswordDto, LoginDto } from './auth.dto.js';
import { AuthService } from './auth.service.js';
import { AllowPendingPasswordChange, CurrentAuth, Public } from './decorators.js';
import { LoginRateLimitGuard } from './login-rate-limit.guard.js';
import { SESSION_COOKIE, SessionService } from './session.service.js';

/**
 * Session endpoints under `/api/v1/auth` (SPEC §5, §8).
 */
@Controller('auth')
export class AuthController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param auth Login and password logic.
   * @param sessions Cookie attributes.
   */
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Signs in and sets the session cookie.
   *
   * Permissions: public. Rate limited per client IP (the IP is resolved
   * through the trusted proxy only, so it cannot be spoofed); excess attempts
   * get 429 `RATE_LIMITED`. Still requires the CSRF header.
   *
   * @param body Email and password.
   * @param request Source of user agent and client IP.
   * @param reply Used to set the cookie.
   * @returns The signed-in user; check `mustChangePassword`.
   */
  @Public()
  @UseGuards(LoginRateLimitGuard)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: LoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<UserDto> {
    const { user, session } = await this.auth.login(body.email, body.password, {
      userAgent: request.headers['user-agent'],
      ip: request.ip,
    });
    reply.setCookie(SESSION_COOKIE, session.token, this.sessions.cookieOptions(session.expiresAt));
    return user;
  }

  /**
   * Ends the current session and clears the cookie.
   *
   * Permissions: any signed-in user, including one with a pending password change.
   *
   * @param auth The caller.
   * @param reply Used to clear the cookie.
   * @returns Nothing (204).
   */
  @AllowPendingPasswordChange()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentAuth() auth: AuthContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.auth.logout(auth);
    reply.clearCookie(SESSION_COOKIE, this.sessions.cookieOptions());
  }

  /**
   * Changes the caller's own password and ends their other sessions.
   *
   * Permissions: any signed-in user, for themselves only; this is the one
   * write allowed while a password change is pending. Shares the per-IP login
   * rate limit, so a hijacked session cannot guess the current password fast.
   *
   * @param auth The caller.
   * @param body Current and new password.
   * @returns The updated user (with `mustChangePassword: false`).
   */
  @AllowPendingPasswordChange()
  @UseGuards(LoginRateLimitGuard)
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body() body: ChangePasswordDto,
  ): Promise<UserDto> {
    return this.auth.changePassword(auth, body.currentPassword, body.newPassword);
  }
}
