import { Controller, Get, Put } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Self-only introduction state; the normal password and CSRF guards apply. */
@Controller('me/introduction')
export class IntroductionController {
  /**
   * Receives account storage.
   * @param prisma Database access.
   */
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reads durable eligibility without enrolling an existing account.
   * @param auth Signed-in caller after required password change.
   * @returns Whether the automatic introduction remains pending.
   */
  @Get()
  async get(@CurrentAuth() auth: AuthContext): Promise<{ pending: boolean }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
    return { pending: user.introductionState === 'READY' };
  }

  /**
   * Completes or skips a pending introduction, idempotently and for self only.
   * @param auth Signed-in caller after required password change.
   * @returns The dismissed state; replay never re-arms eligibility.
   */
  @Put()
  async dismiss(@CurrentAuth() auth: AuthContext): Promise<{ pending: boolean }> {
    await this.prisma.user.updateMany({
      where: { id: auth.user.id, introductionState: 'READY' },
      data: { introductionState: 'DISMISSED' },
    });
    return { pending: false };
  }
}
