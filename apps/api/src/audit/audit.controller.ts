import { Controller, Get, Query } from '@nestjs/common';
import type { AuditEntryDto, Page } from '@kloister/shared';
import { AdminOnly } from '../auth/decorators.js';
import { AuditQueryDto } from './audit.dto.js';
import { AuditService } from './audit.service.js';

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
