import { Injectable } from '@nestjs/common';
import {
  AuditAction,
  HOLIDAY_MAX_DAYS,
  type HolidayDto,
  type ProjectHolidaysDto,
  type WorkCalendar,
  workCalendar,
} from '@kloister/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { invalidField, notFound } from '../common/api-exception.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import type { Holiday, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { mergeProjectSettings } from '../projects/project-settings.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import type { CreateHolidayDto } from './holidays.dto.js';

/** A database client or transaction. */
type Db = PrismaService | Prisma.TransactionClient;

/**
 * Whole-day holidays (SPEC §6.4, docs/M9-PLAN.md §14): instance-wide ones
 * managed by admins and project ones managed by PMs and Leads. A project's
 * calendar is its own holidays plus, unless switched off, the instance ones.
 *
 * Removing a holiday sets `deletedAt`, so a project can see which instance
 * holidays changed since its PMs or Leads last reviewed them. Admin changes
 * never touch project items: admins gain no reach into projects. Every
 * change is audited.
 */
@Injectable()
export class HolidaysService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param audit Audit log.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The working-day calendar of a project, for the planner and exports.
   *
   * @param access The caller's access to the project.
   * @param db Database or transaction client.
   * @returns The calendar.
   */
  async calendar(access: ProjectAccess, db: Db = this.prisma): Promise<WorkCalendar> {
    return workCalendar((await this.active(access, db)).map(toRange));
  }

  /**
   * The project's holidays and the instance changes since the last review.
   *
   * Permissions: any member and admin (`VIEW_ITEMS`, guard).
   *
   * @param access The caller's access.
   * @returns The holidays.
   */
  async forProject(access: ProjectAccess): Promise<ProjectHolidaysDto> {
    const holidays = (await this.active(access, this.prisma)).map(toDto);
    const { useInstanceHolidays, holidaysReviewedAt } = access.settings;
    let instanceChanges: HolidayDto[] = [];
    if (useInstanceHolidays) {
      // Projects that never reviewed compare with their creation: items
      // planned before an instance holiday was added are the ones affected.
      const since = new Date(holidaysReviewedAt ?? access.project.createdAt);
      const rows = await this.prisma.holiday.findMany({
        where: {
          projectId: null,
          OR: [{ createdAt: { gt: since } }, { deletedAt: { gt: since } }],
        },
        orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
      });
      // Added and removed again since the review: nothing changed.
      instanceChanges = rows
        .filter((h) => !(h.createdAt > since && h.deletedAt !== null))
        .map(toDto);
    }
    return { holidays, useInstanceHolidays, instanceChanges };
  }

  /**
   * Adds a project holiday.
   *
   * Permissions: `MANAGE_BOARD` (guard); personal spaces 404 (guard).
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param dto The holiday.
   * @returns The holiday.
   */
  async addToProject(
    auth: AuthContext,
    access: ProjectAccess,
    dto: CreateHolidayDto,
  ): Promise<HolidayDto> {
    return toDto(await this.add(auth, access.project.id, dto));
  }

  /**
   * Removes a project holiday.
   *
   * Permissions: `MANAGE_BOARD` (guard); instance holidays and holidays of
   * other projects are 404.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param id Holiday id.
   * @returns Resolves once removed.
   */
  async removeFromProject(auth: AuthContext, access: ProjectAccess, id: string): Promise<void> {
    await this.remove(auth, access.project.id, id);
  }

  /**
   * Records that the project's PMs or Leads reviewed the instance holiday
   * changes (they kept durations or kept dates), so the notice ends.
   *
   * Permissions: `MANAGE_BOARD` (guard).
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param through The newest change the caller saw; later changes stay
   *   unreviewed. Defaults to now on the database clock.
   * @returns Resolves once recorded.
   */
  async markReviewed(auth: AuthContext, access: ProjectAccess, through?: string): Promise<void> {
    const id = access.project.id;
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.project.findUniqueOrThrow({ where: { id } });
      const now = await databaseNow(tx);
      const seen = through === undefined ? now : new Date(through);
      // Never later than now, so a client cannot hide changes still to come.
      const reviewedAt = (seen > now ? now : seen).toISOString();
      await tx.project.update({
        where: { id },
        data: {
          settings: mergeProjectSettings(current.settings, { holidaysReviewedAt: reviewedAt }),
        },
      });
      await this.audit.record(
        {
          actorId: auth.user.id,
          action: AuditAction.HOLIDAYS_REVIEWED,
          entityType: 'Project',
          entityId: id,
          projectId: id,
          meta: { reviewedAt },
        },
        tx,
      );
    });
  }

  /**
   * Lists the instance holidays.
   *
   * Permissions: admins (guard).
   *
   * @returns Active instance holidays.
   */
  async listInstance(): Promise<HolidayDto[]> {
    const rows = await this.prisma.holiday.findMany({
      where: { projectId: null, deletedAt: null },
      orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toDto);
  }

  /**
   * Adds an instance holiday. No project item moves (docs/M9-PLAN.md §14).
   *
   * Permissions: admins (guard).
   *
   * @param auth The caller.
   * @param dto The holiday.
   * @returns The holiday.
   */
  async addInstance(auth: AuthContext, dto: CreateHolidayDto): Promise<HolidayDto> {
    return toDto(await this.add(auth, null, dto));
  }

  /**
   * Removes an instance holiday. No project item moves.
   *
   * Permissions: admins (guard); project holidays are 404.
   *
   * @param auth The caller.
   * @param id Holiday id.
   * @returns Resolves once removed.
   */
  async removeInstance(auth: AuthContext, id: string): Promise<void> {
    await this.remove(auth, null, id);
  }

  /**
   * The active holidays of a project's calendar.
   *
   * @param access The caller's access.
   * @param db Database or transaction client.
   * @returns Holidays, earliest first.
   */
  private active(access: ProjectAccess, db: Db): Promise<Holiday[]> {
    return db.holiday.findMany({
      where: {
        deletedAt: null,
        OR: [
          { projectId: access.project.id },
          ...(access.settings.useInstanceHolidays ? [{ projectId: null }] : []),
        ],
      },
      orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Creates a holiday and audits it.
   *
   * @param auth The caller.
   * @param projectId Project, or null for the instance.
   * @param dto The holiday.
   * @returns The row.
   */
  private async add(
    auth: AuthContext,
    projectId: string | null,
    dto: CreateHolidayDto,
  ): Promise<Holiday> {
    if (dto.endDate < dto.startDate) {
      throw invalidField('endDate', 'The last day is before the first');
    }
    const days =
      (Date.parse(`${dto.endDate}T00:00:00Z`) - Date.parse(`${dto.startDate}T00:00:00Z`)) /
        86_400_000 +
      1;
    if (days > HOLIDAY_MAX_DAYS) {
      throw invalidField('endDate', `A holiday can last at most ${HOLIDAY_MAX_DAYS} days`);
    }
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.holiday.create({
        data: {
          projectId,
          name: dto.name,
          startDate: toDbDate(dto.startDate),
          endDate: toDbDate(dto.endDate),
          createdById: auth.user.id,
        },
      });
      await this.audit.record(
        {
          actorId: auth.user.id,
          action: AuditAction.HOLIDAY_ADDED,
          entityType: 'Holiday',
          entityId: row.id,
          projectId,
          meta: { name: row.name, startDate: dto.startDate, endDate: dto.endDate },
        },
        tx,
      );
      return row;
    });
  }

  /**
   * Removes a holiday of a project or of the instance and audits it.
   *
   * @param auth The caller.
   * @param projectId Project, or null for the instance.
   * @param id Holiday id.
   * @returns Resolves once removed.
   */
  private async remove(auth: AuthContext, projectId: string | null, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.holiday.findFirst({ where: { id, projectId, deletedAt: null } });
      if (row === null) throw notFound('Holiday');
      await tx.holiday.update({ where: { id }, data: { deletedAt: await databaseNow(tx) } });
      await this.audit.record(
        {
          actorId: auth.user.id,
          action: AuditAction.HOLIDAY_REMOVED,
          entityType: 'Holiday',
          entityId: id,
          projectId,
          meta: {
            name: row.name,
            startDate: fromDbDate(row.startDate),
            endDate: fromDbDate(row.endDate),
          },
        },
        tx,
      );
    });
  }
}

/**
 * The database clock, which also sets `createdAt`, so holiday changes and
 * reviews compare on one clock.
 *
 * @param db Database or transaction client.
 * @returns The current time.
 */
export async function databaseNow(db: Db): Promise<Date> {
  const [row] = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`;
  return row?.now ?? new Date();
}

/**
 * A holiday's date range.
 *
 * @param row The holiday.
 * @returns First and last day.
 */
function toRange(row: Holiday): { startDate: string; endDate: string } {
  return { startDate: fromDbDate(row.startDate)!, endDate: fromDbDate(row.endDate)! };
}

/**
 * Converts a holiday to its API shape.
 *
 * @param row The holiday.
 * @returns The DTO.
 */
function toDto(row: Holiday): HolidayDto {
  return {
    id: row.id,
    name: row.name,
    ...toRange(row),
    scope: row.projectId === null ? 'INSTANCE' : 'PROJECT',
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}
