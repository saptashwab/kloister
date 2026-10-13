import { type CreateNoteRequest, NOTE_BODY_MAX, type UpdateNoteRequest } from '@kloister/shared';
import { IsString, MaxLength } from 'class-validator';

/** Body of `POST /projects/:id/items/:item/notes`. */
export class CreateNoteDto implements CreateNoteRequest {
  /** HTML; sanitized by the server (SPEC §5). */
  @IsString()
  @MaxLength(NOTE_BODY_MAX)
  body: string;
}

/** Body of `PATCH /projects/:id/items/:item/notes/:noteId`. */
export class UpdateNoteDto implements UpdateNoteRequest {
  /** New HTML; sanitized by the server. */
  @IsString()
  @MaxLength(NOTE_BODY_MAX)
  body: string;
}
