import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  ItemPreviewDto,
  ItemReferrerDto,
  RestoreBatchResult,
  TrashBatchDto,
} from '@kloister/shared';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from './api';

/**
 * The trash and item references of the API (M12). Kept apart from
 * {@link ItemsApiService} so only the pages that use them download them.
 */
@Injectable({ providedIn: 'root' })
export class TrashApiService {
  private readonly http = inject(HttpClient);

  /**
   * Lists the project's trash, newest batch first (M12).
   *
   * @param projectId Project id.
   * @returns The delete batches with the caller's visible items.
   */
  trash(projectId: string): Promise<TrashBatchDto[]> {
    return firstValueFrom(this.http.get<TrashBatchDto[]>(apiUrl(`projects/${projectId}/trash`)));
  }

  /**
   * Restores a delete batch (M12).
   *
   * @param projectId Project id.
   * @param batchId Delete batch.
   * @returns How many items came back.
   */
  restore(projectId: string, batchId: string): Promise<RestoreBatchResult> {
    return firstValueFrom(
      this.http.post<RestoreBatchResult>(
        apiUrl(`projects/${projectId}/trash/${batchId}/restore`),
        {},
      ),
    );
  }

  /**
   * Deletes a batch for good (PMs, M12).
   *
   * @param projectId Project id.
   * @param batchId Delete batch.
   * @returns Resolves once removed.
   */
  purge(projectId: string, batchId: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(apiUrl(`projects/${projectId}/trash/${batchId}`)));
  }

  /**
   * Previews of referenced items in other projects, by key (M12). Hidden
   * items are simply missing from the answer.
   *
   * @param keys Canonical keys such as `OPS-3`.
   * @returns The visible items.
   */
  previews(keys: readonly string[]): Promise<ItemPreviewDto[]> {
    return firstValueFrom(
      this.http.get<ItemPreviewDto[]>(apiUrl('references'), {
        params: new HttpParams().set('keys', keys.join(',')),
      }),
    );
  }

  /**
   * The visible items whose text names this one (M12 "Referenced in").
   *
   * @param projectId Project id.
   * @param item Item id or number.
   * @returns The referring items.
   */
  referencedIn(projectId: string, item: string | number): Promise<ItemReferrerDto[]> {
    return firstValueFrom(
      this.http.get<ItemReferrerDto[]>(
        `${apiUrl(`projects/${projectId}/items/${item}`)}/referenced-in`,
      ),
    );
  }
}
