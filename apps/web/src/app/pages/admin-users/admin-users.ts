import { DatePipe } from '@angular/common';
import { Component, inject, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { SystemRole, type UpdateUserRequest, type UserDto } from '@kloister/shared';
import { AdminApiService } from '../../core/admin-api.service';
import { errorMessage } from '../../core/api';
import { Dialogs } from '../../ui/dialogs';
import { required, email } from '../../core/validators';
import { SessionStore } from '../../core/session.store';

/** A temporary password to show once, with whom it belongs to. */
interface IssuedPassword {
  email: string;
  password: string;
}

import { EmptyState, Skeleton } from '../../ui/feedback';

/**
 * Admin user management: create users, promote/demote, deactivate/reactivate
 * and reset passwords (SPEC §3.1, §6). Temporary passwords are shown once and
 * disappear when dismissed or when the page is left.
 *
 * Permissions: route guarded for admins; the API enforces it independently.
 */
@Component({
  selector: 'app-admin-users',
  host: { class: 'k-page' },
  imports: [
    EmptyState,
    Skeleton,
    DatePipe,
    ReactiveFormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  template: `
    <header class="k-page-head"><h1>Users</h1></header>

    @if (issued(); as issued) {
      <mat-card class="notice" role="status">
        <mat-card-content>
          <p>
            Temporary password for <strong>{{ issued.email }}</strong> (shown only once; the user
            must change it at first sign-in):
          </p>
          <p class="secret">{{ issued.password }}</p>
          <button mat-button type="button" (click)="dismissIssued()">Done</button>
        </mat-card-content>
      </mat-card>
    }

    <mat-card>
      <mat-card-header><mat-card-title>New user</mat-card-title></mat-card-header>
      <mat-card-content>
        <form class="row" [formGroup]="createForm" (ngSubmit)="create()">
          <mat-form-field>
            <mat-label>Email</mat-label>
            <input matInput type="email" formControlName="email" />
          </mat-form-field>
          <mat-form-field>
            <mat-label>Display name</mat-label>
            <input matInput formControlName="displayName" />
          </mat-form-field>
          <mat-form-field>
            <mat-label>Role</mat-label>
            <mat-select formControlName="systemRole">
              <mat-option [value]="roles.USER">User</mat-option>
              <mat-option [value]="roles.ADMIN">Admin</mat-option>
            </mat-select>
          </mat-form-field>
          <button mat-flat-button type="submit" [disabled]="createForm.invalid || busy()">
            Create
          </button>
        </form>
      </mat-card-content>
    </mat-card>

    <div class="row">
      <mat-form-field>
        <mat-label>Search</mat-label>
        <input matInput #search (keyup.enter)="reload(search.value)" />
      </mat-form-field>
      <button mat-button type="button" (click)="reload(search.value)">Search</button>
    </div>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    @if (loading()) {
      <app-skeleton label="Loading the list" />
    } @else {
      <div class="k-table-scroll" tabindex="0" role="region" aria-label="Scrollable table">
        <table class="data">
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              <th scope="col">Last sign-in</th>
              <th scope="col"><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            @for (user of users(); track user.id) {
              <tr>
                <td>{{ user.email }}</td>
                <td>{{ user.displayName }}</td>
                <td>{{ user.systemRole === roles.ADMIN ? 'Admin' : 'User' }}</td>
                <td>{{ user.isActive ? 'Active' : 'Deactivated' }}</td>
                <td>{{ user.lastLoginAt ? (user.lastLoginAt | date: 'short') : 'Never' }}</td>
                <td class="actions">
                  @if (user.systemRole === roles.ADMIN) {
                    <button
                      mat-button
                      type="button"
                      (click)="update(user, { systemRole: roles.USER })"
                    >
                      Make user
                    </button>
                  } @else {
                    <button
                      mat-button
                      type="button"
                      (click)="update(user, { systemRole: roles.ADMIN })"
                    >
                      Make admin
                    </button>
                  }
                  <button
                    mat-button
                    type="button"
                    (click)="update(user, { isActive: !user.isActive })"
                  >
                    {{ user.isActive ? 'Deactivate' : 'Reactivate' }}
                  </button>
                  @if (user.id !== store.user()?.id) {
                    <button mat-button type="button" (click)="resetPassword(user)">
                      Reset password
                    </button>
                  }
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="6">
                  <app-empty-state
                    title="No users match"
                    text="Try another search or create a user with the form above."
                  />
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
    @if (nextCursor()) {
      <button mat-button type="button" (click)="loadMore()">Load more</button>
    }
  `,
})
export class AdminUsersPage implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly dialogs = inject(Dialogs);
  /** Used to hide self-service-only actions. */
  protected readonly store = inject(SessionStore);

  /** Role values for the template. */
  protected readonly roles = SystemRole;
  /** Loaded users. */
  protected readonly users = signal<UserDto[]>([]);
  /** Cursor for the next page, or null. */
  protected readonly nextCursor = signal<string | null>(null);
  /** The one-time temporary password currently on screen. */
  protected readonly issued = signal<IssuedPassword | null>(null);
  /** Last error message, if any. */
  protected readonly error = signal('');
  /** True while the list is being replaced. */
  protected readonly loading = signal(true);
  /** True while a create request is in flight. */
  protected readonly busy = signal(false);

  private query = '';

  /** New-user form. */
  protected readonly createForm = inject(NonNullableFormBuilder).group({
    email: ['', [required, email]],
    displayName: ['', [required, Validators.maxLength(100)]],
    systemRole: [SystemRole.USER as SystemRole],
  });

  /**
   * Loads the first page.
   */
  ngOnInit(): void {
    void this.reload('');
  }

  /**
   * Replaces the list with the first page matching a search.
   *
   * @param query Search text; empty for all users.
   * @returns Resolves once loaded.
   */
  protected async reload(query: string): Promise<void> {
    this.loading.set(true);
    this.query = query.trim();
    await this.run(async () => {
      const page = await this.api.listUsers(this.query, undefined);
      this.users.set(page.items);
      this.nextCursor.set(page.nextCursor);
    });
    this.loading.set(false);
  }

  /**
   * Appends the next page.
   *
   * @returns Resolves once loaded.
   */
  protected async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (cursor === null) return;
    await this.run(async () => {
      const page = await this.api.listUsers(this.query, cursor);
      this.users.update((users) => [...users, ...page.items]);
      this.nextCursor.set(page.nextCursor);
    });
  }

  /**
   * Creates a user and shows their temporary password.
   *
   * @returns Resolves once done.
   */
  protected async create(): Promise<void> {
    this.busy.set(true);
    await this.run(async () => {
      const { user, temporaryPassword } = await this.api.createUser(this.createForm.getRawValue());
      this.users.update((users) => [user, ...users]);
      this.issued.set({ email: user.email, password: temporaryPassword });
      this.createForm.reset();
    });
    this.busy.set(false);
  }

  /**
   * Applies a change to one user and refreshes their row.
   *
   * @param user The user.
   * @param change Fields to change.
   * @returns Resolves once done.
   */
  protected async update(user: UserDto, change: UpdateUserRequest): Promise<void> {
    await this.run(async () => {
      const updated = await this.api.updateUser(user.id, change);
      this.users.update((users) => users.map((u) => (u.id === updated.id ? updated : u)));
    });
  }

  /**
   * Resets a user's password after confirmation and shows the new one.
   *
   * @param user The user.
   * @returns Resolves once done.
   */
  protected async resetPassword(user: UserDto): Promise<void> {
    const confirmed = await this.dialogs.confirm({
      title: `Reset the password for ${user.email}?`,
      message:
        'They are signed out everywhere and must choose a new password at their next sign-in.',
      confirm: 'Reset password',
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    await this.run(async () => {
      const { temporaryPassword } = await this.api.resetPassword(user.id);
      this.issued.set({ email: user.email, password: temporaryPassword });
    });
  }

  /** Removes the temporary password from the screen. */
  protected dismissIssued(): void {
    this.issued.set(null);
  }

  /**
   * Runs an action, showing any error instead of throwing.
   *
   * @param action The work to do.
   * @returns Resolves once the action settles.
   */
  private async run(action: () => Promise<void>): Promise<void> {
    this.error.set('');
    try {
      await action();
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }
}
