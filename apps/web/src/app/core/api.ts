import { HttpErrorResponse } from '@angular/common/http';
import { API_PREFIX, type ErrorResponse } from '@kloister/shared';

/**
 * Builds an API URL relative to the document base href, so the app works
 * under whatever `/<app_name>/` path httpd serves it from (SPEC §9.2).
 *
 * @param path Path below `/api/v1`, without a leading slash.
 * @returns A relative URL such as `api/v1/me`.
 */
export function apiUrl(path: string): string {
  return `${API_PREFIX}/${path}`;
}

/**
 * Extracts a user-facing message from a failed request.
 *
 * @param error Whatever the HTTP call threw.
 * @returns The API's `message` when present, otherwise a generic message.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as Partial<ErrorResponse> | null;
    if (body !== null && typeof body.message === 'string') return body.message;
    if (error.status === 0) return 'The server could not be reached.';
  }
  return 'Something went wrong. Please try again.';
}
