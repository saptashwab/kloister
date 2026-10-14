import { Component } from '@angular/core';
import { MatTabsModule } from '@angular/material/tabs';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

/** The admin settings tabs (SPEC §6 Admin). */
const TABS: readonly { path: string; name: string }[] = [
  { path: 'branding', name: 'Branding' },
  { path: 'security', name: 'Security' },
  { path: 'storage', name: 'Storage' },
  { path: 'backups', name: 'Backups' },
  { path: 'logs', name: 'Logs' },
];

/**
 * The admin settings page: a tab bar (branding, security, storage, backups,
 * logs), each tab its own route below `/admin/settings`.
 *
 * Permissions: the route is guarded for admins; every endpoint behind the
 * tabs is admin-only in the API as well.
 */
@Component({
  selector: 'app-admin-settings',
  host: { class: 'k-page' },
  imports: [MatTabsModule, RouterLink, RouterLinkActive, RouterOutlet],
  template: `
    <header class="k-page-head"><h1>Settings</h1></header>
    <nav mat-tab-nav-bar class="k-settings-tabs" aria-label="Settings sections" [tabPanel]="panel">
      @for (tab of tabs; track tab.path) {
        <a
          mat-tab-link
          [routerLink]="tab.path"
          routerLinkActive
          #active="routerLinkActive"
          [active]="active.isActive"
          >{{ tab.name }}</a
        >
      }
    </nav>
    <mat-tab-nav-panel #panel>
      <router-outlet />
    </mat-tab-nav-panel>
  `,
})
export class AdminSettingsPage {
  /** The tabs. */
  protected readonly tabs = TABS;
}
