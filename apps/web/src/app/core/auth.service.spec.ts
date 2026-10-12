import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { UserDto } from '@kloister/shared';
import { AuthService } from './auth.service';
import { SessionStore } from './session.store';

const user: UserDto = {
  id: 'u1',
  email: 'a@example.org',
  displayName: 'A',
  systemRole: 'USER',
  mustChangePassword: false,
  isActive: true,
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('AuthService', () => {
  let service: AuthService;
  let store: SessionStore;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AuthService);
    store = TestBed.inject(SessionStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('uses relative API URLs so the app works under any base path', async () => {
    const promise = service.login({ email: 'a@example.org', password: 'pw' });
    const req = http.expectOne('api/v1/auth/login');
    expect(req.request.method).toBe('POST');
    req.flush(user);
    await expect(promise).resolves.toEqual(user);
    expect(store.user()).toEqual(user);
  });

  it('treats 401 from /me as signed out', async () => {
    const promise = service.load();
    http.expectOne('api/v1/me').flush({}, { status: 401, statusText: 'Unauthorized' });
    await expect(promise).resolves.toBeNull();
    expect(store.user()).toBeNull();
  });

  it('clears the session on logout even if the request fails', async () => {
    store.set(user);
    const promise = service.logout();
    http.expectOne('api/v1/auth/logout').flush({}, { status: 500, statusText: 'Error' });
    await expect(promise).rejects.toBeTruthy();
    expect(store.user()).toBeNull();
  });

  it('stores the user returned by change-password', async () => {
    store.set({ ...user, mustChangePassword: true });
    const promise = service.changePassword({ currentPassword: 'a', newPassword: 'b' });
    http.expectOne('api/v1/auth/change-password').flush(user);
    await promise;
    expect(store.user()?.mustChangePassword).toBe(false);
  });
});
