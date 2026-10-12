import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { Page, TemporaryPasswordResponse, UserDto } from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { AdminOnly, CurrentAuth } from '../auth/decorators.js';
import { CreateUserDto, ListUsersQueryDto, UpdateUserDto } from './users.dto.js';
import { UsersService } from './users.service.js';

/**
 * User administration under `/api/v1/admin/users` (SPEC §3.1, §8).
 *
 * Permissions: every route is admin-only; other users get 403.
 */
@Controller('admin/users')
@AdminOnly()
export class AdminUsersController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param users Account management.
   */
  constructor(private readonly users: UsersService) {}

  /**
   * Lists users, newest first.
   *
   * @param query Optional search text and pagination.
   * @returns One page of users.
   */
  @Get()
  list(@Query() query: ListUsersQueryDto): Promise<Page<UserDto>> {
    return this.users.list(query);
  }

  /**
   * Fetches one user.
   *
   * @param id User id.
   * @returns The user, or 404.
   */
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<UserDto> {
    return this.users.get(id);
  }

  /**
   * Creates a user with a temporary password shown once.
   *
   * @param auth The admin.
   * @param body Email, name and optional role.
   * @returns The user and temporary password (201).
   */
  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body() body: CreateUserDto,
  ): Promise<TemporaryPasswordResponse> {
    return this.users.create(auth, body);
  }

  /**
   * Renames, promotes/demotes, deactivates or reactivates a user.
   *
   * @param auth The admin.
   * @param id User id.
   * @param body Fields to change.
   * @returns The updated user.
   */
  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateUserDto,
  ): Promise<UserDto> {
    return this.users.update(auth, id, body);
  }

  /**
   * Issues a new temporary password and ends the user's sessions.
   *
   * @param auth The admin.
   * @param id User id.
   * @returns The user and temporary password.
   */
  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TemporaryPasswordResponse> {
    return this.users.resetPassword(auth, id);
  }
}
