import { Body, Controller, Get, HttpCode, HttpStatus, Post, Res, UseGuards } from '@nestjs/common';
import {
  ProjectPermission as P,
  type RescheduleResultDto,
  type TimelineDto,
} from '@kloister/shared';
import type { FastifyReply } from 'fastify';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import {
  CurrentProject,
  ProjectAccessGuard,
  RequireProjectPermission,
} from '../projects/project-access.guard.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import { RescheduleDto } from './timeline.dto.js';
import { TimelineService } from './timeline.service.js';

/**
 * The project timeline under `/api/v1/projects/:id/timeline` (SPEC §6.4).
 *
 * Permissions: {@link ProjectAccessGuard} (non-members and personal spaces
 * 404, writes and previews refused on archived projects) plus the route
 * permission; the service applies the visibility scope and per-item rules.
 */
@Controller('projects/:id/timeline')
@UseGuards(ProjectAccessGuard)
export class TimelineController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param timeline Timeline operations.
   */
  constructor(private readonly timeline: TimelineService) {}

  /**
   * Lists the dependency links whose both ends the caller can see.
   * Permissions: any member and admin, within scope.
   *
   * @param access The caller's access.
   * @returns The links.
   */
  @Get()
  @RequireProjectPermission(P.VIEW_ITEMS)
  get(@CurrentProject() access: ProjectAccess): Promise<TimelineDto> {
    return this.timeline.timeline(access);
  }

  /**
   * Downloads the plan as a Microsoft Project XML file (v1.3.2), built from
   * what the caller can see: items on the timeline, links between them,
   * assignees and holidays. Project opens it with File > Open.
   * Permissions: any member and admin, within scope; archived projects too.
   *
   * @param access The caller's access.
   * @param reply The download response.
   * @returns The file.
   */
  @Get('msproject')
  @RequireProjectPermission(P.VIEW_ITEMS)
  async msProject(@CurrentProject() access: ProjectAccess, @Res() reply: FastifyReply) {
    const { fileName, xml } = await this.timeline.msProject(access);
    return reply
      .header('Content-Type', 'application/xml; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${fileName}"`)
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(xml);
  }

  /**
   * Previews or applies a date change with its dependent moves.
   * Permissions: `EDIT_ANY_ITEM` or `EDIT_OWN_ITEMS`; each requested item
   * must be visible (404) and its plan changeable by the caller (403,
   * ProjectAccessService.canPlanItem).
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param body The request.
   * @returns The plan and the changed items.
   */
  @Post('reschedule')
  @HttpCode(HttpStatus.OK)
  @RequireProjectPermission([P.EDIT_ANY_ITEM, P.EDIT_OWN_ITEMS])
  reschedule(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Body() body: RescheduleDto,
  ): Promise<RescheduleResultDto> {
    return this.timeline.reschedule(auth, access, body);
  }
}
