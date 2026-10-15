import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import { ITEM_TITLE_MAX, MAX_ASSIGNEES } from '@kloister/shared';
import { Nullable, trim } from '../common/dto-helpers.js';
import { LowercaseUuid } from '../common/uuid.js';

/** One independent item in an explicitly confirmed duplication preview. */
export class CopyDto {
  /** Resulting title. */
  @Transform(trim)
  @IsString()
  @Length(1, ITEM_TITLE_MAX)
  title: string;
  /** Optional assignees, checked by ordinary creation permissions. */
  @IsArray()
  @ArrayMaxSize(MAX_ASSIGNEES)
  @ArrayUnique()
  @LowercaseUuid()
  @IsUUID(undefined, { each: true })
  assigneeIds: string[];
}

/** Same-space copy options; no caller-selected source project or copied progress. */
export class DuplicateDto {
  /** Every previewed copy, confirmed together. */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CopyDto)
  copies: CopyDto[];
  /** Explicit destination bucket, including off-board for compatible types. */
  @Nullable()
  @LowercaseUuid()
  @IsUUID()
  bucketId?: string | null;
  /** Explicit optional team; ordinary creation rules apply. */
  @Nullable()
  @LowercaseUuid()
  @IsUUID()
  teamId?: string | null;
  /** Optional readable parent compatible with the copied type. */
  @Nullable()
  @LowercaseUuid()
  @IsUUID()
  parentId?: string | null;
  /** Keep both calendar dates only when requested. */
  @IsOptional()
  @IsBoolean()
  keepDates?: boolean;
  /** Keep the source's open sprint only when requested. */
  @IsOptional()
  @IsBoolean()
  keepSprint?: boolean;
  /** Copy non-inline attachments only when requested. */
  @IsOptional()
  @IsBoolean()
  attachments?: boolean;
}
