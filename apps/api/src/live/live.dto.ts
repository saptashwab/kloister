import {
  type LivePresenceRequest,
  type LiveSubscribeRequest,
  PRESENCE_FIELDS,
  PresenceAction,
  type PresenceField,
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
}
