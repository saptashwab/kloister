import {
  type AddDependencyRequest,
  CHECKLIST_TEXT_MAX,
  type CreateChecklistItemRequest,
  type CreateItemRequest,
  ITEM_DESCRIPTION_MAX,
  ITEM_TITLE_MAX,
  ItemStatus,
  ItemType,
  MAX_ASSIGNEES,
  MAX_ITEM_LABELS,
  type MoveItemRequest,
  PRIORITY_MAX,
  PRIORITY_MIN,
  type UpdateChecklistItemRequest,
  type UpdateItemRequest,
} from '@kloister/shared';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  isUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateBy,
} from 'class-validator';
import { IsCalendarDate, IsDueTime } from '../common/dates.js';
import { Nullable, OmittableNotNull, queryBoolean, trim } from '../common/dto-helpers.js';
import { PageQueryDto } from '../common/pagination.js';
import { LowercaseUuid } from '../common/uuid.js';

/** Query value meaning "items without one", e.g. `sprintId=none` for the backlog. */
export const NONE = 'none';

/**
 * Accepts a uuid or the word `none`.
 *
 * @returns The property decorator.
 */
const IsUuidOrNone = (): PropertyDecorator =>
  ValidateBy({
    name: 'isUuidOrNone',
    validator: {
      validate: (value: unknown) => value === NONE || (typeof value === 'string' && isUUID(value)),
      defaultMessage: () => '$property must be a uuid or "none"',
    },
  });

/** Query string of `GET /projects/:id/items`. Every filter narrows the caller's scope further. */
export class ListItemsQueryDto extends PageQueryDto {
  /** Only this type. */
  @IsOptional()
  @IsIn(Object.values(ItemType))
  type?: ItemType;

  /** Only this status. */
  @IsOptional()
  @IsIn(Object.values(ItemStatus))
  status?: ItemStatus;

  /** Only this bucket, or `none`. */
  @IsOptional()
  @LowercaseUuid()
  @IsUuidOrNone()
  bucketId?: string;

  /** Only this sprint, or `none` (backlog). */
  @IsOptional()
  @LowercaseUuid()
  @IsUuidOrNone()
  sprintId?: string;

  /** Only this team, or `none`. */
  @IsOptional()
  @LowercaseUuid()
  @IsUuidOrNone()
  teamId?: string;

  /** Only children of this item, or `none` for top-level items. */
  @IsOptional()
  @LowercaseUuid()
  @IsUuidOrNone()
  parentId?: string;

  /** Only items assigned to this user. */
  @IsOptional()
  @LowercaseUuid()
  @IsUUID()
  assigneeId?: string;

  /** Only items with this label. */
  @IsOptional()
  @LowercaseUuid()
  @IsUUID()
  labelId?: string;

  /** Due on or after this date. */
  @IsOptional()
  @IsCalendarDate()
  dueFrom?: string;

  /** Due on or before this date. */
  @IsOptional()
  @IsCalendarDate()
  dueTo?: string;

  /** Case-insensitive title search; a number also matches the item number. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /** `number` (default) or `position` (board order). */
  @IsOptional()
  @IsIn(['number', 'position'])
  sort?: 'number' | 'position';
}

/** Body of `POST /projects/:id/items`. */
export class CreateItemDto implements CreateItemRequest {
  /** Item type. */
  @IsIn(Object.values(ItemType))
  type: ItemType;

  /** Title. */
  @Transform(trim)
  @IsString()
  @Length(1, ITEM_TITLE_MAX)
  title: string;

  /** HTML description; sanitized before storing. */
  @OmittableNotNull()
  @IsString()
  @MaxLength(ITEM_DESCRIPTION_MAX)
  description?: string;

  /** Parent item. */
  @Nullable()
  @LowercaseUuid()
  @IsUUID()
  parentId?: string | null;

  /** Initial status. */
  @OmittableNotNull()
  @IsIn(Object.values(ItemStatus))
  status?: ItemStatus;

  /** Priority. */
  @OmittableNotNull()
  @IsInt()
  @Min(PRIORITY_MIN)
  @Max(PRIORITY_MAX)
  priority?: number;

  /** Bucket. */
  @Nullable()
  @LowercaseUuid()
  @IsUUID()
  bucketId?: string | null;

  /** Sprint. */
  @Nullable()
  @LowercaseUuid()
  @IsUUID()
  sprintId?: string | null;

  /** Team. */
  @Nullable()
  @LowercaseUuid()
  @IsUUID()
  teamId?: string | null;

  /** Start date. */
  @Nullable()
  @IsCalendarDate()
  startDate?: string | null;

  /** Due date. */
  @Nullable()
  @IsCalendarDate()
  dueDate?: string | null;

  /** Due time `HH:MM` on the due date. */
  @Nullable()
  @IsDueTime()
  dueTime?: string | null;

  /** Assignees. */
  @OmittableNotNull()
  @IsArray()
  @ArrayMaxSize(MAX_ASSIGNEES)
  @ArrayUnique()
  @LowercaseUuid()
  @IsUUID('all', { each: true })
  assigneeIds?: string[];

  /** Labels. */
  @OmittableNotNull()
  @IsArray()
  @ArrayMaxSize(MAX_ITEM_LABELS)
  @ArrayUnique()
  @LowercaseUuid()
  @IsUUID('all', { each: true })
  labelIds?: string[];
}

/** Body of `PATCH /projects/:id/items/:item`. */
export class UpdateItemDto implements UpdateItemRequest {
  /** New type. */
  @OmittableNotNull()
  @IsIn(Object.values(ItemType))
  type?: ItemType;

  /** New title. */
  @OmittableNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, ITEM_TITLE_MAX)
  title?: string;

  /** New description. */
  @OmittableNotNull()
  @IsString()
  @MaxLength(ITEM_DESCRIPTION_MAX)
  description?: string;

  /** New parent, or null. */
  @Nullable()
  @LowercaseUuid()
  @IsUUID()
  parentId?: string | null;

  /** New status. */
  @OmittableNotNull()
  @IsIn(Object.values(ItemStatus))
  status?: ItemStatus;

  /** New priority. */
  @OmittableNotNull()
  @IsInt()
  @Min(PRIORITY_MIN)
  @Max(PRIORITY_MAX)
  priority?: number;

  /** New sprint, or null. */
  @Nullable()
  @LowercaseUuid()
  @IsUUID()
  sprintId?: string | null;

  /** New team, or null. */
  @Nullable()
  @LowercaseUuid()
  @IsUUID()
  teamId?: string | null;

  /** New start date, or null. */
  @Nullable()
  @IsCalendarDate()
  startDate?: string | null;

  /** New due date, or null. */
  @Nullable()
  @IsCalendarDate()
  dueDate?: string | null;

  /** New due time `HH:MM`, or null; needs a due date. */
  @Nullable()
  @IsDueTime()
  dueTime?: string | null;

  /** Full assignee list. */
  @OmittableNotNull()
  @IsArray()
  @ArrayMaxSize(MAX_ASSIGNEES)
  @ArrayUnique()
  @LowercaseUuid()
  @IsUUID('all', { each: true })
  assigneeIds?: string[];

  /** Full label list. */
  @OmittableNotNull()
  @IsArray()
  @ArrayMaxSize(MAX_ITEM_LABELS)
  @ArrayUnique()
  @LowercaseUuid()
  @IsUUID('all', { each: true })
  labelIds?: string[];
}

/** Body of `POST /projects/:id/items/:item/move`. */
export class MoveItemDto implements MoveItemRequest {
  /** Target bucket; omitted keeps the bucket, null takes an Epic/Feature off the board. */
  @Nullable()
  @LowercaseUuid()
  @IsUUID()
  bucketId?: string | null;

  /** Item to place the card after; omitted or null for the top. */
  @Nullable()
  @LowercaseUuid()
  @IsUUID()
  afterId?: string | null;
}

/** Query of `DELETE /projects/:id/items/:item`. */
export class DeleteItemQueryDto {
  /** Delete the item's whole subtree too (SPEC §4.1; PM and Lead only). */
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  cascade?: boolean;
}

/** Body of `POST /projects/:id/items/:item/dependencies`. */
export class AddDependencyDto implements AddDependencyRequest {
  /** The item that blocks this one. */
  @LowercaseUuid()
  @IsUUID()
  blockingItemId: string;
}

/** Body of `POST /projects/:id/items/:item/checklist`. */
export class CreateChecklistItemDto implements CreateChecklistItemRequest {
  /** Text. */
  @Transform(trim)
  @IsString()
  @Length(1, CHECKLIST_TEXT_MAX)
  text: string;

  /** Initially ticked. */
  @OmittableNotNull()
  @IsBoolean()
  done?: boolean;
}

/** Body of `PATCH /projects/:id/items/:item/checklist/:lineId`. */
export class UpdateChecklistItemDto implements UpdateChecklistItemRequest {
  /** New text. */
  @OmittableNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, CHECKLIST_TEXT_MAX)
  text?: string;

  /** Tick or untick. */
  @OmittableNotNull()
  @IsBoolean()
  done?: boolean;
}
