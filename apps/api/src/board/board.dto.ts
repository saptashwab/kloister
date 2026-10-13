import {
  BOARD_NAME_MAX,
  BucketRule,
  type CloseSprintRequest,
  type CreateBucketRequest,
  type CreateLabelRequest,
  type CreateSprintRequest,
  ITERATION_PATH_MAX,
  ItemStatus,
  LABEL_COLOUR_PATTERN,
  type ReorderRequest,
  type UpdateBucketRequest,
  type UpdateLabelRequest,
  type UpdateSprintRequest,
} from '@kloister/shared';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { IsCalendarDate } from '../common/dates.js';
import { Nullable, OmittableNotNull, trim } from '../common/dto-helpers.js';
import { LowercaseUuid } from '../common/uuid.js';

/** Body of `POST /projects/:id/buckets`. */
export class CreateBucketDto implements CreateBucketRequest {
  /** Name. */
  @Transform(trim)
  @IsString()
  @Length(1, BOARD_NAME_MAX)
  name: string;

  /** Entry rule; default `NONE`. */
  @OmittableNotNull()
  @IsIn(Object.values(BucketRule))
  onEnterMode?: BucketRule;

  /** Status set by the rule. */
  @Nullable()
  @IsIn(Object.values(ItemStatus))
  onEnterStatus?: ItemStatus | null;
}

/** Body of `PATCH /projects/:id/buckets/:bucketId`. */
export class UpdateBucketDto implements UpdateBucketRequest {
  /** New name. */
  @OmittableNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, BOARD_NAME_MAX)
  name?: string;

  /** New entry rule. */
  @OmittableNotNull()
  @IsIn(Object.values(BucketRule))
  onEnterMode?: BucketRule;

  /** New rule status. */
  @Nullable()
  @IsIn(Object.values(ItemStatus))
  onEnterStatus?: ItemStatus | null;
}

/** Query of `DELETE /projects/:id/buckets/:bucketId`. */
export class DeleteBucketQueryDto {
  /** Bucket that receives the deleted bucket's items. */
  @IsOptional()
  @LowercaseUuid()
  @IsUUID()
  moveItemsTo?: string;
}

/** Body of the reorder endpoints. */
export class ReorderDto implements ReorderRequest {
  /** Row to place this one after; omit or null for the first place. */
  @Nullable()
  @LowercaseUuid()
  @IsUUID()
  afterId?: string | null;
}

/** Body of `POST /projects/:id/labels`. */
export class CreateLabelDto implements CreateLabelRequest {
  /** Name. */
  @Transform(trim)
  @IsString()
  @Length(1, BOARD_NAME_MAX)
  name: string;

  /** `#rrggbb`. */
  @IsString()
  @Matches(LABEL_COLOUR_PATTERN, { message: 'colour must be #rrggbb' })
  colour: string;
}

/** Body of `PATCH /projects/:id/labels/:labelId`. */
export class UpdateLabelDto implements UpdateLabelRequest {
  /** New name. */
  @OmittableNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, BOARD_NAME_MAX)
  name?: string;

  /** New colour. */
  @OmittableNotNull()
  @IsString()
  @Matches(LABEL_COLOUR_PATTERN, { message: 'colour must be #rrggbb' })
  colour?: string;
}

/** Body of `POST /projects/:id/sprints`. */
export class CreateSprintDto implements CreateSprintRequest {
  /** Name. */
  @Transform(trim)
  @IsString()
  @Length(1, BOARD_NAME_MAX)
  name: string;

  /** `YYYY-MM-DD`. */
  @IsCalendarDate()
  startDate: string;

  /** `YYYY-MM-DD`. */
  @IsCalendarDate()
  endDate: string;

  /** ADO iteration path override. */
  @Nullable()
  @Transform(trim)
  @IsString()
  @Length(1, ITERATION_PATH_MAX)
  adoIterationPath?: string | null;
}

/** Body of `PATCH /projects/:id/sprints/:sprintId`. */
export class UpdateSprintDto implements UpdateSprintRequest {
  /** New name. */
  @OmittableNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, BOARD_NAME_MAX)
  name?: string;

  /** New start date. */
  @OmittableNotNull()
  @IsCalendarDate()
  startDate?: string;

  /** New end date. */
  @OmittableNotNull()
  @IsCalendarDate()
  endDate?: string;

  /** New override, or null to clear. */
  @Nullable()
  @Transform(trim)
  @IsString()
  @Length(1, ITERATION_PATH_MAX)
  adoIterationPath?: string | null;
}

/** Body of `POST /projects/:id/sprints/:sprintId/close`. */
export class CloseSprintDto implements CloseSprintRequest {
  /** Open sprint for unfinished items, null for the backlog, omitted to leave them. */
  @Nullable()
  @LowercaseUuid()
  @IsUUID()
  moveUnfinishedTo?: string | null;
}
