import { Routes } from '@angular/router';
import { adminGuard, authGuard, guestGuard, signedInGuard } from './core/auth.guards';

/**
 * Loads the item drawer, shown beside the board or the backlog.
 *
 * @returns The drawer component.
 */
const itemDrawer = () => import('./pages/item-drawer/item-drawer').then((m) => m.ItemDrawer);

/** Empty child route: the board or backlog without an open item. */
const NO_DRAWER: Routes = [{ path: '', children: [] }];

/**
 * Top-level routes. Pages are lazy-loaded to keep the initial bundle small.
 * Guards only shape navigation; the API enforces every permission itself.
 */
export const routes: Routes = [
  {
    path: 'help',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/help/help').then((m) => m.HelpPage),
  },
  {
    path: 'login',
    canActivate: [guestGuard],
    loadComponent: () => import('./pages/login/login').then((m) => m.LoginPage),
  },
  {
    path: 'change-password',
    canActivate: [signedInGuard],
    loadComponent: () =>
      import('./pages/change-password/change-password').then((m) => m.ChangePasswordPage),
  },
  {
    path: 'admin/users',
    canActivate: [authGuard, adminGuard],
    loadComponent: () => import('./pages/admin-users/admin-users').then((m) => m.AdminUsersPage),
  },
  {
    // Admin settings (SPEC §6 Admin), one tab per section.
    path: 'admin/settings',
    canActivate: [authGuard, adminGuard],
    loadComponent: () =>
      import('./pages/admin-settings/admin-settings').then((m) => m.AdminSettingsPage),
    children: [
      {
        path: 'branding',
        loadComponent: () =>
          import('./pages/admin-settings/admin-branding').then((m) => m.AdminBrandingPage),
      },
      {
        path: 'security',
        loadComponent: () =>
          import('./pages/admin-settings/admin-security').then((m) => m.AdminSecurityPage),
      },
      {
        path: 'storage',
        loadComponent: () =>
          import('./pages/admin-settings/admin-storage').then((m) => m.AdminStoragePage),
      },
      {
        path: 'backups',
        loadComponent: () =>
          import('./pages/admin-settings/admin-backups').then((m) => m.AdminBackupsPage),
      },
      {
        path: 'logs',
        loadComponent: () =>
          import('./pages/admin-settings/admin-logs').then((m) => m.AdminLogsPage),
      },
      { path: '', pathMatch: 'full', redirectTo: 'branding' },
    ],
  },
  {
    // The signed-in user's own settings and theme (SPEC §6 user settings).
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/account-settings/account-settings').then((m) => m.AccountSettingsPage),
  },
  {
    path: 'admin/audit',
    canActivate: [authGuard, adminGuard],
    loadComponent: () => import('./pages/admin-audit/admin-audit').then((m) => m.AdminAuditPage),
  },
  {
    // The bell's list (SPEC §6).
    path: 'notifications',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/notifications/notifications').then((m) => m.NotificationsPage),
  },
  {
    path: 'work',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/work/work').then((m) => m.WorkPage),
  },
  { path: 'personal', pathMatch: 'full', redirectTo: 'p/personal' },
  {
    // "All their work" (SPEC §6); the sidebar's "My work" is the caller's own.
    path: 'people/:userId',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/work/work').then((m) => m.WorkPage),
  },
  {
    // A project: the board by default, the item drawer at `items/:number`
    // (SPEC §6 deep link), plus backlog, sprints and settings. Child routes
    // inherit `:key` (see `paramsInheritanceStrategy` in app.config.ts).
    path: 'p/:key',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/project/project-shell').then((m) => m.ProjectShellPage),
    children: [
      {
        path: 'ado',
        loadComponent: () =>
          import('./pages/ado-transfer/ado-transfer').then((m) => m.AdoTransferPage),
      },
      {
        path: 'backlog',
        loadComponent: () => import('./pages/backlog/backlog').then((m) => m.BacklogPage),
        children: [{ path: 'items/:number', loadComponent: itemDrawer }, ...NO_DRAWER],
      },
      {
        path: 'sprints',
        loadComponent: () => import('./pages/sprints/sprints').then((m) => m.SprintsPage),
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./pages/project-settings/project-settings').then((m) => m.ProjectSettingsPage),
      },
      {
        path: '',
        loadComponent: () => import('./pages/board/board').then((m) => m.BoardPage),
        children: [{ path: 'items/:number', loadComponent: itemDrawer }, ...NO_DRAWER],
      },
    ],
  },
  {
    path: '',
    pathMatch: 'full',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/projects/projects').then((m) => m.ProjectsPage),
  },
  { path: '**', redirectTo: '' },
];
