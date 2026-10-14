import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import type { UserWorkDto } from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { WorkQueryDto } from './work.dto.js';
import { WorkService } from './work.service.js';

/**
 * A person's work across projects under `/api/v1/users/:userId/work`
 * (SPEC §6 "View all their work").
 *
 * Permissions: any signed-in user. Items are limited to the caller's
 * projects and their visibility scope in each; people the caller shares no
 * project with are 404 (admins may look up anyone). See {@link WorkService}.
 */
@Controller()
export class WorkController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param work The cross-project list.
   */
  constructor(private readonly work: WorkService) {}

  /**
   * Lists assigned/created project work and the caller's personal tasks.
   * @param auth The caller.
   * @param query Filters and pagination.
   * @returns The caller and permitted work.
   */
  @Get('me/work')
  mine(@CurrentAuth() auth: AuthContext, @Query() query: WorkQueryDto): Promise<UserWorkDto> {
    return this.work.listForUser(auth, auth.user.id, query);
  }

  /**
   * Lists the open items (or all, with `includeDone=true`) assigned to a
   * person that the caller can see.
   *
   * @param auth The caller.
   * @param userId The person.
   * @param query Pagination and filters.
   * @returns The person and one page of their items.
   */
  @Get('users/:userId/work')
  list(
    @CurrentAuth() auth: AuthContext,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: WorkQueryDto,
  ): Promise<UserWorkDto> {
    return this.work.listForUser(auth, userId, query);
  }
}
