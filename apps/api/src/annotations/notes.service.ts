import { Injectable } from '@nestjs/common';
import {
  type AnnotationCapabilitiesDto,
  AuditAction,
  type NoteDto,
  NotificationType,
  type Page,
} from '@kloister/shared';
import type { DbClient } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { forbidden, invalidField, notFound } from '../common/api-exception.js';
import { type PageQueryDto, pageArgs, toPage } from '../common/pagination.js';
import { mentionedIds } from '../common/sanitize-html.js';
import { serializable } from '../common/transactions.js';
import type { Note } from '../generated/prisma/client.js';
import { type ItemRow, itemFacts } from '../items/item.mapper.js';
import { sanitizeItemText } from '../items/item-rich-text.js';
import { ItemsService } from '../items/items.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type ProjectAccess, ProjectAccessService } from '../projects/project-access.service.js';
import type { CreateNoteDto, UpdateNoteDto } from './annotations.dto.js';

/** A note row with its author's name. */
type NoteRow = Note & { author: { displayName: string } };

/**
 * Notes on work items (SPEC §4 `Note`, §6 notes thread with `@mention`).
 *
 * Permissions (SPEC §3.2 "Notes and attachments on visible items"): reading
 * needs a visible item (404 otherwise); adding needs `ANNOTATE_ITEMS` (PM,
 * Lead, Member; 403 for Viewers and non-member admins). Only the author
 * changes a note's text; the author, PMs, Leads and the item's team Leads
 * may delete it ({@link ProjectAccessService.canModerateAnnotations}).
 *
 * Bodies are sanitized like descriptions (SPEC §5): images only from the
 * item's own inline-image endpoint, mentions only of active project members.
 * Mentioned people who can see the item are notified; the body never enters
 * the audit log.
 */
@Injectable()
export class NotesService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param items Item lookup through the visibility filter, and audit.
   * @param access Permission rules.
   * @param notifications Mention notifications.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly access: ProjectAccessService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Lists an item's notes, newest first.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @param page Cursor and page size.
   * @returns One page of notes.
   */
  async list(
    auth: AuthContext,
    access: ProjectAccess,
    ref: string,
    page: PageQueryDto,
  ): Promise<Page<NoteDto>> {
    const item = await this.items.findVisible(this.prisma, access, ref);
    if (page.cursor !== undefined) {
      const cursor = await this.prisma.note.count({
        where: { id: page.cursor, workItemId: item.id },
      });
      if (cursor === 0) return { items: [], nextCursor: null };
    }
    const rows = await this.prisma.note.findMany({
      where: { workItemId: item.id },
      include: { author: { select: { displayName: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...pageArgs(page),
    });
    return toPage(rows, page, (row) => this.toDto(auth, access, item, row));
  }

  /**
   * Adds a note and notifies the people it mentions.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @param dto The note.
   * @returns The new note (201).
   */
  async create(
    auth: AuthContext,
    access: ProjectAccess,
    ref: string,
    dto: CreateNoteDto,
  ): Promise<NoteDto> {
    return serializable(this.prisma, async (tx) => {
      const item = await this.annotatable(tx, access, ref);
      const { html: body, mentioned } = await this.sanitize(tx, access, item, dto.body);
      const note = await tx.note.create({
        data: { workItemId: item.id, authorId: auth.user.id, body },
        include: { author: { select: { displayName: true } } },
      });
      await this.items.record(tx, auth, access, AuditAction.NOTE_ADDED, item.id, {
        number: item.number,
        noteId: note.id,
      });
      await this.notifyMentions(tx, auth, access, item, mentioned);
      return this.toDto(auth, access, item, note);
    });
  }

  /**
   * Changes a note's text; newly mentioned people are notified.
   *
   * Permissions: the author only, while they may still annotate the item.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @param noteId Note id.
   * @param dto The new text.
   * @returns The updated note.
   */
  async update(
    auth: AuthContext,
    access: ProjectAccess,
    ref: string,
    noteId: string,
    dto: UpdateNoteDto,
  ): Promise<NoteDto> {
    return serializable(this.prisma, async (tx) => {
      const item = await this.annotatable(tx, access, ref);
      const note = await findNote(tx, item.id, noteId);
      if (note.authorId !== auth.user.id) throw forbidden('Only the author can change a note');
      const { html: body, mentioned } = await this.sanitize(tx, access, item, dto.body);
      if (body === note.body) return this.toDto(auth, access, item, note);
      const updated = await tx.note.update({
        where: { id: note.id },
        data: { body, editedAt: new Date() },
        include: { author: { select: { displayName: true } } },
      });
      await this.items.record(tx, auth, access, AuditAction.NOTE_UPDATED, item.id, {
        number: item.number,
        noteId: note.id,
      });
      const before = new Set(mentionedIds(note.body));
      await this.notifyMentions(
        tx,
        auth,
        access,
        item,
        mentioned.filter((id) => !before.has(id)),
      );
      return this.toDto(auth, access, item, updated);
    });
  }

  /**
   * Deletes a note.
   *
   * Permissions: its author while they may annotate the item, or a moderator
   * (PMs, Leads, the item's team Leads); 403 otherwise.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @param noteId Note id.
   * @returns Resolves once deleted (204).
   */
  async remove(
    auth: AuthContext,
    access: ProjectAccess,
    ref: string,
    noteId: string,
  ): Promise<void> {
    await serializable(this.prisma, async (tx) => {
      const item = await this.items.findVisible(tx, access, ref);
      const note = await findNote(tx, item.id, noteId);
      if (!this.capabilities(auth, access, item, note).delete) throw forbidden();
      await tx.note.delete({ where: { id: note.id } });
      await this.items.record(tx, auth, access, AuditAction.NOTE_DELETED, item.id, {
        number: item.number,
        noteId: note.id,
        authorId: note.authorId,
      });
    });
  }

  /**
   * Loads a visible item the caller may annotate.
   *
   * @param db Transaction client.
   * @param access The caller's access.
   * @param ref Item uuid or number.
   * @returns The item; 404 if invisible, 403 if not annotatable.
   */
  private async annotatable(db: DbClient, access: ProjectAccess, ref: string): Promise<ItemRow> {
    const item = await this.items.findVisible(db, access, ref);
    if (!this.access.canAnnotateItem(access, itemFacts(item))) throw forbidden();
    return item;
  }

  /**
   * Sanitizes a note body for the item; empty notes are refused.
   *
   * @param db Transaction client.
   * @param access The caller's access.
   * @param item The item.
   * @param html Untrusted HTML.
   * @returns Safe HTML and the users its mentions name.
   */
  private async sanitize(
    db: DbClient,
    access: ProjectAccess,
    item: ItemRow,
    html: string,
  ): Promise<{ html: string; mentioned: string[] }> {
    const members =
      access.project.ownerId !== null
        ? []
        : await db.projectMember.findMany({
            where: { projectId: access.project.id, user: { isActive: true } },
            select: { userId: true, user: { select: { displayName: true } } },
          });
    const result = await sanitizeItemText(
      db,
      access.project.id,
      item.id,
      html,
      new Map(members.map((m) => [m.userId, m.user.displayName])),
    );
    const body = result.html;
    if (body.replace(/<[^>]*>|&nbsp;|\s/g, '') === '' && !body.includes('<img')) {
      throw invalidField('body', 'The note is empty');
    }
    return result;
  }

  /**
   * Notifies mentioned people who can see the item (not the author).
   *
   * @param db Transaction client.
   * @param auth The caller.
   * @param access The caller's access.
   * @param item The item.
   * @param userIds Mentioned users.
   * @returns Resolves once recorded.
   */
  private async notifyMentions(
    db: DbClient,
    auth: AuthContext,
    access: ProjectAccess,
    item: ItemRow,
    userIds: readonly string[],
  ): Promise<void> {
    await this.notifications.notify(db, {
      type: NotificationType.MENTIONED,
      actorId: auth.user.id,
      projectId: access.project.id,
      itemId: item.id,
      facts: itemFacts(item),
      recipients: userIds,
    });
  }

  /**
   * What the caller may do with a note.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param item The item.
   * @param note The note.
   * @returns The capabilities.
   */
  private capabilities(
    auth: AuthContext,
    access: ProjectAccess,
    item: ItemRow,
    note: Pick<Note, 'authorId'>,
  ): AnnotationCapabilitiesDto {
    const facts = itemFacts(item);
    const own = note.authorId === auth.user.id && this.access.canAnnotateItem(access, facts);
    return { edit: own, delete: own || this.access.canModerateAnnotations(access, facts) };
  }

  /**
   * Converts a note to its API shape.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param item The item.
   * @param row The note with its author's name.
   * @returns The DTO.
   */
  private toDto(auth: AuthContext, access: ProjectAccess, item: ItemRow, row: NoteRow): NoteDto {
    return {
      id: row.id,
      authorId: row.authorId,
      authorName: row.author.displayName,
      body: row.body,
      editedAt: row.editedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      can: this.capabilities(auth, access, item, row),
    };
  }
}

/**
 * Loads a note of the item, or throws 404.
 *
 * @param db Transaction client.
 * @param itemId Item id.
 * @param noteId Note id.
 * @returns The note with its author's name.
 */
async function findNote(db: DbClient, itemId: string, noteId: string): Promise<NoteRow> {
  const note = await db.note.findFirst({
    where: { id: noteId, workItemId: itemId },
    include: { author: { select: { displayName: true } } },
  });
  if (note === null) throw notFound('Note');
  return note;
}
