import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@kloister/shared';

/**
 * Serves `GET /api/v1/health`.
 *
 * Permissions: deliberately public. It reveals nothing beyond "the process is
 * up", and the start/upgrade scripts must be able to call it without a session.
 */
@Controller('health')
export class HealthController {
  /**
   * Reports that the backend is answering requests.
   *
   * @returns `{ status: 'ok' }` with HTTP 200.
   */
  @Get()
  check(): HealthResponse {
    return { status: 'ok' };
  }
}
