import { Injectable } from '@nestjs/common';
import { AuditAction, type LabelDto, type Page } from '@kloister/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { notFound } from '../common/api-exception.js';
import { type PageQueryDto, pageArgs, toPage } from '../common/pagination.js';
import { serializable } from '../common/transactions.js';
import type { Label, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import { toLabelDto } from './board.mapper.js';
import type { CreateLabelDto, UpdateLabelDto } from './board.dto.js';

/** Conflict message for a duplicate label name. */
const DUPLICATE_NAME = 'A label with this name already exists in the project';

/**
 * Project labels (SPEC §4, §8 `labels`).
 *
 * Permissions: any member (or admin) lists labels; changes need
 * `MANAGE_BOARD` (PM and Lead), checked by `ProjectAccessGuard`. Deleting a
 * label removes it from every item.
 */
@Injectable()
export class LabelsService {
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
   * Lists labels by name.
   *
   * Permissions: any member; any admin (audited if not a member).
   *
   * @param access The caller's access.
   * @param page Cursor and page size.
   * @returns One page of labels.
   */
  async list(access: ProjectAccess, page: PageQueryDto): Promise<Page<LabelDto>> {
    const rows = await this.prisma.label.findMany({
      where: { projectId: access.project.id },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      ...pageArgs(page),
    });
    return toPage(rows, page, toLabelDto);
  }

  /**
   * Creates a label. Names are unique per project (409 `CONFLICT`).
   *
   * Permissions: `MANAGE_BOARD`.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param dto Name and colour.
   * @returns The new label (201).
   */
  async create(auth: AuthContext, access: ProjectAccess, dto: CreateLabelDto): Promise<LabelDto> {
    const projectId = access.project.id;
    return serializable(
      this.prisma,
      async (tx) => {
        const label = await tx.label.create({
          data: { projectId, name: dto.name, colour: dto.colour.toLowerCase() },
        });
        await this.record(tx, auth, projectId, AuditAction.LABEL_CREATED, label.id, {
          name: label.name,
          colour: label.colour,
        });
        return toLabelDto(label);
      },
      DUPLICATE_NAME,
    );
  }

  /**
   * Renames or recolours a label.
   *
   * Permissions: `MANAGE_BOARD`; 404 for labels of other projects.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param labelId Label id.
   * @param dto Fields to change.
   * @returns The updated label.
   */
  async update(
    auth: AuthContext,
    access: ProjectAccess,
    labelId: string,
    dto: UpdateLabelDto,
  ): Promise<LabelDto> {
    const projectId = access.project.id;
    return serializable(
      this.prisma,
      async (tx) => {
        const current = await findLabel(tx, projectId, labelId);
        const colour = dto.colour?.toLowerCase();
        const changes: Record<string, { from: string; to: string }> = {};
        if (dto.name !== undefined && dto.name !== current.name) {
          changes['name'] = { from: current.name, to: dto.name };
        }
        if (colour !== undefined && colour !== current.colour) {
          changes['colour'] = { from: current.colour, to: colour };
        }
        if (Object.keys(changes).length === 0) return toLabelDto(current);
        const label = await tx.label.update({
          where: { id: labelId },
          data: { name: dto.name ?? current.name, colour: colour ?? current.colour },
        });
        await this.record(tx, auth, projectId, AuditAction.LABEL_UPDATED, labelId, { changes });
        return toLabelDto(label);
      },
      DUPLICATE_NAME,
    );
  }

  /**
   * Deletes a label and removes it from every item (database cascade).
   *
   * Permissions: `MANAGE_BOARD`.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param labelId Label id.
   * @returns Resolves once deleted (204).
   */
  async remove(auth: AuthContext, access: ProjectAccess, labelId: string): Promise<void> {
    const projectId = access.project.id;
    await serializable(this.prisma, async (tx) => {
      const label = await findLabel(tx, projectId, labelId);
      const items = await tx.workItemLabel.count({ where: { labelId } });
      await tx.label.delete({ where: { id: labelId } });
      await this.record(tx, auth, projectId, AuditAction.LABEL_DELETED, labelId, {
        name: label.name,
        items,
      });
    });
  }

  /**
   * Writes a label audit entry.
   *
   * @param tx Transaction client.
   * @param auth The caller.
   * @param projectId Project id.
   * @param action What happened.
   * @param labelId Label id.
   * @param meta Extra detail.
   * @returns Resolves once written.
   */
  private record(
    tx: Prisma.TransactionClient,
    auth: AuthContext,
    projectId: string,
    action: AuditAction,
    labelId: string,
    meta: Prisma.InputJsonObject,
  ): Promise<void> {
    return this.audit.record(
      { actorId: auth.user.id, action, entityType: 'Label', entityId: labelId, projectId, meta },
      tx,
    );
  }
}

/**
 * Loads a label of the project, or throws 404.
 *
 * @param tx Transaction client.
 * @param projectId Project id.
 * @param labelId Label id.
 * @returns The label.
 */
async function findLabel(
  tx: Prisma.TransactionClient,
  projectId: string,
  labelId: string,
): Promise<Label> {
  const label = await tx.label.findFirst({ where: { id: labelId, projectId } });
  if (label === null) throw notFound('Label');
  return label;
}
