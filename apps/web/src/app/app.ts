import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatToolbarModule } from '@angular/material/toolbar';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth.service';
import { SessionStore } from './core/session.store';

/**
 * Root component: the application shell with the header and router outlet.
 *
 * The title is a placeholder; from M6 it comes from the admin branding
 * settings so no product or employer name is baked into the build. Admin
 * links are only hidden from non-admins here; the API enforces access.
 */
@Component({
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatToolbarModule, MatButtonModule],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** Signed-in state for the header. */
  protected readonly store = inject(SessionStore);
  /** Name shown in the shell header. */
  protected readonly title = signal('Kloister');

  /**
   * Signs out and returns to the login page.
   *
   * @returns Resolves once navigation has started.
   */
  protected async logout(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(['/login']);
  }
}
