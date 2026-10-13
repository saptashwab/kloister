import { Injectable } from '@nestjs/common';
import { AuditAction, type BucketDto, BucketRule, ErrorCode, type Page } from '@kloister/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { conflict, invalidField, notFound } from '../common/api-exception.js';
import { type PageQueryDto, pageArgs, toPage } from '../common/pagination.js';
import { placeAfter, POSITION_STEP, positionAtEnd } from '../common/positions.js';
import { serializable } from '../common/transactions.js';
import type { Bucket, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import { withoutBucket } from '../projects/project-settings.js';
import { toBucketDto } from './board.mapper.js';
import type {
  CreateBucketDto,
  DeleteBucketQueryDto,
  ReorderDto,
  UpdateBucketDto,
} from './board.dto.js';
import { resolveEntryRule } from './bucket-rules.js';

/**
 * Board buckets (SPEC §4, §4.2, §8 `buckets`): the columns of the board,
 * their order and their entry rules.
 *
 * Permissions: any member (or admin) lists buckets; changes need
 * `MANAGE_BOARD` (PM and Lead), checked by `ProjectAccessGuard`, which also
 * refuses changes to archived projects.
 */
@Injectable()
export class BucketsService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param audit Audit log.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lists the project's buckets in board order. Every bucket is listed, also
   * to callers with the `BUCKETS` scope: names are not items.
   *
   * Permissions: any member; any admin (audited if not a member).
   *
   * @param access The caller's access.
   * @param page Cursor and page size.
   * @returns One page of buckets.
   */
  async list(access: ProjectAccess, page: PageQueryDto): Promise<Page<BucketDto>> {
    const rows = await this.prisma.bucket.findMany({
      where: { projectId: access.project.id },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      ...pageArgs(page),
    });
    return toPage(rows, page, toBucketDto);
  }

  /**
   * Adds a bucket as the last column.
   *
   * Permissions: `MANAGE_BOARD`.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param dto Name and entry rule.
   * @returns The new bucket (201).
   */
  async create(auth: AuthContext, access: ProjectAccess, dto: CreateBucketDto): Promise<BucketDto> {
    const projectId = access.project.id;
    const rule = resolveEntryRule(
      { onEnterMode: BucketRule.NONE, onEnterStatus: null },
      { onEnterMode: dto.onEnterMode, onEnterStatus: dto.onEnterStatus },
    );
    return serializable(this.prisma, async (tx) => {
      const last = await tx.bucket.findFirst({
        where: { projectId },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const bucket = await tx.bucket.create({
        data: {
          projectId,
          name: dto.name,
          position: positionAtEnd(last?.position ?? null),
          ...rule,
        },
      });
      await this.record(tx, auth, projectId, AuditAction.BUCKET_CREATED, bucket.id, {
        name: bucket.name,
        ...rule,
      });
      return toBucketDto(bucket);
    });
  }

  /**
   * Renames a bucket or changes its entry rule.
   *
   * Permissions: `MANAGE_BOARD`; 404 for buckets of other projects.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param bucketId Bucket id.
   * @param dto Fields to change.
   * @returns The updated bucket.
   */
  async update(
    auth: AuthContext,
    access: ProjectAccess,
    bucketId: string,
    dto: UpdateBucketDto,
  ): Promise<BucketDto> {
    const projectId = access.project.id;
    return serializable(this.prisma, async (tx) => {
      const current = await findBucket(tx, projectId, bucketId);
      const rule = resolveEntryRule(current, dto);
      const changes: Record<string, { from: string | null; to: string | null }> = {};
      if (dto.name !== undefined && dto.name !== current.name) {
        changes['name'] = { from: current.name, to: dto.name };
      }
      if (rule.onEnterMode !== current.onEnterMode) {
        changes['onEnterMode'] = { from: current.onEnterMode, to: rule.onEnterMode };
      }
      if (rule.onEnterStatus !== current.onEnterStatus) {
        changes['onEnterStatus'] = { from: current.onEnterStatus, to: rule.onEnterStatus };
      }
      if (Object.keys(changes).length === 0) return toBucketDto(current);
      const bucket = await tx.bucket.update({
        where: { id: bucketId },
        data: { name: dto.name ?? current.name, ...rule },
      });
      await this.record(tx, auth, projectId, AuditAction.BUCKET_UPDATED, bucketId, { changes });
      return toBucketDto(bucket);
    });
  }

  /**
   * Moves a bucket to another place in the column order. Reordering is not
   * audited.
   *
   * Permissions: `MANAGE_BOARD`.
   *
   * @param access The caller's access.
   * @param bucketId Bucket id.
   * @param dto The bucket to place it after, or null for the first column.
   * @returns The moved bucket.
   */
  async move(access: ProjectAccess, bucketId: string, dto: ReorderDto): Promise<BucketDto> {
    const projectId = access.project.id;
    return serializable(this.prisma, async (tx) => {
      await findBucket(tx, projectId, bucketId);
      const siblings = await tx.bucket.findMany({
        where: { projectId, id: { not: bucketId } },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: { id: true, position: true },
      });
      const afterId = dto.afterId ?? null;
      if (afterId !== null && !siblings.some((s) => s.id === afterId)) {
        throw invalidField('afterId', 'Bucket not found');
      }
      const placement = placeAfter(siblings, afterId);
      for (const row of placement.renumber) {
        await tx.bucket.update({ where: { id: row.id }, data: { position: row.position } });
      }
      return toBucketDto(
        await tx.bucket.update({ where: { id: bucketId }, data: { position: placement.position } }),
      );
    });
  }

  /**
   * Deletes a bucket. A bucket that still holds items is only deleted when
   * `moveItemsTo` names another bucket; the items keep their status and are
   * appended to it in their current order (no entry rule runs, because this
   * is a clean-up, not a card move). The bucket is also removed from members'
   * `BUCKETS` scopes and from the status → bucket map. The last bucket of a
   * project cannot be deleted.
   *
   * Permissions: `MANAGE_BOARD`. 409 `BUCKET_NOT_EMPTY` without a target,
   * 409 `CONFLICT` for the last bucket.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param bucketId Bucket id.
   * @param query Where the items go.
   * @returns Resolves once deleted (204).
   */
  async remove(
    auth: AuthContext,
    access: ProjectAccess,
    bucketId: string,
    query: DeleteBucketQueryDto,
  ): Promise<void> {
    const projectId = access.project.id;
    await serializable(this.prisma, async (tx) => {
      const bucket = await findBucket(tx, projectId, bucketId);
      if ((await tx.bucket.count({ where: { projectId } })) === 1) {
        throw conflict('A project needs at least one bucket');
      }
      const items = await tx.workItem.findMany({
        where: { projectId, bucketId },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      let target: Bucket | null = null;
      if (items.length > 0) {
        if (query.moveItemsTo === undefined) {
          throw conflict(
            'This bucket still holds items; choose a bucket to move them to',
            ErrorCode.BUCKET_NOT_EMPTY,
          );
        }
        target =
          query.moveItemsTo === bucketId
            ? null
            : await tx.bucket.findFirst({ where: { id: query.moveItemsTo, projectId } });
        if (target === null)
          throw invalidField('moveItemsTo', 'Choose another bucket of this project');
        const last = await tx.workItem.findFirst({
          where: { projectId, bucketId: target.id },
          orderBy: { position: 'desc' },
          select: { position: true },
        });
        let position = last?.position ?? 0;
        for (const item of items) {
          position += POSITION_STEP;
          await tx.workItem.update({
            where: { id: item.id },
            data: { bucketId: target.id, position },
          });
        }
      }
      await tx.bucket.delete({ where: { id: bucketId } });
      // Drop the bucket from every member's BUCKETS scope of this project.
      await tx.$executeRaw`UPDATE "ProjectMember" SET "allowedBucketIds" = array_remove("allowedBucketIds", ${bucketId}::uuid) WHERE "projectId" = ${projectId}::uuid AND ${bucketId}::uuid = ANY("allowedBucketIds")`;
      const project = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
      const settings = withoutBucket(project.settings, bucketId);
      if (settings !== null) {
        await tx.project.update({ where: { id: projectId }, data: { settings } });
      }
      await this.record(tx, auth, projectId, AuditAction.BUCKET_DELETED, bucketId, {
        name: bucket.name,
        movedItems: items.length,
        ...(target === null ? {} : { movedTo: target.id }),
      });
    });
  }

  /**
   * Writes a bucket audit entry.
   *
   * @param tx Transaction client.
   * @param auth The caller.
   * @param projectId Project id.
   * @param action What happened.
   * @param bucketId Bucket id.
   * @param meta Extra detail.
   * @returns Resolves once written.
   */
  private record(
    tx: Prisma.TransactionClient,
    auth: AuthContext,
    projectId: string,
    action: AuditAction,
    bucketId: string,
    meta: Prisma.InputJsonObject,
  ): Promise<void> {
    return this.audit.record(
      { actorId: auth.user.id, action, entityType: 'Bucket', entityId: bucketId, projectId, meta },
      tx,
    );
  }
}

/**
 * Loads a bucket of the project, or throws 404 (also for other projects'
 * buckets).
 *
 * @param tx Transaction client.
 * @param projectId Project id.
 * @param bucketId Bucket id.
 * @returns The bucket.
 */
async function findBucket(
  tx: Prisma.TransactionClient,
  projectId: string,
  bucketId: string,
): Promise<Bucket> {
  const bucket = await tx.bucket.findFirst({ where: { id: bucketId, projectId } });
  if (bucket === null) throw notFound('Bucket');
  return bucket;
}
