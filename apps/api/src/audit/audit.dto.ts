import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PageQueryDto } from '../common/pagination.js';

/** Query string of `GET /admin/audit`. */
export class AuditQueryDto extends PageQueryDto {
  /** Only entries by this actor. */
  @IsOptional()
  @IsUUID()
  actorId?: string;

  /** Only entries with this action. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  action?: string;

  /** Only entries about this entity type. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  entityType?: string;

  /** Only entries about this entity id. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  entityId?: string;

  /** Only entries in this project. */
  @IsOptional()
  @IsUUID()
  projectId?: string;

  /** ISO timestamp; only entries at or after it. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  /** ISO timestamp; only entries before it. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}
