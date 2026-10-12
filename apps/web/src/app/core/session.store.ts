import { computed, Injectable, signal } from '@angular/core';
import { SystemRole, type UserDto } from '@kloister/shared';

/**
 * Holds the signed-in user for the whole app.
 *
 * Kept separate from {@link AuthService} so the HTTP interceptor can clear it
 * on a 401 without depending on HttpClient (which would be circular).
 *
 * `undefined` means "not checked yet"; `null` means "checked, signed out".
 * The UI only uses this to show or hide controls; the API enforces access.
 */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly current = signal<UserDto | null | undefined>(undefined);

  /** The signed-in user, null when signed out, undefined before the first check. */
  readonly user = this.current.asReadonly();

  /** True when the signed-in user has the ADMIN system role. */
  readonly isAdmin = computed(() => this.current()?.systemRole === SystemRole.ADMIN);

  /**
   * Records the result of a login or session check.
   *
   * @param user The signed-in user, or null when signed out.
   */
  set(user: UserDto | null): void {
    this.current.set(user);
  }
}
