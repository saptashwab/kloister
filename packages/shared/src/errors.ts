/**
 * Machine-readable error codes returned in {@link ErrorResponse.code}.
 *
 * The web app switches on these rather than on HTTP status or message text.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  CSRF_HEADER_MISSING: 'CSRF_HEADER_MISSING',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  LAST_ADMIN: 'LAST_ADMIN',
  LAST_PM: 'LAST_PM',
  PROJECT_ARCHIVED: 'PROJECT_ARCHIVED',
  HAS_CHILDREN: 'HAS_CHILDREN',
  BUCKET_NOT_EMPTY: 'BUCKET_NOT_EMPTY',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
} as const;

/** One of the {@link ErrorCode} values. */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Shape of every error body the API returns (SPEC §8). */
export interface ErrorResponse {
  /** Stable machine-readable code. */
  code: ErrorCode;
  /** Human-readable summary, safe to show to the user. */
  message: string;
  /** Optional structured detail, e.g. per-field validation messages. */
  details?: unknown;
}
