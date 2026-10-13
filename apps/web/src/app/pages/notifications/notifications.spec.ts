import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NOTIFICATION_POLL_MS, type NotificationDto } from '@kloister/shared';
import { settle } from '../../../testing/fixtures';
import { notificationIcon, notificationText } from '../../core/notification-text';
import { NotificationsStore } from '../../core/notifications.store';
import { ToastService } from '../../ui/toast.service';
import { NotificationsPage } from './notifications';

/**
 * Builds a notification as the API returns it.
 *
 * @param id Notification id.
 * @param type Notification type.
 * @param readAt When read, or null.
 * @returns The notification.
 */
function notification(
  id: string,
  type: NotificationDto['type'],
  readAt: string | null = null,
): NotificationDto {
  return {
    id,
    type,
    item: { id: 'i4', number: 4, key: 'KLO-4', title: 'Invoice form', projectKey: 'KLO' },
    actor: type === 'DUE_TOMORROW' || type === 'OVERDUE' ? null : { id: 'u1', displayName: 'Pat' },
    createdAt: '2026-10-13T08:00:00.000Z',
    readAt,
  };
}

describe('notificationText', () => {
  it('names the actor and what happened', () => {
    expect(notificationText(notification('1', 'ASSIGNED'))).toBe('Pat assigned you');
    expect(notificationText(notification('1', 'MENTIONED'))).toBe('Pat mentioned you');
    expect(notificationText(notification('1', 'STATUS_CHANGED'))).toBe(
      'Pat changed the status of your item',
    );
    expect(notificationText(notification('1', 'DUE_TOMORROW'))).toBe('Due tomorrow');
    expect(notificationText(notification('1', 'OVERDUE'))).toBe('Overdue');
    expect(notificationText({ ...notification('1', 'ASSIGNED'), actor: null })).toBe(
      'Someone assigned you',
    );
    expect(notificationIcon('MENTIONED')).toBe('at');
  });
});

describe('NotificationsStore', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls the unread count every 60 seconds until stopped', async () => {
    vi.useFakeTimers();
    const store = TestBed.inject(NotificationsStore);
    const http = TestBed.inject(HttpTestingController);
    store.start();
    http.expectOne('api/v1/notifications/unread-count').flush({ count: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.unread()).toBe(3);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS);
    http.expectOne('api/v1/notifications/unread-count').flush({ count: 5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.unread()).toBe(5);
    store.stop();
    expect(store.unread()).toBe(0);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS * 2);
    http.expectNone('api/v1/notifications/unread-count');
  });

  it('keeps the last count when a poll fails', async () => {
    const store = TestBed.inject(NotificationsStore);
    const http = TestBed.inject(HttpTestingController);
    store.unread.set(2);
    const done = store.refresh();
    http
      .expectOne('api/v1/notifications/unread-count')
      .flush(null, { status: 500, statusText: 'x' });
    await done;
    expect(store.unread()).toBe(2);
  });
});

describe('NotificationsPage', () => {
  async function render(rows: NotificationDto[]) {
    const store = {
      unread: vi.fn().mockReturnValue(rows.filter((r) => r.readAt === null).length),
      list: vi.fn().mockResolvedValue({ items: rows, nextCursor: null }),
      refresh: vi.fn().mockResolvedValue(undefined),
      markRead: vi.fn().mockResolvedValue(undefined),
      markAllRead: vi.fn().mockResolvedValue(undefined),
    };
    await TestBed.configureTestingModule({
      imports: [NotificationsPage],
      providers: [provideRouter([]), { provide: NotificationsStore, useValue: store }],
    }).compileComponents();
    vi.spyOn(TestBed.inject(ToastService), 'show').mockImplementation(() => undefined);
    const fixture = TestBed.createComponent(NotificationsPage);
    await settle(fixture);
    return { store, fixture, root: fixture.nativeElement as HTMLElement };
  }

  it('lists notifications linking to their items, unread ones marked', async () => {
    const { root, store } = await render([
      notification('n1', 'MENTIONED'),
      notification('n2', 'OVERDUE', '2026-10-13T09:00:00.000Z'),
    ]);
    expect(store.list).toHaveBeenCalledWith(false, undefined);
    const rows = [...root.querySelectorAll('.n-row')];
    expect(rows.map((r) => r.classList.contains('unread'))).toEqual([true, false]);
    expect(rows[0]?.textContent).toContain('Pat mentioned you');
    expect(rows[0]?.textContent).toContain('KLO-4');
    expect(rows[0]?.querySelector('a')?.getAttribute('href')).toBe('/p/KLO/items/4');
    expect(rows[1]?.querySelector('.n-icon')?.classList.contains('danger')).toBe(true);
  });

  it('marks one or all as read', async () => {
    const { root, store, fixture } = await render([notification('n1', 'ASSIGNED')]);
    root.querySelector<HTMLButtonElement>('[aria-label="Mark KLO-4 as read"]')?.click();
    await settle(fixture);
    expect(store.markRead).toHaveBeenCalledWith('n1');
    expect(root.querySelector('.n-row.unread')).toBeNull();
    const all = [...root.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Mark all'),
    );
    all?.click();
    await settle(fixture);
    expect(store.markAllRead).toHaveBeenCalled();
  });

  it('says so when there is nothing to show', async () => {
    const { root } = await render([]);
    expect(root.textContent).toContain('You are all caught up');
  });
});
