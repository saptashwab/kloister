import { Transform } from 'class-transformer';
import { ItemType } from '@kloister/shared';
import { IsBoolean, IsOptional, IsIn, IsUUID, IsDateString, Matches } from 'class-validator';
import { queryBoolean } from '../common/dto-helpers.js';
import { LowercaseUuid } from '../common/uuid.js';
import { PageQueryDto } from '../common/pagination.js';

/** Query of `GET /users/:userId/work`. */
export class WorkQueryDto extends PageQueryDto {
  /** Include Done items (default false: open work only). */
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  includeDone?: boolean;

  /** Include project items created by the selected person. */
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  includeCreated?: boolean;

  /** My work source; other people's personal work is never included. */
  @IsOptional()
  @IsIn(['ALL', 'PROJECTS', 'PERSONAL'])
  source?: 'ALL' | 'PROJECTS' | 'PERSONAL';

  /** Restrict to a readable project; inaccessible ids return no matches. */
  @IsOptional()
  @LowercaseUuid()
  @IsUUID()
  projectId?: string;

  /** Item type. */
  @IsOptional()
  @IsIn(Object.values(ItemType))
  type?: ItemType;

  /** Per-project label id. */
  @IsOptional()
  @LowercaseUuid()
  @IsUUID()
  labelId?: string;

  /** Inclusive due-date lower bound. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  dueFrom?: string;

  /** Inclusive due-date upper bound. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  dueTo?: string;
}
