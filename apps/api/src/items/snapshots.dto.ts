import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';
import { queryBoolean } from '../common/dto-helpers.js';
import { IsCalendarDate } from '../common/dates.js';
import { LowercaseUuid } from '../common/uuid.js';
import { ListItemsQueryDto } from './items.dto.js';

/** Snapshot narrowing filters; all scope removes narrowing but preserves source membership. */
export class SnapshotQueryDto extends ListItemsQueryDto {
  /** Filtered board shows only items on a board; all-eligible includes off-board items. */
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  boardOnly?: boolean;
  /** Filtered board's unassigned chip. */
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  unassigned?: boolean;
  /** Filtered screen or every eligible item from the same source. */
  @IsOptional()
  @IsIn(['filtered', 'all'])
  scope?: 'filtered' | 'all';
  /** Include permitted files and original rich text for offline reading. */
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  offline?: boolean;
  /** My work source retained in both scope modes. */
  @IsOptional()
  @IsIn(['ALL', 'PROJECTS', 'PERSONAL'])
  source?: 'ALL' | 'PROJECTS' | 'PERSONAL';
  /** My work's created-item option, retained in both scope modes. */
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  includeCreated?: boolean;
  /** My work's Done option, retained in both scope modes. */
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  includeDone?: boolean;
  /** Narrow My work to a project. */
  @IsOptional()
  @LowercaseUuid()
  @IsUUID()
  projectId?: string;
  /** Named due group from the work screen. */
  @IsOptional()
  @IsIn(['Overdue', 'Today', 'This week', 'Later', 'No date'])
  dueGroup?: string;
  /** Viewer's calendar day used for work due grouping. */
  @IsOptional()
  @IsCalendarDate()
  today?: string;
}
