import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import {
  type AttachmentDto,
  type CreateNoteRequest,
  FILE_NAME_HEADER,
  type InlineImageDto,
  type NoteDto,
  type Page,
  type UpdateNoteRequest,
  UPLOAD_CONTENT_TYPE,
} from '@kloister/shared';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from './api';

/**
 * Client for an item's notes, attachments and inline images under
 * `/projects/:id/items/:item/…` (SPEC §6).
 *
 * Uploads send the raw file as the body with its name in the `x-file-name`
 * header. The API decides every permission (SPEC §3.4) and checks file types
 * by content; the UI only hides controls using `can` and the item's
 * `can.annotate`.
 */
@Injectable({ providedIn: 'root' })
export class AnnotationsApiService {
  private readonly http = inject(HttpClient);

  /**
   * Lists one page of an item's notes, newest first.
   *
   * @param projectId Project id.
   * @param itemId Item id.
   * @param cursor Cursor from the previous page.
   * @returns One page of notes.
   */
  notes(projectId: string, itemId: string, cursor?: string): Promise<Page<NoteDto>> {
    return this.page(`projects/${projectId}/items/${itemId}/notes`, cursor);
  }

  /**
   * Adds a note.
   *
   * @param projectId Project id.
   * @param itemId Item id.
   * @param request The note's HTML.
   * @returns The new note.
   */
  addNote(projectId: string, itemId: string, request: CreateNoteRequest): Promise<NoteDto> {
    return firstValueFrom(
      this.http.post<NoteDto>(apiUrl(`projects/${projectId}/items/${itemId}/notes`), request),
    );
  }

  /**
   * Changes a note (its author only).
   *
   * @param projectId Project id.
   * @param itemId Item id.
   * @param noteId Note id.
   * @param request The new HTML.
   * @returns The updated note.
   */
  updateNote(
    projectId: string,
    itemId: string,
    noteId: string,
    request: UpdateNoteRequest,
  ): Promise<NoteDto> {
    return firstValueFrom(
      this.http.patch<NoteDto>(
        apiUrl(`projects/${projectId}/items/${itemId}/notes/${noteId}`),
        request,
      ),
    );
  }

  /**
   * Deletes a note.
   *
   * @param projectId Project id.
   * @param itemId Item id.
   * @param noteId Note id.
   * @returns Resolves once deleted.
   */
  removeNote(projectId: string, itemId: string, noteId: string): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(apiUrl(`projects/${projectId}/items/${itemId}/notes/${noteId}`)),
    );
  }

  /**
   * Lists one page of an item's attachments, newest first.
   *
   * @param projectId Project id.
   * @param itemId Item id.
   * @param cursor Cursor from the previous page.
   * @returns One page of attachments.
   */
  attachments(projectId: string, itemId: string, cursor?: string): Promise<Page<AttachmentDto>> {
    return this.page(`projects/${projectId}/items/${itemId}/attachments`, cursor);
  }

  /**
   * Uploads an attachment.
   *
   * @param projectId Project id.
   * @param itemId Item id.
   * @param file The file.
   * @returns The attachment.
   */
  attach(projectId: string, itemId: string, file: File): Promise<AttachmentDto> {
    return this.upload(`projects/${projectId}/items/${itemId}/attachments`, file);
  }

  /**
   * Deletes an attachment.
   *
   * @param projectId Project id.
   * @param itemId Item id.
   * @param attachmentId Attachment id.
   * @returns Resolves once deleted.
   */
  removeAttachment(projectId: string, itemId: string, attachmentId: string): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(
        apiUrl(`projects/${projectId}/items/${itemId}/attachments/${attachmentId}`),
      ),
    );
  }

  /**
   * Uploads an image pasted or dropped into the item's description or a
   * note; the answer's `url` is the image source to insert.
   *
   * @param projectId Project id.
   * @param itemId Item id.
   * @param file The image.
   * @returns The stored image.
   */
  addImage(projectId: string, itemId: string, file: File): Promise<InlineImageDto> {
    return this.upload(`projects/${projectId}/items/${itemId}/images`, file);
  }

  /**
   * Sends a file as the raw request body.
   *
   * @param path Path below `/api/v1`.
   * @param file The file.
   * @returns The API's answer.
   */
  private upload<T>(path: string, file: File): Promise<T> {
    return firstValueFrom(
      this.http.post<T>(apiUrl(path), file, {
        headers: {
          'Content-Type': UPLOAD_CONTENT_TYPE,
          [FILE_NAME_HEADER]: encodeURIComponent(file.name || 'file'),
        },
      }),
    );
  }

  /**
   * Fetches one page of a list.
   *
   * @param path Path below `/api/v1`.
   * @param cursor Cursor, if any.
   * @returns The page.
   */
  private page<T>(path: string, cursor: string | undefined): Promise<Page<T>> {
    const params = cursor === undefined ? new HttpParams() : new HttpParams().set('cursor', cursor);
    return firstValueFrom(this.http.get<Page<T>>(apiUrl(path), { params }));
  }
}
