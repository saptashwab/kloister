import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { queryBoolean } from '../common/dto-helpers.js';
import { PageQueryDto } from '../common/pagination.js';

/** Query of `GET /users/:userId/work`. */
export class WorkQueryDto extends PageQueryDto {
  /** Include Done items (default false: open work only). */
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  includeDone?: boolean;
}
