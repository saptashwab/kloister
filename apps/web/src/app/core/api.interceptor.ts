import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { CLIENT_ID_HEADER, CSRF_HEADER, CSRF_HEADER_VALUE } from '@kloister/shared';
import { catchError, throwError } from 'rxjs';
import { CLIENT_ID } from './api';
import { SessionStore } from './session.store';

/** Methods the API treats as safe (no CSRF header needed). */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Adds the CSRF header the API requires on state-changing requests
 * (SPEC §5) and the tab's client id (M10, so live updates skip this tab's
 * own echoes), and returns to the login page when the session has ended.
 *
 * A 401 from the login or session-check endpoints is left to the caller,
 * which shows its own message or redirect.
 *
 * @param request The outgoing request.
 * @param next The next handler.
 * @returns The response stream.
 */
export const apiInterceptor: HttpInterceptorFn = (request, next) => {
  const store = inject(SessionStore);
  const router = inject(Router);
  const outgoing = request.clone({
    setHeaders: SAFE_METHODS.has(request.method)
      ? { [CLIENT_ID_HEADER]: CLIENT_ID }
      : { [CSRF_HEADER]: CSRF_HEADER_VALUE, [CLIENT_ID_HEADER]: CLIENT_ID },
  });

  return next(outgoing).pipe(
    catchError((error: unknown) => {
      const handledByCaller =
        request.url.endsWith('auth/login') ||
        (request.method === 'GET' && request.url.endsWith('/me'));
      if (error instanceof HttpErrorResponse && error.status === 401 && !handledByCaller) {
        store.set(null);
        void router.navigate(['/login']);
      }
      return throwError(() => error);
    }),
  );
};
