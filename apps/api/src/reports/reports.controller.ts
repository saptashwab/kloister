import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  type MyCalendarDto,
  type OverviewReportDto,
  type PlanHealthReportDto,
  ProjectPermission as P,
  type SprintReportDto,
  type WorkloadReportDto,
} from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import {
  CurrentProject,
  ProjectAccessGuard,
  RequireProjectPermission,
} from '../projects/project-access.guard.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import { CalendarService } from './calendar.service.js';
import { CalendarQueryDto, SprintReportQueryDto, WorkloadQueryDto } from './reports.dto.js';
import { ReportsService } from './reports.service.js';

/**
 * Project reports under `/api/v1/projects/:id/reports` (SPEC §6.5, M13).
 *
 * Permissions: {@link ProjectAccessGuard} (non-members 404; personal spaces
 * have Overview and Workload only, the others 404) plus `VIEW_ITEMS`, so
 * every member, Viewers included, sees the reports with their own visibility
 * applied by {@link ReportsService}.
 */
@Controller('projects/:id/reports')
@UseGuards(ProjectAccessGuard)
export class ReportsController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param reports Report calculations.
   */
  constructor(private readonly reports: ReportsService) {}

  /**
   * Counts the visible items by status, due date and bucket.
   * Permissions: any member and admin (`VIEW_ITEMS`), visible items only.
   *
   * @param access The caller's access.
   * @returns The overview.
   */
  @Get('overview')
  @RequireProjectPermission(P.VIEW_ITEMS)
  overview(@CurrentProject() access: ProjectAccess): Promise<OverviewReportDto> {
    return this.reports.overview(access);
  }

  /**
   * Reports on the active (or a chosen) sprint from visible items and their history.
   * Permissions: any member and admin (`VIEW_ITEMS`), visible items only; personal spaces 404.
   *
   * @param access The caller's access.
   * @param query The sprint.
   * @returns The sprint report.
   */
  @Get('sprint')
  @RequireProjectPermission(P.VIEW_ITEMS)
  sprint(
    @CurrentProject() access: ProjectAccess,
    @Query() query: SprintReportQueryDto,
  ): Promise<SprintReportDto> {
    return this.reports.sprint(access, query);
  }

  /**
   * Spreads visible planned work over people and weeks, by assignee share.
   * Permissions: any member and admin (`VIEW_ITEMS`), visible items only.
   *
   * @param access The caller's access.
   * @param query The first week and the number of weeks.
   * @returns The workload.
   */
  @Get('workload')
  @RequireProjectPermission(P.VIEW_ITEMS)
  workload(
    @CurrentProject() access: ProjectAccess,
    @Query() query: WorkloadQueryDto,
  ): Promise<WorkloadReportDto> {
    return this.reports.workload(access, query);
  }

  /**
   * Lists past-due items, timeline conflicts, undated sprint work and late pins.
   * Permissions: any member and admin (`VIEW_ITEMS`), visible items and links only; personal spaces 404.
   *
   * @param access The caller's access.
   * @returns The plan health lists.
   */
  @Get('plan-health')
  @RequireProjectPermission(P.VIEW_ITEMS)
  planHealth(@CurrentProject() access: ProjectAccess): Promise<PlanHealthReportDto> {
    return this.reports.planHealth(access);
  }
}

/**
 * The signed-in user's calendar under `/api/v1/me/calendar` (SPEC §6.5, M13).
 *
 * Permissions: any signed-in user; their own items in their projects and
 * personal space only, within their visibility (see {@link CalendarService}).
 */
@Controller('me/calendar')
export class CalendarController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param calendar The calendar reader.
   */
  constructor(private readonly calendar: CalendarService) {}

  /**
   * Lists the caller's items and holidays in a date range of at most 100 days.
   * Permissions: any signed-in user; own visible items only.
   *
   * @param auth The caller.
   * @param query The range.
   * @returns The calendar.
   */
  @Get()
  mine(@CurrentAuth() auth: AuthContext, @Query() query: CalendarQueryDto): Promise<MyCalendarDto> {
    return this.calendar.mine(auth, query.from, query.to);
  }
}
