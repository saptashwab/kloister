import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { Router } from '@angular/router';
import type { UserDto } from '@kloister/shared';
import { settle } from '../../../testing/fixtures';
import { AuthService } from '../../core/auth.service';
import { ProjectsApiService } from '../../core/projects-api.service';
import { SessionStore } from '../../core/session.store';
import { offerIntroduction, TourDialog, TourLauncher } from './tour';

const user: UserDto = {
  id: 'u1',
  email: 'user@example.org',
  displayName: 'User',
  systemRole: 'USER',
  mustChangePassword: false,
  isActive: true,
  lastLoginAt: null,
  createdAt: '2026-01-01',
};

describe('durable tour launch races', () => {
  it('ignores a delayed READY response after successful Skip while still permitting manual replay', async () => {
    const dialogs = { openDialogs: [], open: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: MatDialog, useValue: dialogs },
      ],
    });
    TestBed.inject(SessionStore).set(user);
    const pending = offerIntroduction(TestBed.inject(Injector), user.id);
    const response = TestBed.inject(HttpTestingController).expectOne('api/v1/me/introduction');
    const launcher = TestBed.inject(TourLauncher);
    launcher.markDismissed(user.id);
    response.flush({ pending: true });
    await pending;
    expect(dialogs.open).not.toHaveBeenCalled();
    launcher.open();
    expect(dialogs.open).toHaveBeenCalledTimes(1);
  });
});

describe('current tour capabilities', () => {
  it('visits My work without memberships and refreshes independent admin rights on every move', async () => {
    let current = user;
    const store = new SessionStore();
    store.set(current);
    const auth = {
      load: vi.fn().mockImplementation(() => {
        store.set({ ...current });
        return Promise.resolve(current);
      }),
    };
    const router = { url: '/help', navigate: vi.fn().mockResolvedValue(true) };
    await TestBed.configureTestingModule({
      imports: [TourDialog],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: auth },
        { provide: SessionStore, useValue: store },
        { provide: Router, useValue: router },
        {
          provide: ProjectsApiService,
          useValue: { list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) },
        },
        { provide: TourLauncher, useValue: { markDismissed: vi.fn() } },
        { provide: MatDialogRef, useValue: { close: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(TourDialog);
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    expect(router.navigate).toHaveBeenLastCalledWith(['/work']);
    expect(root.textContent).toContain('Step 1 of 5');
    const click = async (label: string) => {
      Array.from(root.querySelectorAll('button'))
        .find((button) => button.textContent?.trim() === label)
        ?.click();
      await settle(fixture);
    };
    current = { ...user, systemRole: 'ADMIN' };
    await click('Next');
    expect(root.textContent).toContain('Step 2 of 6');
    await click('Next');
    await click('Next');
    await click('Next');
    expect(root.textContent).toContain('Your system administrator tools');
    current = user;
    await click('Back');
    await click('Next');
    expect(root.textContent).toContain('Ready when you are');
    expect(root.textContent).not.toContain('Your system administrator tools');
  });
});
