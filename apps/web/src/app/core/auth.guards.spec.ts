import { TestBed } from '@angular/core/testing';
import {
  type ActivatedRouteSnapshot,
  provideRouter,
  type RouterStateSnapshot,
  UrlTree,
} from '@angular/router';
import type { UserDto } from '@kloister/shared';
import { AuthService } from './auth.service';
import { adminGuard, authGuard, guestGuard, signedInGuard } from './auth.guards';
import { SessionStore } from './session.store';

const user = (overrides: Partial<UserDto> = {}): UserDto => ({
  id: 'u1',
  email: 'a@example.org',
  displayName: 'A',
  systemRole: 'USER',
  mustChangePassword: false,
  isActive: true,
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('route guards', () => {
  let store: SessionStore;
  const load = vi.fn<() => Promise<UserDto | null>>();

  beforeEach(() => {
    load.mockReset();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthService, useValue: { load } }],
    });
    store = TestBed.inject(SessionStore);
  });

  const run = (guard: typeof authGuard) =>
    TestBed.runInInjectionContext(() =>
      guard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
    ) as Promise<boolean | UrlTree> | boolean | UrlTree;

  const target = async (guard: typeof authGuard) => {
    const result = await run(guard);
    return result instanceof UrlTree ? result.toString() : result;
  };

  it('asks the API once when the session state is unknown', async () => {
    load.mockResolvedValue(null);
    expect(await target(authGuard)).toBe('/login');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('sends users with a pending password change to change-password', async () => {
    store.set(user({ mustChangePassword: true }));
    expect(await target(authGuard)).toBe('/change-password');
    expect(await target(signedInGuard)).toBe(true);
  });

  it('lets signed-in users through and keeps them off the login page', async () => {
    store.set(user());
    expect(await target(authGuard)).toBe(true);
    expect(await target(guestGuard)).toBe('/');
  });

  it('admin guard loads the session itself on a fresh page load', async () => {
    load.mockResolvedValue(user({ systemRole: 'ADMIN' }));
    expect(await target(adminGuard)).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('restricts admin pages to admins', async () => {
    store.set(user());
    expect(await target(adminGuard)).toBe('/');
    store.set(user({ systemRole: 'ADMIN' }));
    expect(await target(adminGuard)).toBe(true);
  });
});
