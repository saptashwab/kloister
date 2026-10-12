import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { UserDto } from '@kloister/shared';
import { AuthService } from '../../core/auth.service';
import { LoginPage } from './login';

describe('LoginPage', () => {
  const login = vi.fn<(c: unknown) => Promise<UserDto>>();

  beforeEach(async () => {
    login.mockReset();
    await TestBed.configureTestingModule({
      imports: [LoginPage],
      providers: [provideRouter([]), { provide: AuthService, useValue: { login } }],
    }).compileComponents();
  });

  async function submit(email: string, password: string) {
    const fixture = TestBed.createComponent(LoginPage);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const [emailInput, passwordInput] = Array.from(root.querySelectorAll('input'));
    emailInput.value = email;
    emailInput.dispatchEvent(new Event('input'));
    passwordInput.value = password;
    passwordInput.dispatchEvent(new Event('input'));
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    return root;
  }

  it('routes users with a temporary password to change-password', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    login.mockResolvedValue({ mustChangePassword: true } as UserDto);
    await submit('a@example.org', 'pw');
    expect(login).toHaveBeenCalledWith({ email: 'a@example.org', password: 'pw' });
    expect(navigate).toHaveBeenCalledWith(['/change-password']);
  });

  it('shows the API error message on failure', async () => {
    login.mockRejectedValue(
      new HttpErrorResponse({
        status: 401,
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      }),
    );
    const root = await submit('a@example.org', 'bad');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'Invalid email or password',
    );
  });
});
