import { Controller, Get, Query } from '@nestjs/common';
import type { AuditEntryDto, Page } from '@kloister/shared';
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AdminOnly } from '../auth/decorators.js';
import { PageQueryDto } from '../common/pagination.js';
import { AuditService } from './audit.service.js';

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

/**
 * Audit log viewer API (SPEC §6 Admin, §8 `admin/audit`).
 *
 * Permissions: admins only.
 */
@Controller('admin/audit')
@AdminOnly()
export class AuditController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param audit Audit log access.
   */
  constructor(private readonly audit: AuditService) {}

  /**
   * Lists audit entries newest first, with optional filters.
   *
   * @param query Filters and pagination.
   * @returns One page of entries.
   */
  @Get()
  list(@Query() query: AuditQueryDto): Promise<Page<AuditEntryDto>> {
    const { cursor, limit, ...filter } = query;
    return this.audit.list(filter, { cursor, limit });
  }
}
