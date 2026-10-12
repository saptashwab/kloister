import { Body, Controller, Get, Patch } from '@nestjs/common';
import type { UserDto } from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { AllowPendingPasswordChange, CurrentAuth } from '../auth/decorators.js';
import { toUserDto } from './user.mapper.js';
import { UpdateMeDto } from './users.dto.js';
import { UsersService } from './users.service.js';

/**
 * The caller's own account under `/api/v1/me` (SPEC §8).
 *
 * Permissions: any signed-in user, acting on themselves only.
 */
@Controller('me')
export class MeController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param users Account management.
   */
  constructor(private readonly users: UsersService) {}

  /**
   * Returns the signed-in user. Allowed while a password change is pending
   * so the web app can route to the change-password screen.
   *
   * @param auth The caller.
   * @returns The caller's user record.
   */
  @AllowPendingPasswordChange()
  @Get()
  get(@CurrentAuth() auth: AuthContext): UserDto {
    return toUserDto(auth.user);
  }

  /**
   * Updates the caller's display name.
   *
   * @param auth The caller.
   * @param body Fields to change.
   * @returns The updated user.
   */
  @Patch()
  update(@CurrentAuth() auth: AuthContext, @Body() body: UpdateMeDto): Promise<UserDto> {
    return this.users.updateMe(auth, body);
  }
}
