import {
  Component,
  computed,
  effect,
  type ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu';
import type { ConnectedPosition } from '@angular/cdk/overlay';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { AuthService } from './core/auth.service';
import { NotificationsStore } from './core/notifications.store';
import { ProjectsNav } from './core/projects-nav';
import { SessionStore } from './core/session.store';
import { StaticAvatar } from './ui/avatar';
import { Icon } from './ui/icon';

/**
 * Root component: the app shell (DESIGN §7). Signed-in users get the
 * sidebar with the app name, "My work", the project switcher, admin links
 * and the user menu; the sign-in and forced password change screens are
 * shown without it. At narrow widths the sidebar opens from a menu button.
 * The bell (sidebar link, and a top bar button at narrow widths) shows the
 * unread notification count, polled every 60 seconds while signed in
 * (SPEC §6).
 *
 * The name is a placeholder; from M6 it comes from the admin branding
 * settings so no product or employer name is baked into the build. Admin
 * links are only hidden from non-admins here; the API enforces access.
 */
@Component({
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    CdkMenu,
    CdkMenuItem,
    CdkMenuTrigger,
    Icon,
    StaticAvatar,
  ],
  selector: 'app-root',
  // Esc anywhere closes the narrow sidebar when it is open.
  host: { '(keydown.escape)': 'closeNav()' },
  templateUrl: './app.html',
})
export class App {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** Signed-in state. */
  protected readonly store = inject(SessionStore);
  /** The caller's projects for the switcher. */
  protected readonly nav = inject(ProjectsNav);
  /** The unread notification count for the bell. */
  protected readonly notifications = inject(NotificationsStore);
  /** App name shown in the sidebar. */
  protected readonly title = signal('Kloister');
  /** The account menu opens above its button. */
  protected readonly menuPosition: ConnectedPosition[] = [
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -6 },
  ];
  /** Whether the sidebar is open at narrow widths. */
  protected readonly navOpen = signal(false);

  private readonly openNavButton = viewChild<ElementRef<HTMLButtonElement>>('openNavButton');
  private readonly closeNavButton = viewChild<ElementRef<HTMLButtonElement>>('closeNavButton');

  /** The signed-in user once they may use the app (no pending password change). */
  protected readonly user = computed(() => {
    const user = this.store.user();
    return user && !user.mustChangePassword ? user : null;
  });

  /** The unread count as shown on the badge. */
  protected readonly unreadText = computed(() => {
    const count = this.notifications.unread();
    return count > 99 ? '99+' : String(count);
  });

  /** Accessible name of the bell links, with the unread count. */
  protected readonly bellLabel = computed(() => {
    const count = this.notifications.unread();
    return count === 0 ? 'Notifications' : `Notifications, ${count} unread`;
  });

  /** The current URL, for highlighting the open project. */
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /** Key of the project being viewed, if any. */
  protected readonly currentKey = computed(
    () => /^\/p\/([^/?#]+)/.exec(this.url())?.[1]?.toUpperCase() ?? null,
  );

  /**
   * Loads the project switcher and starts the notification polling when
   * someone signs in (stopping it when they sign out), and closes the narrow
   * sidebar after every navigation.
   */
  constructor() {
    effect(() => {
      const id = this.user()?.id;
      untracked(() => {
        if (id === undefined) {
          this.nav.clear();
          this.notifications.stop();
        } else {
          void this.nav.refresh();
          this.notifications.start();
        }
      });
    });
    effect(() => {
      this.url();
      untracked(() => this.navOpen.set(false));
    });
  }

  /**
   * Opens the sidebar at narrow widths and moves focus into it.
   */
  protected openNav(): void {
    this.navOpen.set(true);
    // After the sidebar becomes visible, so it can take focus.
    setTimeout(() => this.closeNavButton()?.nativeElement.focus());
  }

  /**
   * Closes the narrow sidebar and returns focus to the menu button.
   */
  protected closeNav(): void {
    if (!this.navOpen()) return;
    this.navOpen.set(false);
    this.openNavButton()?.nativeElement.focus();
  }

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
