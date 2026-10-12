import { HttpException } from '@nestjs/common';
import type { ErrorCode, ErrorResponse } from '@kloister/shared';

/**
 * An HTTP error carrying the API's `{ code, message, details? }` body
 * (SPEC §8). Throw this from services and guards instead of Nest's built-in
 * exceptions whenever the client needs a specific {@link ErrorCode}.
 */
export class ApiException extends HttpException {
  /**
   * Builds the exception together with its error body.
   *
   * @param status HTTP status code.
   * @param code Machine-readable error code.
   * @param message Human-readable message, safe to show to users.
   * @param details Optional structured detail.
   */
  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    const body: ErrorResponse =
      details === undefined ? { code, message } : { code, message, details };
    super(body, status);
  }
}
