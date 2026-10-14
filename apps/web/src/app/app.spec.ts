import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { DEFAULT_APP_NAME, ThemeMode } from '@kloister/shared';
import { settle } from '../testing/fixtures';
import { App } from './app';
import { NotificationsStore } from './core/notifications.store';
import { SessionStore } from './core/session.store';
import { DEFAULT_BRANDING, ThemeService } from './core/theme.service';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  it('creates the shell', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('renders the default app name until an admin sets one, then the admin’s name and logo', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain(DEFAULT_APP_NAME);
    expect(compiled.querySelector('img.k-logo')).toBeNull();

    TestBed.inject(ThemeService).setBranding({
      ...DEFAULT_BRANDING,
      appName: 'Team Board',
      logoUrl: 'api/v1/branding/logo?v=1',
    });
    await fixture.whenStable();
    expect(compiled.querySelector('h1')?.textContent).toContain('Team Board');
    expect(compiled.querySelector('img.k-logo')?.getAttribute('src')).toBe(
      'api/v1/branding/logo?v=1',
    );
    expect(document.title).toBe('Team Board');
  });

  it('shows admin links only to admins', async () => {
    const store = TestBed.inject(SessionStore);
    const base = {
      id: 'u1',
      email: 'a@example.org',
      displayName: 'A',
      mustChangePassword: false,
      isActive: true,
      lastLoginAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const fixture = TestBed.createComponent(App);
    store.set({ ...base, systemRole: 'USER' });
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).not.toContain('Audit log');

    store.set({ ...base, systemRole: 'ADMIN' });
    await fixture.whenStable();
    expect(root.textContent).toContain('Audit log');
    expect(root.querySelector('a[href="/admin/settings"]')?.textContent).toContain('Settings');
  });

  it('loads the signed-in user’s own theme and drops it on sign-out', async () => {
    const fixture = TestBed.createComponent(App);
    const store = TestBed.inject(SessionStore);
    const theme = TestBed.inject(ThemeService);
    store.set({
      id: 'u1',
      email: 'a@example.org',
      displayName: 'A',
      systemRole: 'USER',
      mustChangePassword: false,
      isActive: true,
      lastLoginAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await fixture.whenStable();
    const own = { mode: ThemeMode.DARK, primary: '#0F766E', accent: '#0F766E' };
    const http = TestBed.inject(HttpTestingController);
    http.match('api/v1/me/theme').forEach((request) => request.flush({ theme: own }));
    await settle(fixture);
    expect(theme.userTheme()).toEqual(own);
    store.set(null);
    await fixture.whenStable();
    expect(theme.userTheme()).toBeNull();
    TestBed.inject(NotificationsStore).stop();
  });

  it('shows the unread notification count on the bell once signed in', async () => {
    const fixture = TestBed.createComponent(App);
    TestBed.inject(SessionStore).set({
      id: 'u1',
      email: 'a@example.org',
      displayName: 'A',
      systemRole: 'USER',
      mustChangePassword: false,
      isActive: true,
      lastLoginAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await fixture.whenStable();
    TestBed.inject(HttpTestingController)
      .match('api/v1/notifications/unread-count')
      .forEach((request) => request.flush({ count: 3 }));
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    const links = root.querySelectorAll('a[aria-label="Notifications, 3 unread"]');
    expect(links.length).toBe(2);
    expect(links[0]?.querySelector('.k-badge')?.textContent).toBe('3');
    TestBed.inject(NotificationsStore).stop();
  });
});
