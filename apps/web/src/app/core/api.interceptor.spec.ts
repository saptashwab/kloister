import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@kloister/shared';
import { firstValueFrom } from 'rxjs';
import { apiInterceptor } from './api.interceptor';
import { SessionStore } from './session.store';

describe('apiInterceptor', () => {
  let client: HttpClient;
  let http: HttpTestingController;
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([apiInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    client = TestBed.inject(HttpClient);
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  afterEach(() => http.verify());

  it('adds the CSRF header to state-changing requests only', () => {
    void firstValueFrom(client.post('api/v1/x', {}));
    void firstValueFrom(client.get('api/v1/y'));
    expect(http.expectOne('api/v1/x').request.headers.get(CSRF_HEADER)).toBe(CSRF_HEADER_VALUE);
    expect(http.expectOne('api/v1/y').request.headers.has(CSRF_HEADER)).toBe(false);
  });

  it('signs out and goes to login when the session has ended', async () => {
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const store = TestBed.inject(SessionStore);
    const promise = firstValueFrom(client.get('api/v1/admin/users'));
    http.expectOne('api/v1/admin/users').flush({}, { status: 401, statusText: 'Unauthorized' });
    await expect(promise).rejects.toBeTruthy();
    expect(store.user()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/login']);
  });

  it('leaves login failures to the login page', async () => {
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const promise = firstValueFrom(client.post('api/v1/auth/login', {}));
    http.expectOne('api/v1/auth/login').flush({}, { status: 401, statusText: 'Unauthorized' });
    await expect(promise).rejects.toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });
});
