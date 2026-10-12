import { Routes } from '@angular/router';
import { adminGuard, authGuard, guestGuard, signedInGuard } from './core/auth.guards';

/**
 * Top-level routes. Pages are lazy-loaded to keep the initial bundle small.
 * Guards only shape navigation; the API enforces every permission itself.
 */
export const routes: Routes = [
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
    path: 'admin/audit',
    canActivate: [authGuard, adminGuard],
    loadComponent: () => import('./pages/admin-audit/admin-audit').then((m) => m.AdminAuditPage),
  },
  {
    path: 'p/:key/settings',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/project-settings/project-settings').then((m) => m.ProjectSettingsPage),
  },
  {
    path: '',
    pathMatch: 'full',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/projects/projects').then((m) => m.ProjectsPage),
  },
  { path: '**', redirectTo: '' },
];
