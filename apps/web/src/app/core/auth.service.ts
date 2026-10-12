import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { ChangePasswordRequest, LoginRequest, UserDto } from '@kloister/shared';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from './api';
import { SessionStore } from './session.store';

/**
 * Talks to the session endpoints and keeps {@link SessionStore} in sync.
 * The session itself lives in an httpOnly cookie the app cannot read.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly store = inject(SessionStore);

  /**
   * Asks the API who is signed in. Called once by the route guards.
   *
   * @returns The user, or null when there is no valid session.
   */
  async load(): Promise<UserDto | null> {
    try {
      const user = await firstValueFrom(this.http.get<UserDto>(apiUrl('me')));
      this.store.set(user);
      return user;
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        this.store.set(null);
        return null;
      }
      throw error;
    }
  }

  /**
   * Signs in. The API sets the session cookie.
   *
   * @param credentials Email and password.
   * @returns The signed-in user; check `mustChangePassword`.
   */
  async login(credentials: LoginRequest): Promise<UserDto> {
    const user = await firstValueFrom(this.http.post<UserDto>(apiUrl('auth/login'), credentials));
    this.store.set(user);
    return user;
  }

  /**
   * Signs out. The local state is cleared even if the request fails, since
   * the user asked to leave.
   *
   * @returns Resolves once done.
   */
  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.http.post<void>(apiUrl('auth/logout'), {}));
    } finally {
      this.store.set(null);
    }
  }

  /**
   * Changes the signed-in user's password; other sessions are ended by the API.
   *
   * @param request Current and new password.
   * @returns The updated user.
   */
  async changePassword(request: ChangePasswordRequest): Promise<UserDto> {
    const user = await firstValueFrom(
      this.http.post<UserDto>(apiUrl('auth/change-password'), request),
    );
    this.store.set(user);
    return user;
  }
}
