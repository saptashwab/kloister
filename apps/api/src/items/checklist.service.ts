import { Injectable } from '@nestjs/common';
import { AuditAction, type ChecklistItemDto } from '@kloister/shared';
import type { DbClient } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { forbidden, invalidField, notFound } from '../common/api-exception.js';
import { placeAfter, positionAtEnd } from '../common/positions.js';
import { serializable } from '../common/transactions.js';
import type { ChecklistItem, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type ProjectAccess, ProjectAccessService } from '../projects/project-access.service.js';
import type { ReorderDto } from '../board/board.dto.js';
import { type ItemRow, itemFacts, toChecklistItemDto } from './item.mapper.js';
import type { CreateChecklistItemDto, UpdateChecklistItemDto } from './items.dto.js';
import { ItemsService } from './items.service.js';

/**
 * Item checklists (SPEC §4 `ChecklistItem`, §8 `items/…/checklist`).
 * Checklists show progress and never change an item's status (SPEC §4.2).
 *
 * Permissions: reading needs the item to be visible (404 otherwise);
 * every change counts as editing the item (403 unless the caller may edit
 * it). Additions, edits and removals are recorded in the item's activity
 * history; reordering is not.
 */
@Injectable()
export class ChecklistService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param items Item lookup and audit.
   * @param access Item permission rules.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly access: ProjectAccessService,
  ) {}

  /**
   * Lists an item's checklist in order.
   *
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @returns The lines.
   */
  async list(access: ProjectAccess, ref: string): Promise<ChecklistItemDto[]> {
    const item = await this.items.findVisible(this.prisma, access, ref);
    const lines = await this.prisma.checklistItem.findMany({
      where: { workItemId: item.id },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    return lines.map(toChecklistItemDto);
  }

  /**
   * Appends a line.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @param dto Text and initial state.
   * @returns The new line (201).
   */
  async add(
    auth: AuthContext,
    access: ProjectAccess,
    ref: string,
    dto: CreateChecklistItemDto,
  ): Promise<ChecklistItemDto> {
    return serializable(this.prisma, async (tx) => {
      const item = await this.editable(tx, access, ref);
      const last = await tx.checklistItem.findFirst({
        where: { workItemId: item.id },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const line = await tx.checklistItem.create({
        data: {
          workItemId: item.id,
          text: dto.text,
          done: dto.done ?? false,
          position: positionAtEnd(last?.position ?? null),
        },
      });
      await this.items.record(tx, auth, access, AuditAction.CHECKLIST_ITEM_ADDED, item.id, {
        number: item.number,
        lineId: line.id,
        text: line.text,
      });
      return toChecklistItemDto(line);
    });
  }

  /**
   * Changes a line's text or ticks it.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @param lineId Checklist line id.
   * @param dto Fields to change.
   * @returns The updated line.
   */
  async update(
    auth: AuthContext,
    access: ProjectAccess,
    ref: string,
    lineId: string,
    dto: UpdateChecklistItemDto,
  ): Promise<ChecklistItemDto> {
    return serializable(this.prisma, async (tx) => {
      const item = await this.editable(tx, access, ref);
      const line = await findLine(tx, item.id, lineId);
      const changes: Record<string, Prisma.InputJsonValue> = {};
      if (dto.text !== undefined && dto.text !== line.text) {
        changes['text'] = { from: line.text, to: dto.text };
      }
      if (dto.done !== undefined && dto.done !== line.done) {
        changes['done'] = { from: line.done, to: dto.done };
      }
      if (Object.keys(changes).length === 0) return toChecklistItemDto(line);
      const updated = await tx.checklistItem.update({
        where: { id: line.id },
        data: { text: dto.text ?? line.text, done: dto.done ?? line.done },
      });
      await this.items.record(tx, auth, access, AuditAction.CHECKLIST_ITEM_UPDATED, item.id, {
        number: item.number,
        lineId,
        changes,
      });
      return toChecklistItemDto(updated);
    });
  }

  /**
   * Moves a line after another (or first).
   *
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @param lineId Checklist line id.
   * @param dto The line to place it after.
   * @returns The moved line.
   */
  async move(
    access: ProjectAccess,
    ref: string,
    lineId: string,
    dto: ReorderDto,
  ): Promise<ChecklistItemDto> {
    return serializable(this.prisma, async (tx) => {
      const item = await this.editable(tx, access, ref);
      await findLine(tx, item.id, lineId);
      const siblings = await tx.checklistItem.findMany({
        where: { workItemId: item.id, id: { not: lineId } },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: { id: true, position: true },
      });
      const afterId = dto.afterId ?? null;
      if (afterId !== null && !siblings.some((s) => s.id === afterId)) {
        throw invalidField('afterId', 'Checklist line not found');
      }
      const placement = placeAfter(siblings, afterId);
      for (const row of placement.renumber) {
        await tx.checklistItem.update({ where: { id: row.id }, data: { position: row.position } });
      }
      return toChecklistItemDto(
        await tx.checklistItem.update({
          where: { id: lineId },
          data: { position: placement.position },
        }),
      );
    });
  }

  /**
   * Removes a line.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @param lineId Checklist line id.
   * @returns Resolves once removed (204).
   */
  async remove(
    auth: AuthContext,
    access: ProjectAccess,
    ref: string,
    lineId: string,
  ): Promise<void> {
    await serializable(this.prisma, async (tx) => {
      const item = await this.editable(tx, access, ref);
      const line = await findLine(tx, item.id, lineId);
      await tx.checklistItem.delete({ where: { id: line.id } });
      await this.items.record(tx, auth, access, AuditAction.CHECKLIST_ITEM_REMOVED, item.id, {
        number: item.number,
        lineId,
        text: line.text,
      });
    });
  }

  /**
   * Loads a visible item the caller may edit.
   *
   * @param db Transaction client.
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @returns The item; 404 if invisible, 403 if not editable.
   */
  private async editable(db: DbClient, access: ProjectAccess, ref: string): Promise<ItemRow> {
    const item = await this.items.findVisible(db, access, ref);
    if (!this.access.canEditItem(access, itemFacts(item))) throw forbidden();
    return item;
  }
}

/**
 * Loads a checklist line of the item, or throws 404.
 *
 * @param db Transaction client.
 * @param itemId Item id.
 * @param lineId Line id.
 * @returns The line.
 */
async function findLine(db: DbClient, itemId: string, lineId: string): Promise<ChecklistItem> {
  const line = await db.checklistItem.findFirst({ where: { id: lineId, workItemId: itemId } });
  if (line === null) throw notFound('Checklist line');
  return line;
}
