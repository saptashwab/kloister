import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { type HolidayDto, ProjectPermission as P, type ProjectHolidaysDto } from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { AdminOnly, CurrentAuth } from '../auth/decorators.js';
import {
  CurrentProject,
  ProjectAccessGuard,
  RequireProjectPermission,
} from '../projects/project-access.guard.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import { CreateHolidayDto, ReviewHolidaysDto } from './holidays.dto.js';
import { HolidaysService } from './holidays.service.js';

/**
 * A project's holidays under `/api/v1/projects/:id/holidays` (SPEC §6.4,
 * M9.1). Permissions: {@link ProjectAccessGuard} (non-members and personal
 * spaces 404, writes refused on archived projects); reading needs
 * `VIEW_ITEMS`, changes need `MANAGE_BOARD` (PMs and Leads).
 */
@Controller('projects/:id/holidays')
@UseGuards(ProjectAccessGuard)
export class ProjectHolidaysController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param holidays Holiday operations.
   */
  constructor(private readonly holidays: HolidaysService) {}

  /**
   * The project's calendar and the instance changes since the last review.
   *
   * @param access The caller's access.
   * @returns The holidays.
   */
  @Get()
  @RequireProjectPermission(P.VIEW_ITEMS)
  list(@CurrentProject() access: ProjectAccess): Promise<ProjectHolidaysDto> {
    return this.holidays.forProject(access);
  }

  /**
   * Adds a project holiday.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param body The holiday.
   * @returns The holiday (201).
   */
  @Post()
  @RequireProjectPermission(P.MANAGE_BOARD)
  add(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Body() body: CreateHolidayDto,
  ): Promise<HolidayDto> {
    return this.holidays.addToProject(auth, access, body);
  }

  /**
   * Records that instance holiday changes were reviewed.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param body The newest change the caller saw.
   * @returns Resolves once recorded (204).
   */
  @Post('reviewed')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission(P.MANAGE_BOARD)
  reviewed(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Body() body: ReviewHolidaysDto,
  ): Promise<void> {
    return this.holidays.markReviewed(auth, access, body.through);
  }

  /**
   * Removes a project holiday.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param holidayId Holiday id.
   * @returns Resolves once removed (204).
   */
  @Delete(':holidayId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission(P.MANAGE_BOARD)
  remove(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('holidayId', ParseUUIDPipe) holidayId: string,
  ): Promise<void> {
    return this.holidays.removeFromProject(auth, access, holidayId);
  }
}

/**
 * Instance-wide holidays under `/api/v1/admin/holidays` (SPEC §6.4, M9.1).
 * Permissions: system admins only. Changes never move project items.
 */
@Controller('admin/holidays')
@AdminOnly()
export class AdminHolidaysController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param holidays Holiday operations.
   */
  constructor(private readonly holidays: HolidaysService) {}

  /**
   * Lists the instance holidays.
   *
   * @returns Holidays, earliest first.
   */
  @Get()
  list(): Promise<HolidayDto[]> {
    return this.holidays.listInstance();
  }

  /**
   * Adds an instance holiday.
   *
   * @param auth The caller.
   * @param body The holiday.
   * @returns The holiday (201).
   */
  @Post()
  add(@CurrentAuth() auth: AuthContext, @Body() body: CreateHolidayDto): Promise<HolidayDto> {
    return this.holidays.addInstance(auth, body);
  }

  /**
   * Removes an instance holiday.
   *
   * @param auth The caller.
   * @param holidayId Holiday id.
   * @returns Resolves once removed (204).
   */
  @Delete(':holidayId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('holidayId', ParseUUIDPipe) holidayId: string,
  ): Promise<void> {
    return this.holidays.removeInstance(auth, holidayId);
  }
}
