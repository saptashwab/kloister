import { HttpStatus } from '@nestjs/common';
import { ErrorCode, ProjectRole } from '@kloister/shared';
import { ApiException } from '../common/api-exception.js';
import type { Prisma } from '../generated/prisma/client.js';
import { projectArchived } from './project-access.service.js';

/**
 * Re-checks inside a serializable transaction that the caller is still a PM
 * of the project and that it is not archived. The guard checked the same
 * before the transaction; reading it again inside makes a concurrent
 * demotion or archive conflict with the change instead of being bypassed.
 *
 * Permissions: 403 `FORBIDDEN` if the caller is no longer a PM; 409
 * `PROJECT_ARCHIVED` if the project was archived meanwhile.
 *
 * @param tx Transaction client.
 * @param projectId Project id.
 * @param actorId The caller's user id.
 * @returns Resolves when the caller may proceed.
 */
export async function assertStillPm(
  tx: Prisma.TransactionClient,
  projectId: string,
  actorId: string,
): Promise<void> {
  const actor = await tx.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: actorId } },
    include: { project: { select: { archivedAt: true } } },
  });
  if (actor?.role !== ProjectRole.PM) {
    throw new ApiException(
      HttpStatus.FORBIDDEN,
      ErrorCode.FORBIDDEN,
      'Your project role does not allow this',
    );
  }
  if (actor.project.archivedAt !== null) throw projectArchived();
}
