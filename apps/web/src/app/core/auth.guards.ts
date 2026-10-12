import { inject } from '@angular/core';
import { type CanActivateFn, Router, type UrlTree } from '@angular/router';
import { SystemRole, type UserDto } from '@kloister/shared';
import { AuthService } from './auth.service';
import { SessionStore } from './session.store';

/**
 * Returns the current user, asking the API on first use.
 *
 * @returns The user, or null when signed out.
 */
async function currentUser(): Promise<UserDto | null> {
  const store = inject(SessionStore);
  const known = store.user();
  return known !== undefined ? known : inject(AuthService).load();
}

/**
 * Requires a signed-in user whose password change is not pending. Sends
 * everyone else to the login or change-password page.
 *
 * This only shapes navigation; the API enforces the same rules.
 *
 * @returns True, or a redirect.
 */
export const authGuard: CanActivateFn = async (): Promise<boolean | UrlTree> => {
  const router = inject(Router);
  const user = await currentUser();
  if (user === null) return router.createUrlTree(['/login']);
  if (user.mustChangePassword) return router.createUrlTree(['/change-password']);
  return true;
};

/**
 * Requires any signed-in user, including one who must change their password.
 *
 * @returns True, or a redirect to login.
 */
export const signedInGuard: CanActivateFn = async (): Promise<boolean | UrlTree> => {
  const router = inject(Router);
  return (await currentUser()) === null ? router.createUrlTree(['/login']) : true;
};

/**
 * Requires the ADMIN system role; others go to the home page.
 *
 * Loads the session itself rather than relying on {@link authGuard} having
 * run: Angular starts all guards of a route together, so on a fresh page load
 * the session state may still be unknown here.
 *
 * @returns True, or a redirect home.
 */
export const adminGuard: CanActivateFn = async (): Promise<boolean | UrlTree> => {
  const router = inject(Router);
  const user = await currentUser();
  return user?.systemRole === SystemRole.ADMIN ? true : router.createUrlTree(['/']);
};

/**
 * Keeps signed-in users off the login page.
 *
 * @returns True when signed out, otherwise a redirect home.
 */
export const guestGuard: CanActivateFn = async (): Promise<boolean | UrlTree> => {
  const router = inject(Router);
  return (await currentUser()) === null ? true : router.createUrlTree(['/']);
};
