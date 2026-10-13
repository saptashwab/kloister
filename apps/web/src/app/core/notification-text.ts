import { type NotificationDto, NotificationType } from '@kloister/shared';
import type { IconName } from '../ui/icon';

/**
 * What a notification says (SPEC §6), without the item, which is shown next
 * to it.
 *
 * @param notification The notification.
 * @returns E.g. "Pat Manager assigned you".
 */
export function notificationText(notification: NotificationDto): string {
  const actor = notification.actor?.displayName ?? 'Someone';
  switch (notification.type) {
    case NotificationType.ASSIGNED:
      return `${actor} assigned you`;
    case NotificationType.MENTIONED:
      return `${actor} mentioned you`;
    case NotificationType.STATUS_CHANGED:
      return `${actor} changed the status of your item`;
    case NotificationType.DUE_TOMORROW:
      return 'Due tomorrow';
    case NotificationType.OVERDUE:
      return 'Overdue';
  }
}

/**
 * The icon of a notification type, so the type reads at a glance next to
 * its text.
 *
 * @param type The notification type.
 * @returns The icon name.
 */
export function notificationIcon(type: NotificationType): IconName {
  switch (type) {
    case NotificationType.ASSIGNED:
      return 'users';
    case NotificationType.MENTIONED:
      return 'at';
    case NotificationType.STATUS_CHANGED:
      return 'IN_PROGRESS';
    case NotificationType.DUE_TOMORROW:
    case NotificationType.OVERDUE:
      return 'calendar';
  }
}
