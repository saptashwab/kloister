import { API_PREFIX } from './api.js';

/** Longest note accepted, in characters of (sanitized) HTML. */
export const NOTE_BODY_MAX = 20_000;

/** Longest attachment file name kept; longer names are shortened. */
export const ATTACHMENT_NAME_MAX = 255;

/**
 * Request header carrying an uploaded file's name, percent-encoded UTF-8
 * (`encodeURIComponent`). Uploads send the raw file as the request body.
 */
export const FILE_NAME_HEADER = 'x-file-name';

/** Content type of upload request bodies: the raw file bytes. */
export const UPLOAD_CONTENT_TYPE = 'application/octet-stream';

/**
 * Image types accepted for images pasted or dropped into descriptions and
 * notes (SPEC §5). Checked by content, never by name; SVG is never accepted.
 */
export const INLINE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** One of the {@link INLINE_IMAGE_TYPES}. */
export type InlineImageType = (typeof INLINE_IMAGE_TYPES)[number];

/**
 * The app-relative URL of an inline image: the only image source the rich
 * text sanitizer keeps, and only in the description and notes of the same
 * item (SPEC §5). Relative, so it resolves under the app's base href.
 *
 * @param projectId Project id (uuid).
 * @param itemId Item id (uuid).
 * @param imageId Image id (uuid).
 * @returns E.g. `api/v1/projects/<p>/items/<i>/images/<id>`.
 */
export function inlineImagePath(projectId: string, itemId: string, imageId: string): string {
  return `${API_PREFIX}/projects/${projectId}/items/${itemId}/images/${imageId}`;
}

/** What the caller may do with a note or attachment; the UI only hides controls. */
export interface AnnotationCapabilitiesDto {
  /** Change the note (its author only). Always false for attachments. */
  edit: boolean;
  /** Delete it (its author, or a moderator: PMs, Leads and the item's team Leads). */
  delete: boolean;
}

/** A note on a work item, from `GET …/items/:item/notes`. */
export interface NoteDto {
  /** Note id (uuid). */
  id: string;
  /** Author's user id. */
  authorId: string;
  /** Author's display name. */
  authorName: string;
  /**
   * Sanitized HTML. Mentions are `<span data-mention="<userId>">@Name</span>`;
   * images point at the item's own inline-image endpoint.
   */
  body: string;
  /** ISO timestamp of the last edit, or null if never edited. */
  editedAt: string | null;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** What the caller may do with it. */
  can: AnnotationCapabilitiesDto;
}

/** Body of `POST …/items/:item/notes`. */
export interface CreateNoteRequest {
  /** HTML; sanitized by the server. */
  body: string;
}

/** Body of `PATCH …/items/:item/notes/:noteId` (author only). */
export interface UpdateNoteRequest {
  /** New HTML; sanitized by the server. */
  body: string;
}

/** A file attached to a work item, from `GET …/items/:item/attachments`. */
export interface AttachmentDto {
  /** Attachment id (uuid). */
  id: string;
  /** The file name as uploaded (cleaned of path parts and control characters). */
  name: string;
  /** Size in bytes. */
  sizeBytes: number;
  /** Type detected from the content; `application/octet-stream` when unknown. */
  mimeType: string;
  /** Uploader's user id. */
  uploaderId: string;
  /** Uploader's display name. */
  uploaderName: string;
  /** ISO timestamp of the upload. */
  createdAt: string;
  /** App-relative download URL (served as a download, never shown inline). */
  url: string;
  /** What the caller may do with it. */
  can: AnnotationCapabilitiesDto;
}

/** Answer to an inline image upload (`POST …/items/:item/images`). */
export interface InlineImageDto {
  /** Image id (uuid). */
  id: string;
  /** App-relative URL to use as the `<img>` source; see {@link inlineImagePath}. */
  url: string;
  /** The file name, for the image's alternative text. */
  name: string;
  /** Detected image type. */
  mimeType: InlineImageType;
  /** Size in bytes. */
  sizeBytes: number;
}

/**
 * In-app notification types (SPEC §6). Due-date notifications come from the
 * daily check at 09:00 server time.
 */
export const NotificationType = {
  /** Someone else assigned the item to you. */
  ASSIGNED: 'ASSIGNED',
  /** Someone mentioned you in a note. */
  MENTIONED: 'MENTIONED',
  /** An item assigned to you is due tomorrow. */
  DUE_TOMORROW: 'DUE_TOMORROW',
  /** An item assigned to you is overdue. */
  OVERDUE: 'OVERDUE',
  /** Someone else changed the status of an item you created. */
  STATUS_CHANGED: 'STATUS_CHANGED',
} as const;

/** One of the {@link NotificationType} values. */
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

/** The item a notification is about, as the recipient sees it now. */
export interface NotificationItemDto {
  /** Item id (uuid). */
  id: string;
  /** Per-project number. */
  number: number;
  /** Display key, e.g. `KLO-42`. */
  key: string;
  /** Title. */
  title: string;
  /** Project key, for the link `/p/<projectKey>/items/<number>`. */
  projectKey: string | null;
}

/** A notification, from `GET /notifications`. */
export interface NotificationDto {
  /** Notification id (uuid). */
  id: string;
  /** What happened. */
  type: NotificationType;
  /** The item. */
  item: NotificationItemDto;
  /** Who caused it; null for due-date notifications or removed accounts. */
  actor: { id: string; displayName: string } | null;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp when read, or null while unread. */
  readAt: string | null;
}

/** Answer of `GET /notifications/unread-count`. */
export interface UnreadCountDto {
  /** Unread notifications the caller can still open. */
  count: number;
}

/** How often the web app asks for the unread count, in milliseconds (SPEC §6). */
export const NOTIFICATION_POLL_MS = 60_000;
