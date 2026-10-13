import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { routes } from './app.routes';
import { apiInterceptor } from './core/api.interceptor';

/** Application-wide providers passed to `bootstrapApplication`. */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Route parameters such as `:key` bind to component inputs; child routes
    // (board, item drawer, settings) inherit their parent's `:key`.
    provideRouter(
      routes,
      withComponentInputBinding(),
      withRouterConfig({ paramsInheritanceStrategy: 'always' }),
    ),
    provideHttpClient(withInterceptors([apiInterceptor])),
  ],
};
