import { Injectable } from '@nestjs/common';
import { AuditAction, type WorkItemDetailDto } from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { forbidden, invalidField, notFound } from '../common/api-exception.js';
import { serializable } from '../common/transactions.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type ProjectAccess, ProjectAccessService } from '../projects/project-access.service.js';
import { itemFacts } from './item.mapper.js';
import type { AddDependencyDto } from './items.dto.js';
import { ItemsService } from './items.service.js';

/**
 * "Blocked by" dependencies between items of one project (SPEC §4
 * `WorkItemDependency`). Dependencies may cross teams and never form a
 * cycle. They are managed from the blocked item.
 *
 * Permissions: the caller must be able to edit the blocked item (404 if
 * invisible, 403 if not editable) and see the blocking item (400 otherwise,
 * the same answer as for an unknown item).
 */
@Injectable()
export class DependenciesService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param items Item lookup, responses and audit.
   * @param access Item permission rules.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly access: ProjectAccessService,
  ) {}

  /**
   * Records that an item is blocked by another. Adding an existing
   * dependency changes nothing. Runs serializable, so two concurrent links
   * cannot close a cycle together.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param ref Blocked item uuid or number.
   * @param dto The blocking item.
   * @returns The blocked item.
   */
  async add(
    auth: AuthContext,
    access: ProjectAccess,
    ref: string,
    dto: AddDependencyDto,
  ): Promise<WorkItemDetailDto> {
    const row = await serializable(this.prisma, async (tx) => {
      const item = await this.items.findVisible(tx, access, ref);
      if (!this.access.canEditItem(access, itemFacts(item))) throw forbidden();
      if (dto.blockingItemId === item.id) {
        throw invalidField('blockingItemId', 'An item cannot block itself');
      }
      const blocking = await tx.workItem.findFirst({
        where: this.items.scoped(access, { id: dto.blockingItemId }),
        select: { id: true, number: true },
      });
      if (blocking === null) throw invalidField('blockingItemId', 'Item not found');
      // Compared again on the stored ids, which are canonical.
      if (blocking.id === item.id) {
        throw invalidField('blockingItemId', 'An item cannot block itself');
      }
      const existing = await tx.workItemDependency.findUnique({
        where: {
          blockedItemId_blockingItemId: { blockedItemId: item.id, blockingItemId: blocking.id },
        },
      });
      if (existing !== null) return item;
      // Unscoped on purpose: a cycle through items the caller cannot see is
      // still a cycle. Only ids are read.
      const seen = new Set<string>();
      for (let frontier = [blocking.id]; frontier.length > 0;) {
        const edges = await tx.workItemDependency.findMany({
          where: { blockedItemId: { in: frontier } },
          select: { blockingItemId: true },
        });
        frontier = [];
        for (const { blockingItemId } of edges) {
          if (blockingItemId === item.id) {
            throw invalidField('blockingItemId', 'This dependency would create a cycle');
          }
          if (!seen.has(blockingItemId)) {
            seen.add(blockingItemId);
            frontier.push(blockingItemId);
          }
        }
      }
      await tx.workItemDependency.create({
        data: {
          projectId: access.project.id,
          blockedItemId: item.id,
          blockingItemId: blocking.id,
        },
      });
      await this.items.record(tx, auth, access, AuditAction.DEPENDENCY_ADDED, item.id, {
        number: item.number,
        blockingItemId: blocking.id,
        blockingNumber: blocking.number,
      });
      return item;
    });
    return this.items.detail(this.prisma, access, row);
  }

  /**
   * Removes a "blocked by" dependency.
   *
   * Permissions: as for adding; a dependency on an item the caller cannot
   * see is answered with 404, like one that does not exist.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param ref Blocked item uuid or number.
   * @param blockingItemId The blocking item.
   * @returns The blocked item.
   */
  async remove(
    auth: AuthContext,
    access: ProjectAccess,
    ref: string,
    blockingItemId: string,
  ): Promise<WorkItemDetailDto> {
    const row = await serializable(this.prisma, async (tx) => {
      const item = await this.items.findVisible(tx, access, ref);
      if (!this.access.canEditItem(access, itemFacts(item))) throw forbidden();
      const dependency = await tx.workItemDependency.findFirst({
        where: {
          blockedItemId: item.id,
          blockingItemId,
          blockingItem: this.items.scoped(access, {}),
        },
        include: { blockingItem: { select: { number: true } } },
      });
      if (dependency === null) throw notFound('Dependency');
      await tx.workItemDependency.delete({ where: { id: dependency.id } });
      await this.items.record(tx, auth, access, AuditAction.DEPENDENCY_REMOVED, item.id, {
        number: item.number,
        blockingItemId,
        blockingNumber: dependency.blockingItem.number,
      });
      return item;
    });
    return this.items.detail(this.prisma, access, row);
  }
}
