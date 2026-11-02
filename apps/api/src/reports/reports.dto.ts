import { WORKLOAD_WEEKS_MAX } from '@kloister/shared';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { IsCalendarDate } from '../common/dates.js';
import { LowercaseUuid } from '../common/uuid.js';

/** Query string of `GET /projects/:id/reports/sprint`. */
export class SprintReportQueryDto {
  /** Sprint to report on; the active sprint when omitted. */
  @IsOptional()
  @LowercaseUuid()
  @IsUUID()
  sprint?: string;
}

/** Query string of `GET /projects/:id/reports/workload`. */
export class WorkloadQueryDto {
  /** A day in the first week (`YYYY-MM-DD`); this week when omitted. */
  @IsOptional()
  @IsCalendarDate()
  from?: string;

  /** Number of weeks, 1 to 26; default 8. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(WORKLOAD_WEEKS_MAX)
  weeks?: number;
}

/** Query string of `GET /me/calendar`. */
export class CalendarQueryDto {
  /** First day (`YYYY-MM-DD`). */
  @IsCalendarDate()
  from: string;

  /** Last day (`YYYY-MM-DD`), at most 100 days after `from`. */
  @IsCalendarDate()
  to: string;
}
