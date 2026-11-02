import {
  PinAction,
  type PreviewedChange,
  RescheduleMode,
  type RescheduleChangeRequest,
  type RescheduleRequest,
  type ScheduleDates,
} from '@kloister/shared';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { IsCalendarDate } from '../common/dates.js';
import { Nullable, OmittableNotNull } from '../common/dto-helpers.js';

/** Most items one reschedule request may name. */
export const RESCHEDULE_MAX_CHANGES = 500;

/** A pin on the wire. */
export class HalfDayDto {
  /** `YYYY-MM-DD`. */
  @IsCalendarDate()
  date!: string;

  /** The 2nd half. */
  @IsBoolean()
  second!: boolean;
}

/** One requested change of `POST /projects/:id/timeline/reschedule`. */
export class RescheduleChangeDto implements RescheduleChangeRequest {
  /** Item uuid or per-project number. */
  @IsString()
  @Length(1, 64)
  item!: string;

  /** New start date, or null. */
  @Nullable()
  @IsCalendarDate()
  startDate?: string | null;

  /** Starts in the 2nd half. */
  @OmittableNotNull()
  @IsBoolean()
  startSecondHalf?: boolean;

  /** New due date, or null. */
  @Nullable()
  @IsCalendarDate()
  dueDate?: string | null;

  /** Finishes after the 1st half. */
  @OmittableNotNull()
  @IsBoolean()
  dueFirstHalf?: boolean;

  /** Pin handling. */
  @OmittableNotNull()
  @IsIn(Object.values(PinAction))
  pin?: PinAction;

  /** An exact pin to restore (Undo), or null for none. */
  @Nullable()
  @ValidateNested()
  @Type(() => HalfDayDto)
  pinTo?: HalfDayDto | null;
}

/** Scheduling fields of a previewed move. */
export class ScheduleDatesDto implements ScheduleDates {
  /** Start date, or null. */
  @Nullable()
  @IsCalendarDate()
  startDate!: string | null;

  /** Starts in the 2nd half. */
  @IsBoolean()
  startSecondHalf!: boolean;

  /** Due date, or null. */
  @Nullable()
  @IsCalendarDate()
  dueDate!: string | null;

  /** Finishes after the 1st half. */
  @IsBoolean()
  dueFirstHalf!: boolean;
}

/** A move the caller saw in the preview. */
export class PreviewedChangeDto implements PreviewedChange {
  /** Item id. */
  @IsString()
  @Length(1, 64)
  id!: string;

  /** Dates shown. */
  @ValidateNested()
  @Type(() => ScheduleDatesDto)
  to!: ScheduleDatesDto;
}

/** Body of `POST /projects/:id/timeline/reschedule`. */
export class RescheduleDto implements RescheduleRequest {
  /** Changes asked for. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(RESCHEDULE_MAX_CHANGES)
  @ValidateNested({ each: true })
  @Type(() => RescheduleChangeDto)
  changes!: RescheduleChangeDto[];

  /** Preview, apply, or apply only the changes. */
  @IsIn(Object.values(RescheduleMode))
  mode!: RescheduleMode;

  /** Versions the caller saw, by item id. */
  @OmittableNotNull()
  @IsObject()
  expect?: Record<string, string>;

  /** The moves a preview showed. */
  @OmittableNotNull()
  @IsArray()
  @ArrayMaxSize(RESCHEDULE_MAX_CHANGES * 4)
  @ValidateNested({ each: true })
  @Type(() => PreviewedChangeDto)
  previewed?: PreviewedChangeDto[];
}
