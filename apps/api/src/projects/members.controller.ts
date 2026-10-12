import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  type MemberCandidateDto,
  type Page,
  ProjectPermission,
  type ProjectMemberDto,
} from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { PageQueryDto } from '../common/pagination.js';
import { MembersService } from './members.service.js';
import {
  CurrentProject,
  ProjectAccessGuard,
  RequireProjectPermission,
} from './project-access.guard.js';
import type { ProjectAccess } from './project-access.service.js';
import { AddMemberDto, MemberCandidatesQueryDto, UpdateMemberDto } from './projects.dto.js';

/**
 * Membership changes are open to PMs (`MANAGE_MEMBERS`) and, limited to the
 * PM role, to system admins (`ASSIGN_PMS`, SPEC §3.1).
 */
const MEMBER_CHANGE = [ProjectPermission.MANAGE_MEMBERS, ProjectPermission.ASSIGN_PMS] as const;

/**
 * Membership routes under `/api/v1/projects/:id/members` (SPEC §8), plus the
 * candidate search used to add members.
 *
 * Permissions: every route goes through {@link ProjectAccessGuard}. Any
 * member may list members; PMs manage them (SPEC §3.2); system admins may
 * grant and take away the PM role in any project, archived ones included
 * (SPEC §3.1).
 */
@Controller('projects/:id')
@UseGuards(ProjectAccessGuard)
export class MembersController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param members Membership operations.
   */
  constructor(private readonly members: MembersService) {}

  /**
   * Lists members. Permissions: any member; any admin (audited if not a member).
   *
   * @param access The caller's access.
   * @param query Pagination.
   * @returns One page of members, oldest first.
   */
  @Get('members')
  @RequireProjectPermission(ProjectPermission.VIEW_ITEMS)
  list(
    @CurrentProject() access: ProjectAccess,
    @Query() query: PageQueryDto,
  ): Promise<Page<ProjectMemberDto>> {
    return this.members.list(access, query);
  }

  /**
   * Searches active users who are not members yet. Permissions: PMs and admins.
   *
   * @param access The caller's access.
   * @param query Search text.
   * @returns Up to 20 users.
   */
  @Get('member-candidates')
  @RequireProjectPermission(MEMBER_CHANGE, { allowArchivedForPmAssignment: true })
  candidates(
    @CurrentProject() access: ProjectAccess,
    @Query() query: MemberCandidatesQueryDto,
  ): Promise<MemberCandidateDto[]> {
    return this.members.candidates(access, query);
  }

  /**
   * Adds a member. Permissions: PMs; admins only with role PM.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param body User, role and visibility.
   * @returns The new member (201).
   */
  @Post('members')
  @RequireProjectPermission(MEMBER_CHANGE, { allowArchivedForPmAssignment: true })
  add(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Body() body: AddMemberDto,
  ): Promise<ProjectMemberDto> {
    return this.members.add(auth, access, body);
  }

  /**
   * Changes a member's role or visibility. Permissions: PMs; admins only to
   * promote to or demote from PM. The last active PM cannot be demoted.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param userId The member's user id.
   * @param body Fields to change.
   * @returns The updated member.
   */
  @Patch('members/:userId')
  @RequireProjectPermission(MEMBER_CHANGE, { allowArchivedForPmAssignment: true })
  update(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: UpdateMemberDto,
  ): Promise<ProjectMemberDto> {
    return this.members.update(auth, access, userId, body);
  }

  /**
   * Removes a member. Permissions: PMs; admins only PMs. The last active PM
   * cannot be removed.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param userId The member's user id.
   * @returns Resolves once removed (204).
   */
  @Delete('members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission(MEMBER_CHANGE, { allowArchivedForPmAssignment: true })
  remove(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    return this.members.remove(auth, access, userId);
  }
}
