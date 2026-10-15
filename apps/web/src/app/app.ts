import {
  Component,
  computed,
  effect,
  type ElementRef,
  inject,
  Injector,
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
import { ThemeService } from './core/theme.service';
import { Shortcuts } from './core/shortcuts';
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
 * The name and logo come from the admin's branding, and the signed-in
 * user's own theme is loaded at sign-in (SPEC §6), so no product or
 * employer branding is baked into the build. Admin links are only hidden
 * from non-admins here; the API enforces access.
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
  /** Lazy search and keyboard reference entry points. */
  protected readonly shortcuts = inject(Shortcuts);
  private readonly auth = inject(AuthService);
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);

  /** Signed-in state. */
  protected readonly store = inject(SessionStore);
  /** The caller's projects for the switcher. */
  protected readonly nav = inject(ProjectsNav);
  /** The unread notification count for the bell. */
  protected readonly notifications = inject(NotificationsStore);
  /** The admin's branding and the theme in effect. */
  protected readonly theme = inject(ThemeService);
  /** App name from the admin's branding, shown in the sidebar and sign-in page. */
  protected readonly title = this.theme.appName;
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
  /** Refresh session services only when the signed-in, password-cleared identity changes. */
  private readonly activeIdentity = computed(() => this.user()?.id);

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
   * Loads the project switcher and the user's own theme and starts the
   * notification polling when someone signs in (stopping it and returning
   * to the default theme when they sign out), and closes the narrow sidebar
   * after every navigation.
   */
  constructor() {
    effect(() => {
      const id = this.activeIdentity();
      untracked(() => {
        if (id === undefined) {
          this.nav.clear();
          this.notifications.stop();
          this.theme.setUserTheme(null);
        } else {
          void import('./pages/help/tour').then((m) => m.offerIntroduction(this.injector, id));
          void this.nav.refresh();
          this.notifications.start();
          void this.theme.loadUserTheme();
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
    // Wait for the content's inert attribute to be removed before focusing it.
    setTimeout(() => this.openNavButton()?.nativeElement.focus());
  }

  /**
   * Contains Tab in the phone menu; focus returns through closeNav.
   *
   * @param event The menu's keyboard event.
   */
  protected navKey(event: KeyboardEvent): void {
    if (!this.navOpen() || event.key !== 'Tab') return;
    const nav = event.currentTarget as HTMLElement;
    const controls = [...nav.querySelectorAll<HTMLElement>('a[href],button')].filter(
      (control) => control.getClientRects().length > 0,
    );
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
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
