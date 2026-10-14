import { Injectable } from '@nestjs/common';
import { DEFAULT_BUCKETS, DEFAULT_PROJECT_SETTINGS, type ProjectDto } from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { POSITION_STEP } from '../common/positions.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectAccessService, projectNotFound } from './project-access.service.js';
import { toProjectDto } from './project.mapper.js';

/** Caller-only personal spaces; ordinary project membership is never created. */
@Injectable()
export class PersonalService {
  /**
   * Receives database access and the shared permission service.
   * @param prisma Database access.
   * @param access Project authorization.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
  ) {}

  /**
   * Reads only the caller's existing space without creating it.
   * @param auth Signed-in owner.
   * @returns The private project; 404 before first use.
   */
  async get(auth: AuthContext): Promise<ProjectDto> {
    const access = await this.access.ownPersonalAccess(auth);
    if (access === null) throw projectNotFound();
    return toProjectDto(access);
  }

  /**
   * Creates the caller's space on first use, with defaults, atomically.
   * @param auth Signed-in owner; no owner id is accepted from the request.
   * @returns The caller's sole personal space.
   */
  async ensure(auth: AuthContext): Promise<ProjectDto> {
    const ownerId = auth.user.id;
    try {
      await this.prisma.project.upsert({
        where: { ownerId },
        update: {},
        create: {
          ownerId,
          key: null,
          name: 'Personal',
          settings: { ...DEFAULT_PROJECT_SETTINGS },
          buckets: {
            create: DEFAULT_BUCKETS.map((b, index) => ({
              ...b,
              position: (index + 1) * POSITION_STEP,
            })),
          },
        },
      });
    } catch (error) {
      // Two first-use requests can race through a nested upsert. The unique
      // owner key chooses the winner; the loser reads that complete space.
      if (!isUniqueViolation(error)) throw error;
    }
    return this.get(auth);
  }
}
