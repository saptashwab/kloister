import { Component, inject } from '@angular/core';
import { SessionStore } from '../../core/session.store';

/**
 * Landing page after sign-in. The projects list replaces this once projects
 * exist.
 */
@Component({
  selector: 'app-home',
  template: `
    <h2>Welcome, {{ store.user()?.displayName }}</h2>
    <p>You are not a member of any project yet.</p>
  `,
})
export class HomePage {
  /** Supplies the signed-in user's name. */
  protected readonly store = inject(SessionStore);
}
