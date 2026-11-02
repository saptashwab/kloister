import {
  type CreateHolidayRequest,
  HOLIDAY_NAME_MAX,
  type ReviewHolidaysRequest,
} from '@kloister/shared';
import { Transform } from 'class-transformer';
import { IsISO8601, IsString, Length } from 'class-validator';
import { IsCalendarDate } from '../common/dates.js';
import { OmittableNotNull, trim } from '../common/dto-helpers.js';

/** Body of `POST /projects/:id/holidays` and `POST /admin/holidays`. */
export class CreateHolidayDto implements CreateHolidayRequest {
  /** Name. */
  @Transform(trim)
  @IsString()
  @Length(1, HOLIDAY_NAME_MAX)
  name!: string;

  /** First day. */
  @IsCalendarDate()
  startDate!: string;

  /** Last day, inclusive. */
  @IsCalendarDate()
  endDate!: string;
}

/** Body of `POST /projects/:id/holidays/reviewed`. */
export class ReviewHolidaysDto implements ReviewHolidaysRequest {
  /** The newest instance change the caller saw (ISO timestamp); default now. */
  @OmittableNotNull()
  @IsISO8601({ strict: true })
  through?: string;
}
