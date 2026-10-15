import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ProjectPermission as P, type WorkItemDetailDto } from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import {
  CurrentProject,
  ProjectAccessGuard,
  RequireProjectPermission,
} from '../projects/project-access.guard.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import { DuplicateDto } from './duplication.dto.js';
import { DuplicationService } from './duplication.service.js';

/** Same-space copies: no Viewer writes, hidden sources or archived-project changes. */
@Controller('projects/:id/items/:item/duplicate')
@UseGuards(ProjectAccessGuard)
export class DuplicationController {
  /**
   * Receives copy operations.
   * @param copies Atomic item/file duplication.
   */
  constructor(private readonly copies: DuplicationService) {}
  /**
   * Creates exactly the confirmed independent copies.
   * @param auth Caller.
   * @param access Guarded project access.
   * @param item Readable source.
   * @param body Previewed titles and options.
   * @returns New items with ordinary creation permissions.
   */
  @Post()
  @RequireProjectPermission(P.CREATE_ITEMS)
  create(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Body() body: DuplicateDto,
  ): Promise<WorkItemDetailDto[]> {
    return this.copies.duplicate(auth, access, item, body);
  }
}
