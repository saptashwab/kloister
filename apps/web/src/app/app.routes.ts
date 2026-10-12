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
    path: '',
    pathMatch: 'full',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/home/home').then((m) => m.HomePage),
  },
  { path: '**', redirectTo: '' },
];
