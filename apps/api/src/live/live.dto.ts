import {
  type LivePresenceRequest,
  type LiveSubscribeRequest,
  type LiveWorkRequest,
  PRESENCE_FIELDS,
  PRESENCE_VIEWS,
  PresenceAction,
  type PresenceField,
  type PresenceView,
} from '@kloister/shared';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import { LowercaseUuid } from '../common/uuid.js';

/** Body of `PUT /events/:streamId/project`. */
export class LiveSubscribeDto implements LiveSubscribeRequest {
  /** Project id or key, or null to follow none. */
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(64)
  projectId: string | null;
}

/** Body of `PUT /events/:streamId/work` (v1.4.0). */
export class LiveWorkDto implements LiveWorkRequest {
  /** The person whose work the tab lists, or null for the caller's own. */
  @ValidateIf((_o, value) => value !== null)
  @LowercaseUuid()
  @IsUUID()
  userId: string | null;
}

/** Body of `PUT /events/:streamId/presence`. */
export class LivePresenceDto implements LivePresenceRequest {
  /** Item open, or null. */
  @ValidateIf((_o, value) => value !== null)
  @LowercaseUuid()
  @IsUUID()
  itemId: string | null;

  /** What the tab does on it. */
  @ValidateIf((_o, value) => value !== null)
  @IsIn(Object.values(PresenceAction))
  action: PresenceAction | null;

  /** Field being edited; only known field keys, so no free text travels. */
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsIn(Object.keys(PRESENCE_FIELDS))
  field: PresenceField | null;

  /** Project page the tab shows; only known page keys, so no free text travels. */
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsIn(Object.keys(PRESENCE_VIEWS))
  view?: PresenceView | null;
}
