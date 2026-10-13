import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import {
  NOTIFICATION_POLL_MS,
  type NotificationDto,
  type Page,
  type UnreadCountDto,
} from '@kloister/shared';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from './api';

/**
 * The signed-in user's notifications (SPEC §6): the unread count shown on
 * the bell, polled every 60 seconds while someone is signed in, and the
 * calls of the notifications page. The API only ever returns the caller's
 * own notifications about items they can still see.
 */
@Injectable({ providedIn: 'root' })
export class NotificationsStore {
  private readonly http = inject(HttpClient);

  /** Unread notifications, as last counted. */
  readonly unread = signal(0);

  private timer: ReturnType<typeof setInterval> | undefined;

  /**
   * Starts polling the unread count (and counts at once). Calling it again
   * restarts the interval.
   */
  start(): void {
    this.stop();
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), NOTIFICATION_POLL_MS);
  }

  /** Stops polling and forgets the count, e.g. after signing out. */
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.unread.set(0);
  }

  /**
   * Counts unread notifications now. Failures keep the last count; the next
   * poll tries again.
   *
   * @returns Resolves once counted.
   */
  async refresh(): Promise<void> {
    try {
      const answer = await firstValueFrom(
        this.http.get<UnreadCountDto>(apiUrl('notifications/unread-count')),
      );
      this.unread.set(answer.count);
    } catch {
      // Keep the last known count until the next poll.
    }
  }

  /**
   * Lists one page of notifications, newest first.
   *
   * @param unreadOnly Only unread ones.
   * @param cursor Cursor from the previous page.
   * @returns One page.
   */
  list(unreadOnly: boolean, cursor?: string): Promise<Page<NotificationDto>> {
    let params = new HttpParams();
    if (unreadOnly) params = params.set('unread', 'true');
    if (cursor !== undefined) params = params.set('cursor', cursor);
    return firstValueFrom(
      this.http.get<Page<NotificationDto>>(apiUrl('notifications'), { params }),
    );
  }

  /**
   * Marks one notification as read and updates the count.
   *
   * @param id Notification id.
   * @returns Resolves once marked.
   */
  async markRead(id: string): Promise<void> {
    await firstValueFrom(this.http.post<void>(apiUrl(`notifications/${id}/read`), {}));
    await this.refresh();
  }

  /**
   * Marks every notification as read.
   *
   * @returns Resolves once marked.
   */
  async markAllRead(): Promise<void> {
    await firstValueFrom(this.http.post<void>(apiUrl('notifications/read-all'), {}));
    this.unread.set(0);
  }
}
