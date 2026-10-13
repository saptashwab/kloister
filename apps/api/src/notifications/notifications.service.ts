import { Injectable } from '@nestjs/common';
import {
  ItemStatus,
  type NotificationDto,
  NotificationType,
  type Page,
  type UnreadCountDto,
} from '@kloister/shared';
import type { DbClient } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { notFound } from '../common/api-exception.js';
import { toDbDate } from '../common/dates.js';
import { pageArgs, toPage } from '../common/pagination.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type ItemFacts,
  type ProjectAccess,
  ProjectAccessService,
} from '../projects/project-access.service.js';
import { dueWindows } from './due-dates.js';
import type { NotificationsQueryDto } from './notifications.dto.js';

/** Something that happened to an item, and who should hear about it. */
export interface NotifyEvent {
  /** What happened. */
  type: NotificationType;
  /** Who did it; null for the daily due-date check. Never notified themselves. */
  actorId: string | null;
  /** The item's project. */
  projectId: string;
  /** The item's id. */
  itemId: string;
  /** The item as it is after the change, for the visibility check. */
  facts: ItemFacts;
  /** Candidate recipients. */
  recipients: readonly string[];
}

/** Relations each notification is listed with. */
const LIST_INCLUDE = {
  workItem: { select: { id: true, number: true, title: true, project: { select: { key: true } } } },
  actor: { select: { id: true, displayName: true } },
} as const satisfies Prisma.NotificationInclude;

/**
 * In-app notifications (SPEC §6): creating them when items change, the daily
 * due-date check, and the recipient's list, unread count and read marks.
 *
 * Visibility (SPEC §3.4): a notification is created only for active project
 * members who can see the item at that moment, and it is listed, counted and
 * markable only while the recipient can still see the item in an unarchived
 * project they belong to. Nobody learns about items outside their scope
 * through a notification.
 */
@Injectable()
export class NotificationsService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param access Visibility rules.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
  ) {}

  /**
   * Creates notifications for an event, inside the transaction of the change
   * that caused it. The actor, inactive accounts, non-members, archived
   * projects and recipients who cannot see the item are skipped.
   *
   * @param db Transaction client of the change.
   * @param event What happened and to whom.
   * @returns How many notifications were created.
   */
  async notify(db: DbClient, event: NotifyEvent): Promise<number> {
    const candidates = [...new Set(event.recipients)].filter((id) => id !== event.actorId);
    if (candidates.length === 0) return 0;
    const accesses = await this.access.accessesOf(db, event.projectId, candidates);
    const recipients = candidates.filter((userId) => {
      const access = accesses.get(userId);
      return (
        access !== undefined &&
        access.project.archivedAt === null &&
        this.access.canViewItem(access, event.facts)
      );
    });
    if (recipients.length === 0) return 0;
    await db.notification.createMany({
      data: recipients.map((userId) => ({
        userId,
        type: event.type,
        workItemId: event.itemId,
        actorId: event.actorId,
      })),
    });
    return recipients.length;
  }

  /**
   * The daily due-date check (SPEC §6, 09:00 server time): "due tomorrow" for
   * open items due tomorrow, and "overdue" once for open items whose due date
   * passed within the last week. Assignees are notified, or the creator of an
   * item nobody is assigned to. Running it twice on a day adds nothing.
   *
   * @param now When the check runs.
   * @returns How many notifications were created.
   */
  async checkDueDates(now: Date): Promise<number> {
    const windows = dueWindows(now);
    const tomorrow = toDbDate(windows.tomorrow);
    const items = await this.prisma.workItem.findMany({
      where: {
        status: { not: ItemStatus.DONE },
        project: { archivedAt: null },
        OR: [
          { dueDate: tomorrow },
          {
            dueDate: { gte: toDbDate(windows.overdueFrom), lte: toDbDate(windows.overdueTo) },
          },
        ],
      },
      select: {
        id: true,
        projectId: true,
        createdById: true,
        bucketId: true,
        teamId: true,
        dueDate: true,
        assignees: { select: { userId: true } },
      },
    });
    let created = 0;
    for (const item of items) {
      const dueDate = item.dueDate ?? tomorrow;
      const type =
        dueDate.getTime() === tomorrow.getTime()
          ? NotificationType.DUE_TOMORROW
          : NotificationType.OVERDUE;
      const assigneeIds = item.assignees.map((a) => a.userId);
      const recipients = assigneeIds.length > 0 ? assigneeIds : [item.createdById];
      // "Due tomorrow" once a day; "overdue" once per due date.
      const since = type === NotificationType.DUE_TOMORROW ? windows.startOfToday : dueDate;
      const already = await this.prisma.notification.findMany({
        where: { workItemId: item.id, type, userId: { in: recipients }, createdAt: { gte: since } },
        select: { userId: true },
      });
      const notified = new Set(already.map((n) => n.userId));
      created += await this.notify(this.prisma, {
        type,
        actorId: null,
        projectId: item.projectId,
        itemId: item.id,
        facts: {
          createdById: item.createdById,
          assigneeIds,
          bucketId: item.bucketId,
          teamId: item.teamId,
          hasChildren: false,
        },
        recipients: recipients.filter((id) => !notified.has(id)),
      });
    }
    return created;
  }

  /**
   * Lists the caller's notifications, newest first.
   *
   * Permissions: own notifications only, and only those about items the
   * caller can still see in unarchived projects they belong to.
   *
   * @param auth The caller.
   * @param query Pagination and the unread filter.
   * @returns One page of notifications.
   */
  async list(auth: AuthContext, query: NotificationsQueryDto): Promise<Page<NotificationDto>> {
    const where = await this.visible(auth, query.unread === true ? { readAt: null } : {});
    if (query.cursor !== undefined) {
      // An unknown or hidden cursor gives an empty page rather than a position.
      const cursor = await this.prisma.notification.count({
        where: { AND: [where, { id: query.cursor }] },
      });
      if (cursor === 0) return { items: [], nextCursor: null };
    }
    const rows = await this.prisma.notification.findMany({
      where,
      include: LIST_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...pageArgs(query),
    });
    return toPage(rows, query, toNotificationDto);
  }

  /**
   * Counts the caller's unread notifications (polled every 60 s by the bell).
   *
   * Permissions: as {@link list}.
   *
   * @param auth The caller.
   * @returns The count.
   */
  async unreadCount(auth: AuthContext): Promise<UnreadCountDto> {
    return {
      count: await this.prisma.notification.count({
        where: await this.visible(auth, { readAt: null }),
      }),
    };
  }

  /**
   * Marks one notification as read.
   *
   * Permissions: as {@link list}; anyone else's notification, or one about an
   * item the caller can no longer see, is 404.
   *
   * @param auth The caller.
   * @param id Notification id.
   * @returns Resolves once marked.
   */
  async markRead(auth: AuthContext, id: string): Promise<void> {
    const where = await this.visible(auth, { id });
    const row = await this.prisma.notification.findFirst({ where, select: { readAt: true } });
    if (row === null) throw notFound('Notification');
    if (row.readAt === null) {
      await this.prisma.notification.updateMany({
        where: { id, userId: auth.user.id, readAt: null },
        data: { readAt: new Date() },
      });
    }
  }

  /**
   * Marks all of the caller's notifications as read.
   *
   * Permissions: own notifications only.
   *
   * @param auth The caller.
   * @returns Resolves once marked.
   */
  async markAllRead(auth: AuthContext): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId: auth.user.id, readAt: null },
      data: { readAt: new Date() },
    });
  }

  /**
   * The condition for the caller's notifications about items they can see:
   * each project they belong to (unarchived) with their scope there.
   *
   * @param auth The caller.
   * @param where Further conditions.
   * @returns The combined condition; matches nothing without memberships.
   */
  private async visible(
    auth: AuthContext,
    where: Prisma.NotificationWhereInput,
  ): Promise<Prisma.NotificationWhereInput> {
    const accesses = await this.access.memberAccesses(auth);
    return {
      AND: [
        { userId: auth.user.id },
        { workItem: { is: { OR: accesses.map((a) => this.scope(a)) } } },
        where,
      ],
    };
  }

  /**
   * One project's part of the visibility condition.
   *
   * @param access The caller's access to the project.
   * @returns The item condition.
   */
  private scope(access: ProjectAccess): Prisma.WorkItemWhereInput {
    return { AND: [{ projectId: access.project.id }, this.access.itemScopeFilter(access)] };
  }
}

/**
 * Converts a listed notification to its API shape.
 *
 * @param row The notification with {@link LIST_INCLUDE}.
 * @returns The DTO.
 */
function toNotificationDto(
  row: Prisma.NotificationGetPayload<{ include: typeof LIST_INCLUDE }>,
): NotificationDto {
  const item = row.workItem;
  return {
    id: row.id,
    type: row.type,
    item: {
      id: item.id,
      number: item.number,
      key: `${item.project.key}-${item.number}`,
      title: item.title,
      projectKey: item.project.key,
    },
    actor: row.actor === null ? null : { id: row.actor.id, displayName: row.actor.displayName },
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
}
