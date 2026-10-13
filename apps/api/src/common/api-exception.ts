import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode, type ErrorResponse } from '@kloister/shared';

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

/**
 * A 400 `VALIDATION_FAILED` for one field, in the same shape as DTO
 * validation errors.
 *
 * @param field The field name.
 * @param message What is wrong with it.
 * @returns The exception to throw.
 */
export function invalidField(field: string, message: string): ApiException {
  return new ApiException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, message, [
    { field, messages: [message] },
  ]);
}

/**
 * A 404 `NOT_FOUND`.
 *
 * @param what What was not found, e.g. `Item`.
 * @returns The exception to throw.
 */
export function notFound(what: string): ApiException {
  return new ApiException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, `${what} not found`);
}

/**
 * A 403 `FORBIDDEN` for a role or rule that does not allow the action.
 *
 * @param message Optional explanation.
 * @returns The exception to throw.
 */
export function forbidden(message = 'Your project role does not allow this'): ApiException {
  return new ApiException(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, message);
}

/**
 * A 409 with the given code.
 *
 * @param code Error code, `CONFLICT` by default.
 * @param message What conflicts.
 * @returns The exception to throw.
 */
export function conflict(message: string, code: ErrorCode = ErrorCode.CONFLICT): ApiException {
  return new ApiException(HttpStatus.CONFLICT, code, message);
}
