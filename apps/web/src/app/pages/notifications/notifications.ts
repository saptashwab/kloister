import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { RouterLink } from '@angular/router';
import { type NotificationDto, NotificationType } from '@kloister/shared';
import { errorMessage } from '../../core/api';
import { notificationIcon, notificationText } from '../../core/notification-text';
import { NotificationsStore } from '../../core/notifications.store';
import { EmptyState, Skeleton } from '../../ui/feedback';
import { Icon } from '../../ui/icon';
import { ToastService } from '../../ui/toast.service';

/**
 * The notifications list (SPEC §6), opened from the bell: newest first, all
 * or unread only, each linking to its item. Opening one marks it read;
 * "Mark all as read" clears the bell's count. The API lists only the
 * caller's own notifications about items they can still see.
 */
@Component({
  selector: 'app-notifications-page',
  imports: [
    DatePipe,
    MatButtonModule,
    MatButtonToggleModule,
    RouterLink,
    EmptyState,
    Icon,
    Skeleton,
  ],
  template: `
    <div class="k-page">
      <header class="k-page-head">
        <h1>Notifications</h1>
        <span class="spacer"></span>
        <mat-button-toggle-group
          class="k-segmented"
          aria-label="Show"
          hideSingleSelectionIndicator
          [value]="unreadOnly() ? 'unread' : 'all'"
          (change)="show($event.value === 'unread')"
        >
          <mat-button-toggle value="all">All</mat-button-toggle>
          <mat-button-toggle value="unread">Unread</mat-button-toggle>
        </mat-button-toggle-group>
        <button mat-button type="button" [disabled]="store.unread() === 0" (click)="markAll()">
          <app-icon name="check" />Mark all as read
        </button>
      </header>
      @if (error()) {
        <p class="k-alert" role="alert">{{ error() }}</p>
      }
      @if (loading()) {
        <app-skeleton label="Loading notifications" [rows]="4" />
      } @else {
        <ul class="plain n-list" aria-label="Notifications">
          @for (n of rows(); track n.id) {
            <li class="n-row" [class.unread]="!n.readAt">
              <span class="n-icon" [class.danger]="n.type === overdue" aria-hidden="true">
                <app-icon [name]="icon(n)" [size]="16" />
              </span>
              <a
                class="n-link"
                [routerLink]="['/p', n.item.projectKey ?? 'personal', 'items', n.item.number]"
                (click)="opened(n)"
              >
                <span class="n-what">{{ text(n) }}</span>
                <span class="n-item"
                  ><span class="k-key">{{ n.item.key }}</span> {{ n.item.title }}</span
                >
                <span class="n-when">{{ n.createdAt | date: 'medium' }}</span>
              </a>
              @if (!n.readAt) {
                <span class="n-dot" title="Unread"
                  ><span class="visually-hidden">Unread</span></span
                >
                <button
                  type="button"
                  class="k-icon-btn sm"
                  [attr.aria-label]="'Mark ' + n.item.key + ' as read'"
                  (click)="markRead(n)"
                >
                  <app-icon name="check" />
                </button>
              }
            </li>
          } @empty {
            <li>
              <app-empty-state
                [title]="unreadOnly() ? 'No unread notifications' : 'You are all caught up'"
                text="You hear here when someone assigns or mentions you, changes your items, or something is due."
              />
            </li>
          }
        </ul>
        @if (cursor()) {
          <button mat-button type="button" (click)="more()">Show older notifications</button>
        }
      }
    </div>
  `,
})
export class NotificationsPage {
  /** The bell's count and the notification calls. */
  protected readonly store = inject(NotificationsStore);
  private readonly toast = inject(ToastService);

  /** The overdue type, for the template. */
  protected readonly overdue = NotificationType.OVERDUE;
  /** Loaded notifications, newest first. */
  protected readonly rows = signal<NotificationDto[]>([]);
  /** Cursor for older ones, or null. */
  protected readonly cursor = signal<string | null>(null);
  /** Only unread ones are shown. */
  protected readonly unreadOnly = signal(false);
  /** True until the first page arrives. */
  protected readonly loading = signal(true);
  /** Last load error, if any. */
  protected readonly error = signal('');
  /** Counts first-page loads, so stale answers are dropped. */
  private loadRun = 0;

  /** Loads the first page and refreshes the bell. */
  constructor() {
    void this.load(undefined);
    void this.store.refresh();
  }

  /**
   * What a notification says.
   *
   * @param n The notification.
   * @returns The text.
   */
  protected text(n: NotificationDto): string {
    return notificationText(n);
  }

  /**
   * A notification's icon.
   *
   * @param n The notification.
   * @returns The icon name.
   */
  protected icon(n: NotificationDto) {
    return notificationIcon(n.type);
  }

  /**
   * Switches between all and unread notifications.
   *
   * @param unreadOnly Only unread ones.
   * @returns Resolves once loaded.
   */
  protected show(unreadOnly: boolean): Promise<void> {
    this.unreadOnly.set(unreadOnly);
    return this.load(undefined);
  }

  /**
   * Loads older notifications.
   *
   * @returns Resolves once loaded.
   */
  protected more(): Promise<void> {
    return this.load(this.cursor() ?? undefined);
  }

  /**
   * Marks a notification read when its item is opened.
   *
   * @param n The notification.
   */
  protected opened(n: NotificationDto): void {
    if (n.readAt === null) void this.markRead(n);
  }

  /**
   * Marks one notification as read.
   *
   * @param n The notification.
   * @returns Resolves once marked.
   */
  protected async markRead(n: NotificationDto): Promise<void> {
    try {
      await this.store.markRead(n.id);
      const readAt = new Date().toISOString();
      this.rows.update((rows) => rows.map((r) => (r.id === n.id ? { ...r, readAt } : r)));
    } catch (error) {
      this.toast.error(error);
    }
  }

  /**
   * Marks every notification as read.
   *
   * @returns Resolves once marked.
   */
  protected async markAll(): Promise<void> {
    try {
      await this.store.markAllRead();
      const readAt = new Date().toISOString();
      this.rows.update((rows) => rows.map((r) => ({ ...r, readAt: r.readAt ?? readAt })));
      this.toast.show('All notifications marked as read');
    } catch (error) {
      this.toast.error(error);
    }
  }

  /**
   * Loads a page and appends it (or replaces the list for the first page).
   *
   * @param cursor Cursor, or undefined for the first page.
   * @returns Resolves once loaded.
   */
  private async load(cursor: string | undefined): Promise<void> {
    const run = cursor === undefined ? ++this.loadRun : this.loadRun;
    this.error.set('');
    try {
      const page = await this.store.list(this.unreadOnly(), cursor);
      if (run !== this.loadRun) return;
      this.rows.update((rows) => (cursor === undefined ? page.items : [...rows, ...page.items]));
      this.cursor.set(page.nextCursor);
    } catch (error) {
      if (run === this.loadRun) this.error.set(errorMessage(error));
    } finally {
      if (run === this.loadRun) this.loading.set(false);
    }
  }
}
