import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import type { ProjectDto } from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { PersonalService } from './personal.service.js';

/** Own personal space only; owner identity always comes from the session. */
@Controller('me/personal')
export class PersonalController {
  /**
   * Receives personal space operations.
   * @param personal Caller-only operations.
   */
  constructor(private readonly personal: PersonalService) {}

  /**
   * Reads the caller's space, or returns 404 before first use.
   * @param auth Signed-in owner.
   * @returns The private project.
   */
  @Get()
  get(@CurrentAuth() auth: AuthContext): Promise<ProjectDto> {
    return this.personal.get(auth);
  }

  /**
   * Initializes the caller's space; the global CSRF guard protects this write.
   * @param auth Signed-in owner.
   * @returns The same private project on every request.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  ensure(@CurrentAuth() auth: AuthContext): Promise<ProjectDto> {
    return this.personal.ensure(auth);
  }
}
