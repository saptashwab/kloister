import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import type { NotificationDto, Page, UnreadCountDto } from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { NotificationsQueryDto } from './notifications.dto.js';
import { NotificationsService } from './notifications.service.js';

/**
 * The signed-in user's in-app notifications under `/api/v1/notifications`
 * (SPEC §6, §8 `notifications`).
 *
 * Permissions: any signed-in user, for their own notifications only, and
 * only about items they can still see (see {@link NotificationsService}).
 * Anyone else's notification is 404.
 */
@Controller('notifications')
export class NotificationsController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param notifications Notification operations.
   */
  constructor(private readonly notifications: NotificationsService) {}

  /**
   * Lists the caller's notifications, newest first.
   *
   * @param auth The caller.
   * @param query Pagination and `unread=true`.
   * @returns One page of notifications.
   */
  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query() query: NotificationsQueryDto,
  ): Promise<Page<NotificationDto>> {
    return this.notifications.list(auth, query);
  }

  /**
   * Counts the caller's unread notifications, for the bell.
   *
   * @param auth The caller.
   * @returns The count.
   */
  @Get('unread-count')
  unreadCount(@CurrentAuth() auth: AuthContext): Promise<UnreadCountDto> {
    return this.notifications.unreadCount(auth);
  }

  /**
   * Marks all the caller's notifications as read.
   *
   * @param auth The caller.
   * @returns Resolves once marked (204).
   */
  @Post('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  markAllRead(@CurrentAuth() auth: AuthContext): Promise<void> {
    return this.notifications.markAllRead(auth);
  }

  /**
   * Marks one of the caller's notifications as read.
   *
   * @param auth The caller.
   * @param notificationId Notification id.
   * @returns Resolves once marked (204).
   */
  @Post(':notificationId/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  markRead(
    @CurrentAuth() auth: AuthContext,
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
  ): Promise<void> {
    return this.notifications.markRead(auth, notificationId);
  }
}
