import { Body, Controller, Delete, Get, Patch, Put } from '@nestjs/common';
import type { MyThemeDto, UserDto } from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { AllowPendingPasswordChange, CurrentAuth } from '../auth/decorators.js';
import { ThemeBody } from '../settings/settings.dto.js';
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

  /**
   * Returns the caller's own theme.
   *
   * @param auth The caller.
   * @returns Their theme, or null for "use default".
   */
  @Get('theme')
  getTheme(@CurrentAuth() auth: AuthContext): MyThemeDto {
    return this.users.getMyTheme(auth);
  }

  /**
   * Sets the caller's own theme (mode, primary and accent colour).
   *
   * @param auth The caller.
   * @param body The theme.
   * @returns The stored theme.
   */
  @Put('theme')
  putTheme(@CurrentAuth() auth: AuthContext, @Body() body: ThemeBody): Promise<MyThemeDto> {
    return this.users.setMyTheme(auth, body);
  }

  /**
   * Clears the caller's own theme, so the admin default applies.
   *
   * @param auth The caller.
   * @returns The stored theme (null).
   */
  @Delete('theme')
  clearTheme(@CurrentAuth() auth: AuthContext): Promise<MyThemeDto> {
    return this.users.setMyTheme(auth, null);
  }
}
