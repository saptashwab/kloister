import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ErrorCode } from '@kloister/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiException } from '../common/api-exception.js';
import { AppConfig } from '../config/app-config.js';

/** Counter for one client IP within the current window. */
interface Window {
  /** Attempts so far in this window. */
  count: number;
  /** Epoch milliseconds when the window ends. */
  resetAt: number;
}

/**
 * Per-IP fixed-window rate limit for `POST /auth/login` (SPEC §5).
 *
 * Complements account lockout: lockout protects one account from many
 * guesses, this protects many accounts from one source. Counters live in
 * memory, which is enough for the single backend process SPEC §9 deploys.
 *
 * The key is `request.ip`, which Fastify resolves through `trustProxy` only,
 * so clients cannot dodge the limit with a forged `X-Forwarded-For`.
 *
 * Permissions: applies to anonymous callers; excess attempts get 429
 * `RATE_LIMITED` with a `Retry-After` header.
 */
@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  private readonly windows = new Map<string, Window>();

  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param config Supplies the limit and window length.
   */
  constructor(private readonly config: AppConfig) {}

  /**
   * Counts this attempt and rejects it if the IP is over the limit.
   *
   * @param context The current request.
   * @returns True when under the limit; throws otherwise.
   */
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const now = Date.now();
    this.prune(now);

    let window = this.windows.get(request.ip);
    if (window === undefined || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.config.loginRateWindowMs };
      this.windows.set(request.ip, window);
    }
    window.count += 1;
    if (window.count <= this.config.loginRateLimit) return true;

    const retryAfterSeconds = Math.ceil((window.resetAt - now) / 1000);
    void http.getResponse<FastifyReply>().header('Retry-After', String(retryAfterSeconds));
    throw new ApiException(
      HttpStatus.TOO_MANY_REQUESTS,
      ErrorCode.RATE_LIMITED,
      'Too many login attempts; try again later',
    );
  }

  /**
   * Drops expired windows so memory stays bounded by recent distinct IPs.
   * Runs at most once per window length.
   *
   * @param now Current epoch milliseconds.
   */
  private prune(now: number): void {
    if (now < this.nextPruneAt) return;
    this.nextPruneAt = now + this.config.loginRateWindowMs;
    for (const [ip, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(ip);
    }
  }

  /** Epoch milliseconds of the next {@link prune} sweep. */
  private nextPruneAt = 0;
}
