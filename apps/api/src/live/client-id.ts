import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { CLIENT_ID_HEADER, CLIENT_ID_PATTERN } from '@kloister/shared';
import type { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';

/** What the current request carries for live updates. */
interface RequestLiveContext {
  /** The tab's id from `X-Client-Id`, or null when missing or malformed. */
  clientId: string | null;
}

/** Holds the live context of the request being handled. */
const storage = new AsyncLocalStorage<RequestLiveContext>();

/**
 * The id of the browser tab that sent the request being handled, so its own
 * change is not echoed back to it (M10 plan section 5.4).
 *
 * @returns The id, or null outside a request or without a valid header.
 */
export function currentClientId(): string | null {
  return storage.getStore()?.clientId ?? null;
}

/**
 * Validates a client id from a header or query.
 *
 * @param value The raw value.
 * @returns The id, or null when missing or malformed.
 */
export function parseClientId(value: unknown): string | null {
  return typeof value === 'string' && CLIENT_ID_PATTERN.test(value) ? value : null;
}

/**
 * Runs each request handler with the request's `X-Client-Id`, so audited
 * writes can tag their live event with it. The header only steers which tab
 * skips an echo; it grants nothing.
 */
@Injectable()
export class ClientIdInterceptor implements NestInterceptor {
  /**
   * Runs the handler inside the request's live context.
   *
   * @param context The current request.
   * @param next The handler.
   * @returns The handler's result stream.
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const clientId = parseClientId(request.headers[CLIENT_ID_HEADER]);
    return new Observable((subscriber) =>
      storage.run({ clientId }, () => {
        const subscription = next.handle().subscribe(subscriber);
        return () => subscription.unsubscribe();
      }),
    );
  }
}
