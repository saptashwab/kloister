import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { queryBoolean } from '../common/dto-helpers.js';
import { PageQueryDto } from '../common/pagination.js';

/** Query of `GET /notifications`. */
export class NotificationsQueryDto extends PageQueryDto {
  /** Only unread notifications (default false: all). */
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  unread?: boolean;
}
