import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { OutlineMoveRequest, WorkItemDetailDto } from '@kloister/shared';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../../core/api';

/**
 * Places items in the plan outline (v1.3.1). Kept with the timeline, its only
 * user, so the first-load bundle stays within its budget.
 */
@Injectable({ providedIn: 'root' })
export class OutlineApiService {
  private readonly http = inject(HttpClient);

  /**
   * Places an item among its siblings, optionally under a new parent and type
   * (needs `can.plan`).
   *
   * @param projectId Project id.
   * @param item Item id or number.
   * @param request New parent, type and the sibling to follow.
   * @returns The item in its new place.
   */
  outline(
    projectId: string,
    item: string | number,
    request: OutlineMoveRequest,
  ): Promise<WorkItemDetailDto> {
    return firstValueFrom(
      this.http.post<WorkItemDetailDto>(
        apiUrl(`projects/${projectId}/items/${item}/outline`),
        request,
      ),
    );
  }
}
