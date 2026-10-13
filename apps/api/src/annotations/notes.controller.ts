import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { type NoteDto, type Page, ProjectPermission as P } from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { PageQueryDto } from '../common/pagination.js';
import {
  CurrentProject,
  ProjectAccessGuard,
  RequireProjectPermission,
} from '../projects/project-access.guard.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import { CreateNoteDto, UpdateNoteDto } from './annotations.dto.js';
import { NotesService } from './notes.service.js';

/**
 * Item notes under `/api/v1/projects/:id/items/:item/notes` (SPEC §8
 * `items/…/notes`).
 *
 * Permissions: every route goes through {@link ProjectAccessGuard}
 * (non-members 404, archived projects read-only). Reading needs a visible
 * item; writing needs `ANNOTATE_ITEMS` (SPEC §3.2 "Notes and attachments",
 * 403 for Viewers and non-member admins before any lookup). Only the author
 * edits a note; the author or a moderator deletes it.
 */
@Controller('projects/:id/items/:item/notes')
@UseGuards(ProjectAccessGuard)
export class NotesController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param notes Note operations.
   */
  constructor(private readonly notes: NotesService) {}

  /**
   * Lists the item's notes, newest first. Permissions: visible items only.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @param query Pagination.
   * @returns One page of notes.
   */
  @Get()
  @RequireProjectPermission(P.VIEW_ITEMS)
  list(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Query() query: PageQueryDto,
  ): Promise<Page<NoteDto>> {
    return this.notes.list(auth, access, item, query);
  }

  /**
   * Adds a note. Permissions: `ANNOTATE_ITEMS` on a visible item.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @param body The note.
   * @returns The new note (201).
   */
  @Post()
  @RequireProjectPermission(P.ANNOTATE_ITEMS)
  create(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Body() body: CreateNoteDto,
  ): Promise<NoteDto> {
    return this.notes.create(auth, access, item, body);
  }

  /**
   * Changes a note. Permissions: its author, with `ANNOTATE_ITEMS`.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @param noteId Note id.
   * @param body The new text.
   * @returns The updated note.
   */
  @Patch(':noteId')
  @RequireProjectPermission(P.ANNOTATE_ITEMS)
  update(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Body() body: UpdateNoteDto,
  ): Promise<NoteDto> {
    return this.notes.update(auth, access, item, noteId, body);
  }

  /**
   * Deletes a note. Permissions: its author, or PMs, Leads and the item's
   * team Leads.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @param noteId Note id.
   * @returns Resolves once deleted (204).
   */
  @Delete(':noteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission(P.ANNOTATE_ITEMS)
  remove(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
  ): Promise<void> {
    return this.notes.remove(auth, access, item, noteId);
  }
}
