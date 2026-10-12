import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ErrorCode, type ErrorResponse } from '@kloister/shared';
import type { FastifyReply } from 'fastify';

/** Default code for each HTTP status when the thrown error did not name one. */
const CODE_BY_STATUS: Record<number, ErrorCode> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_FAILED,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
};

/**
 * Type guard for bodies that already follow {@link ErrorResponse}.
 *
 * @param body A thrown exception's response body.
 * @returns True if the body has string `code` and `message` fields.
 */
function isErrorResponse(body: unknown): body is ErrorResponse {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as Record<string, unknown>)['code'] === 'string' &&
    typeof (body as Record<string, unknown>)['message'] === 'string'
  );
}

/**
 * Converts any thrown error into the API's error shape (SPEC §8).
 *
 * Unexpected errors become a generic 500 so stack traces and database
 * details never reach the client; they are logged server-side instead.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  /**
   * Writes the error response.
   *
   * @param exception Whatever was thrown.
   * @param host Gives access to the Fastify reply.
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const { status, body } = toErrorResponse(exception);
    if (status >= 500) {
      this.logger.error(
        exception instanceof Error ? (exception.stack ?? exception.message) : exception,
      );
    }
    void reply.status(status).send(body);
  }
}

/**
 * Maps a thrown value to a status and error body. Nest routes errors raised
 * by Fastify itself (malformed JSON, oversized bodies) through the filter too,
 * so those are handled here as well.
 *
 * @param exception Whatever was thrown.
 * @returns HTTP status and the body to send.
 */
export function toErrorResponse(exception: unknown): { status: number; body: ErrorResponse } {
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const response = exception.getResponse();
    if (isErrorResponse(response)) {
      return { status, body: response };
    }
    return {
      status,
      body: { code: CODE_BY_STATUS[status] ?? ErrorCode.INTERNAL, message: exception.message },
    };
  }

  // Fastify errors (body parsing, payload too large) carry a 4xx statusCode
  // and a message that is safe to show.
  const statusCode = (exception as { statusCode?: unknown } | null)?.statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return {
      status: statusCode,
      body: {
        code: CODE_BY_STATUS[statusCode] ?? ErrorCode.VALIDATION_FAILED,
        message: exception instanceof Error ? exception.message : 'Bad request',
      },
    };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: { code: ErrorCode.INTERNAL, message: 'Internal server error' },
  };
}
