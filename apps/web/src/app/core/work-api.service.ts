import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { UserWorkDto } from '@kloister/shared';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from './api';

/**
 * Client for `GET /users/:userId/work` ("all their work", SPEC §6). The API
 * limits the list to the caller's projects and their scope in each.
 */
@Injectable({ providedIn: 'root' })
export class WorkApiService {
  private readonly http = inject(HttpClient);

  /**
   * Loads one page of a person's work.
   *
   * @param userId The person, or `me` for the caller-only endpoint.
   * @param options Cursor and whether to include Done items.
   * @param options.cursor Cursor from the previous page.
   * @param options.includeDone Include Done items.
   * @param options.includeCreated Include created items.
   * @returns The person and the page.
   */
  list(
    userId: string,
    options: { cursor?: string; includeDone?: boolean; includeCreated?: boolean } = {},
  ): Promise<UserWorkDto> {
    let params = new HttpParams();
    if (options.cursor) params = params.set('cursor', options.cursor);
    if (options.includeDone) params = params.set('includeDone', 'true');
    if (options.includeCreated) params = params.set('includeCreated', 'true');
    return firstValueFrom(
      this.http.get<UserWorkDto>(
        apiUrl(userId === 'me' ? 'me/work' : `users/${encodeURIComponent(userId)}/work`),
        { params },
      ),
    );
  }
}
