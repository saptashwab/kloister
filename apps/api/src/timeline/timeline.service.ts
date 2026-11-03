import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  type HalfDay,
  PinAction,
  type PlanChange,
  type PlanItem,
  planSchedule,
  RescheduleMode,
  type RescheduleResultDto,
  sameDates,
  type ScheduleDates,
  type TimelineDto,
  type WorkItemDto,
} from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { conflict, forbidden, invalidField } from '../common/api-exception.js';
import { fromDbDate } from '../common/dates.js';
import { serializable } from '../common/transactions.js';
import type { Prisma } from '../generated/prisma/client.js';
import { itemFacts, type ItemRow, toItemRef } from '../items/item.mapper.js';
import { HolidaysService } from '../holidays/holidays.service.js';
import { ItemsService, PLAN_LEADS_ONLY } from '../items/items.service.js';
import { readableText } from '../items/snapshot-format.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type ProjectAccess, ProjectAccessService } from '../projects/project-access.service.js';
import { msProjectXml } from './msproject.js';
import type { RescheduleChangeDto, RescheduleDto } from './timeline.dto.js';

/**
 * The project timeline (SPEC §6.4, docs/M9-PLAN.md §4–5): the dependency
 * links the caller can see, and rescheduling with dependent items moved by
 * the shared planner.
 *
 * Authorization (SPEC §3.4): `ProjectAccessGuard` resolves the project
 * (personal spaces 404), checks the route permission and refuses writes,
 * the preview included, on archived projects. Every item query goes through
 * {@link ItemsService.scoped}, so the planner only ever sees items and links
 * whose both ends are visible: hidden items are never moved, listed, counted
 * or used as constraints. Requested items that are not visible are 404
 * before any version or plan check; visible ones the caller may not edit are
 * 403. Dependent items the caller may not edit stay where they are.
 */
@Injectable()
export class TimelineService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param items Item lookups, the visibility filter and item updates.
   * @param access Item permission rules.
   * @param holidays The project's working-day calendar (M9.1).
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly access: ProjectAccessService,
    private readonly holidays: HolidaysService,
  ) {}

  /**
   * Lists the "blocked by" links whose both ends the caller can see.
   *
   * Permissions: any member and admin (`VIEW_ITEMS`), within scope.
   *
   * @param access The caller's access.
   * @returns The links.
   */
  async timeline(access: ProjectAccess): Promise<TimelineDto> {
    const edges = await this.visibleEdges(this.prisma, access);
    return { edges };
  }

  /**
   * Builds a Microsoft Project XML file of the plan (v1.3.2): the items on the
   * timeline the caller can see (no ad-hoc items), the links whose both ends
   * they can see, assignees with their shares and the project's holidays.
   * Hidden ancestors appear as titles only, as on the timeline.
   *
   * @param access The caller's access.
   * @returns The file name and the XML.
   */
  async msProject(access: ProjectAccess): Promise<{ fileName: string; xml: string }> {
    const items: WorkItemDto[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.items.list(access, { cursor, limit: 100 });
      items.push(...page.items.filter((item) => !item.adHoc));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    const userIds = [...new Set(items.flatMap((item) => item.assigneeIds))];
    const people = new Map(
      (
        await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, displayName: true, email: true },
        })
      ).map((user) => [user.id, user]),
    );
    const { edges } = await this.timeline(access);
    const xml = msProjectXml({
      projectName: access.project.name,
      items: items.map((item) => ({
        id: item.id,
        number: item.number,
        outlinePosition: item.outlinePosition,
        key: item.key,
        title: item.title,
        type: item.type,
        status: item.status,
        ancestors: item.ancestors,
        description: readableText(item.description),
        checklist: item.checklist,
        pin: item.startNoEarlierThan,
        startDate: item.startDate,
        startSecondHalf: item.startSecondHalf,
        dueDate: item.dueDate,
        dueFirstHalf: item.dueFirstHalf,
        assignees: item.assigneeShares.flatMap(({ userId, share }) => {
          const person = people.get(userId);
          return person === undefined
            ? []
            : [{ userId, name: person.displayName, email: person.email, share }];
        }),
      })),
      edges,
      holidays: (await this.holidays.forProject(access)).holidays,
      today: new Date().toISOString().slice(0, 10),
      now: new Date(),
    });
    return { fileName: `${access.project.key}-plan.xml`, xml };
  }

  /**
   * Plans a date change and, unless previewing, applies it in one
   * serializable transaction: the requested items get their new dates and,
   * in `apply` mode, dependent items move as the planner decides. Each
   * changed item gets its ordinary audit entry, sharing a `rescheduleId`;
   * moved items also name the item that triggered the move.
   *
   * Permissions: `EDIT_ANY_ITEM` or `EDIT_OWN_ITEMS` (guard); every
   * requested item must be visible (404) and its plan changeable by the
   * caller (403, {@link ProjectAccessService.canPlanItem}); dependent items
   * move only where the caller could change them too.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param dto The request.
   * @returns The plan and, when applied, the changed items.
   */
  async reschedule(
    auth: AuthContext,
    access: ProjectAccess,
    dto: RescheduleDto,
  ): Promise<RescheduleResultDto> {
    return serializable(this.prisma, async (tx) => {
      // Resolve every reference first, so a hidden item answers 404 before
      // any version or plan check can hint that it exists.
      const requested: ItemRow[] = [];
      for (const change of dto.changes) {
        requested.push(await this.items.findVisible(tx, access, change.item));
      }
      for (const row of requested) {
        if (!this.access.canPlanItem(access, itemFacts(row))) throw forbidden(PLAN_LEADS_ONLY);
        if (row.adHoc) throw invalidField('changes', 'Ad-hoc items are not on the timeline');
      }

      // Ad-hoc items are not part of the plan (M12): they never move or block.
      const rows = await tx.workItem.findMany({
        where: this.items.scoped(access, { adHoc: false }),
        include: this.items.include(access),
      });
      const rowsById = new Map(rows.map((r) => [r.id, r]));
      const planItems = rows.map((r) => this.planItem(access, r));
      const edges = await this.visibleEdges(tx, access);
      const changes = dto.changes.map((c, i) => planChange(c, requested[i]));
      const calendar = await this.holidays.calendar(access, tx);
      let plan = planSchedule(planItems, edges, changes, calendar);
      if (dto.mode === RescheduleMode.ONLY) {
        // Only the requested items change; their own planned result stands
        // (a pin rule, a removed pin or a snap), but nothing else moves.
        plan = { changes: plan.changes.filter((c) => c.requested), kept: [] };
      }
      // An exact pin (Undo) replaces whatever the pin rule decided.
      dto.changes.forEach((c, i) => {
        if (c.pinTo === undefined) return;
        const row = requested[i];
        const planned = plan.changes.find((p) => p.id === row.id);
        const pinTo = c.pinTo === null ? null : { date: c.pinTo.date, second: c.pinTo.second };
        if (planned !== undefined) planned.pinTo = pinTo;
        else if (!samePin(pinOf(row), pinTo)) {
          const dates = datesOf(row);
          plan.changes.unshift({
            id: row.id,
            from: dates,
            to: dates,
            pinFrom: pinOf(row),
            pinTo,
            requested: true,
            snapped: false,
          });
        }
      });

      const changed = new Set(plan.changes.map((c) => c.id));
      for (const [id, version] of Object.entries(dto.expect ?? {})) {
        const row = rowsById.get(id);
        if (row !== undefined && row.updatedAt.toISOString() !== version) {
          throw conflict('Something on the timeline changed meanwhile; please review it again');
        }
      }
      if (dto.mode === RescheduleMode.APPLY && dto.previewed !== undefined) {
        const shown = new Map(dto.previewed.map((p) => [p.id, p.to]));
        const dependent = plan.changes.filter((c) => !c.requested);
        const same =
          dependent.length === shown.size &&
          dependent.every((c) => {
            const to = shown.get(c.id);
            return to !== undefined && sameDates(to, c.to);
          });
        if (!same) {
          throw conflict('The dependent moves changed meanwhile; please review them again');
        }
      }

      const key = access.project.key;
      const result: RescheduleResultDto = {
        changes: plan.changes.map((c) => {
          const row = rowsById.get(c.id)!;
          return {
            item: toItemRef(key, row),
            from: c.from,
            to: c.to,
            pinFrom: c.pinFrom,
            pinTo: c.pinTo,
            requested: c.requested,
            snapped: c.snapped,
            version: row.updatedAt.toISOString(),
          };
        }),
        kept: plan.kept.map((k) => ({
          item: toItemRef(key, rowsById.get(k.id)!),
          reason: k.reason,
        })),
        items: [],
        rescheduleId: null,
      };
      if (dto.mode === RescheduleMode.PREVIEW || changed.size === 0) return result;

      const rescheduleId = randomUUID();
      const trigger = requested[0].id;
      const updated: WorkItemDto[] = [];
      for (const change of plan.changes) {
        const auditMeta: Prisma.InputJsonObject = change.requested
          ? { rescheduleId }
          : { rescheduleId, rescheduleTriggerId: trigger };
        updated.push(
          await this.items.update(
            auth,
            access,
            change.id,
            {
              startDate: change.to.startDate,
              startSecondHalf: change.to.startSecondHalf,
              dueDate: change.to.dueDate,
              dueFirstHalf: change.to.dueFirstHalf,
            },
            tx,
            { pin: change.pinTo, auditMeta },
          ),
        );
      }
      return { ...result, items: updated, rescheduleId };
    });
  }

  /**
   * Converts an item row to the planner's view of it.
   *
   * @param access The caller's access.
   * @param row The item.
   * @returns The plan item.
   */
  private planItem(access: ProjectAccess, row: ItemRow): PlanItem {
    return {
      id: row.id,
      ...datesOf(row),
      status: row.status,
      pin: pinOf(row),
      editable: this.access.canPlanItem(access, itemFacts(row)),
    };
  }

  /**
   * Loads the links whose both ends the caller can see.
   *
   * @param db Database or transaction client.
   * @param access The caller's access.
   * @returns The links.
   */
  private async visibleEdges(
    db: Prisma.TransactionClient | PrismaService,
    access: ProjectAccess,
  ): Promise<{ blockingItemId: string; blockedItemId: string }[]> {
    return db.workItemDependency.findMany({
      where: {
        projectId: access.project.id,
        blockedItem: this.items.scoped(access, { adHoc: false }),
        blockingItem: this.items.scoped(access, { adHoc: false }),
      },
      select: { blockingItemId: true, blockedItemId: true },
      orderBy: [{ blockingItemId: 'asc' }, { blockedItemId: 'asc' }],
    });
  }
}

/**
 * The scheduling fields of an item row.
 *
 * @param row The item.
 * @returns Its dates.
 */
function datesOf(row: ItemRow): ScheduleDates {
  return {
    startDate: fromDbDate(row.startDate),
    startSecondHalf: row.startSecondHalf,
    dueDate: fromDbDate(row.dueDate),
    dueFirstHalf: row.dueFirstHalf,
  };
}

/**
 * The pin of an item row.
 *
 * @param row The item.
 * @returns The pin, or null.
 */
function pinOf(row: ItemRow): HalfDay | null {
  return row.startNoEarlierThan === null
    ? null
    : { date: fromDbDate(row.startNoEarlierThan)!, second: row.startNoEarlierThanSecondHalf };
}

/**
 * Reports whether two pins are equal.
 *
 * @param a First.
 * @param b Second.
 * @returns True when equal.
 */
function samePin(a: HalfDay | null, b: HalfDay | null): boolean {
  return a === b || (a !== null && b !== null && a.date === b.date && a.second === b.second);
}

/**
 * Turns a requested change into the planner's form, filling omitted date
 * fields from the item. A change naming no date field only reschedules the
 * item from its predecessors.
 *
 * @param change The request.
 * @param row The item.
 * @returns The plan change.
 */
function planChange(change: RescheduleChangeDto, row: ItemRow): PlanChange {
  const current = datesOf(row);
  const touchesDates =
    change.startDate !== undefined ||
    change.startSecondHalf !== undefined ||
    change.dueDate !== undefined ||
    change.dueFirstHalf !== undefined;
  const startDate = change.startDate === undefined ? current.startDate : change.startDate;
  const dueDate = change.dueDate === undefined ? current.dueDate : change.dueDate;
  const dates: ScheduleDates = {
    startDate,
    startSecondHalf: startDate !== null && (change.startSecondHalf ?? current.startSecondHalf),
    dueDate,
    dueFirstHalf: dueDate !== null && (change.dueFirstHalf ?? current.dueFirstHalf),
  };
  const pin = change.pinTo !== undefined ? PinAction.KEEP : (change.pin ?? PinAction.AUTO);
  return {
    id: row.id,
    ...(touchesDates ? { dates } : {}),
    pin,
  };
}
