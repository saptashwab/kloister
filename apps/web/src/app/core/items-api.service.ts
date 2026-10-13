import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AddDependencyRequest,
  AuditEntryDto,
  BucketDto,
  ChecklistItemDto,
  CloseSprintRequest,
  CloseSprintResult,
  CreateBucketRequest,
  CreateChecklistItemRequest,
  CreateItemRequest,
  CreateLabelRequest,
  CreateSprintRequest,
  LabelDto,
  MoveItemRequest,
  Page,
  SprintDto,
  UpdateBucketRequest,
  UpdateChecklistItemRequest,
  UpdateItemRequest,
  UpdateLabelRequest,
  UpdateSprintRequest,
  WorkItemDetailDto,
  WorkItemDto,
} from '@kloister/shared';
import { MAX_PAGE_LIMIT } from '@kloister/shared';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from './api';

/** Filters for {@link ItemsApiService.list}; see the API's list query. */
export interface ItemListFilter {
  /** `position` for board order; default `number`. */
  sort?: 'number' | 'position';
  /** Cursor from the previous page. */
  cursor?: string;
  /** Page size, at most {@link MAX_PAGE_LIMIT}. */
  limit?: number;
}

/**
 * Fetches every page of a cursor-paginated list.
 *
 * @param fetch Loads one page for a cursor.
 * @returns All items, in API order.
 */
export async function fetchAll<T>(
  fetch: (cursor: string | undefined) => Promise<Page<T>>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetch(cursor);
    all.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return all;
}

/**
 * Client for work items and the board (buckets, labels, sprints) under
 * `/projects/:id/…`.
 *
 * The API decides every permission: items outside the caller's scope are 404,
 * refused writes 403. The UI only hides controls, using each item's `can`
 * capabilities and the project's `myPermissions`.
 */
@Injectable({ providedIn: 'root' })
export class ItemsApiService {
  private readonly http = inject(HttpClient);

  /**
   * Lists one page of visible items.
   *
   * @param projectId Project id.
   * @param filter Order, cursor and page size.
   * @returns One page of items.
   */
  list(projectId: string, filter: ItemListFilter = {}): Promise<Page<WorkItemDto>> {
    let params = new HttpParams();
    if (filter.sort) params = params.set('sort', filter.sort);
    if (filter.cursor) params = params.set('cursor', filter.cursor);
    if (filter.limit) params = params.set('limit', filter.limit);
    return firstValueFrom(
      this.http.get<Page<WorkItemDto>>(apiUrl(`projects/${projectId}/items`), { params }),
    );
  }

  /**
   * Lists every visible item in board order.
   *
   * @param projectId Project id.
   * @returns All visible items.
   */
  listAll(projectId: string): Promise<WorkItemDto[]> {
    return fetchAll((cursor) =>
      this.list(projectId, {
        sort: 'position',
        limit: MAX_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      }),
    );
  }

  /**
   * Loads one item with its checklist and dependencies.
   *
   * @param projectId Project id.
   * @param item Item id or per-project number.
   * @returns The item.
   */
  get(projectId: string, item: string | number): Promise<WorkItemDetailDto> {
    return firstValueFrom(this.http.get<WorkItemDetailDto>(this.itemUrl(projectId, item)));
  }

  /**
   * Creates an item at the top of its bucket (needs `CREATE_ITEMS`).
   *
   * @param projectId Project id.
   * @param request The item.
   * @returns The new item.
   */
  create(projectId: string, request: CreateItemRequest): Promise<WorkItemDetailDto> {
    return firstValueFrom(
      this.http.post<WorkItemDetailDto>(apiUrl(`projects/${projectId}/items`), request),
    );
  }

  /**
   * Changes item fields (needs `can.edit`). The response carries the final
   * bucket, which may change through the project's `statusToBucket` map.
   *
   * @param projectId Project id.
   * @param item Item id or number.
   * @param request Fields to change.
   * @returns The updated item.
   */
  update(
    projectId: string,
    item: string | number,
    request: UpdateItemRequest,
  ): Promise<WorkItemDetailDto> {
    return firstValueFrom(
      this.http.patch<WorkItemDetailDto>(this.itemUrl(projectId, item), request),
    );
  }

  /**
   * Moves a card into or within a bucket (needs `can.move`). The response
   * carries the status after the bucket's entry rule.
   *
   * @param projectId Project id.
   * @param item Item id or number.
   * @param request Target bucket and the card to place it after.
   * @returns The moved item.
   */
  move(
    projectId: string,
    item: string | number,
    request: MoveItemRequest,
  ): Promise<WorkItemDetailDto> {
    return firstValueFrom(
      this.http.post<WorkItemDetailDto>(`${this.itemUrl(projectId, item)}/move`, request),
    );
  }

  /**
   * Deletes an item (needs `can.delete`, or `can.deleteCascade` with children).
   *
   * @param projectId Project id.
   * @param item Item id or number.
   * @param cascade Delete its descendants too.
   * @returns Resolves once deleted.
   */
  remove(projectId: string, item: string | number, cascade = false): Promise<void> {
    const params = cascade ? new HttpParams().set('cascade', 'true') : new HttpParams();
    return firstValueFrom(this.http.delete<void>(this.itemUrl(projectId, item), { params }));
  }

  /**
   * Lists one page of an item's visible children.
   *
   * @param projectId Project id.
   * @param item Item id or number.
   * @param cursor Cursor from the previous page.
   * @returns One page of children.
   */
  children(projectId: string, item: string | number, cursor?: string): Promise<Page<WorkItemDto>> {
    const params = cursor ? new HttpParams().set('cursor', cursor) : new HttpParams();
    return firstValueFrom(
      this.http.get<Page<WorkItemDto>>(`${this.itemUrl(projectId, item)}/children`, { params }),
    );
  }

  /**
   * Lists one page of an item's activity history, newest first.
   *
   * @param projectId Project id.
   * @param item Item id or number.
   * @param cursor Cursor from the previous page.
   * @returns One page of audit entries.
   */
  activity(
    projectId: string,
    item: string | number,
    cursor?: string,
  ): Promise<Page<AuditEntryDto>> {
    const params = cursor ? new HttpParams().set('cursor', cursor) : new HttpParams();
    return firstValueFrom(
      this.http.get<Page<AuditEntryDto>>(`${this.itemUrl(projectId, item)}/activity`, { params }),
    );
  }

  /**
   * Marks an item as blocked by another (needs `can.edit`).
   *
   * @param projectId Project id.
   * @param item Blocked item id or number.
   * @param request The blocking item.
   * @returns The blocked item.
   */
  addDependency(
    projectId: string,
    item: string | number,
    request: AddDependencyRequest,
  ): Promise<WorkItemDetailDto> {
    return firstValueFrom(
      this.http.post<WorkItemDetailDto>(`${this.itemUrl(projectId, item)}/dependencies`, request),
    );
  }

  /**
   * Removes a "blocked by" dependency (needs `can.edit`).
   *
   * @param projectId Project id.
   * @param item Blocked item id or number.
   * @param blockingItemId The blocking item's id.
   * @returns The blocked item.
   */
  removeDependency(
    projectId: string,
    item: string | number,
    blockingItemId: string,
  ): Promise<WorkItemDetailDto> {
    return firstValueFrom(
      this.http.delete<WorkItemDetailDto>(
        `${this.itemUrl(projectId, item)}/dependencies/${blockingItemId}`,
      ),
    );
  }

  /**
   * Adds a checklist line at the end (needs `can.edit`).
   *
   * @param projectId Project id.
   * @param item Item id or number.
   * @param request Text and ticked state.
   * @returns The new line.
   */
  addChecklistLine(
    projectId: string,
    item: string | number,
    request: CreateChecklistItemRequest,
  ): Promise<ChecklistItemDto> {
    return firstValueFrom(
      this.http.post<ChecklistItemDto>(`${this.itemUrl(projectId, item)}/checklist`, request),
    );
  }

  /**
   * Edits or ticks a checklist line (needs `can.edit`). Never changes the
   * item's status (SPEC §4.2).
   *
   * @param projectId Project id.
   * @param item Item id or number.
   * @param lineId Line id.
   * @param request Fields to change.
   * @returns The updated line.
   */
  updateChecklistLine(
    projectId: string,
    item: string | number,
    lineId: string,
    request: UpdateChecklistItemRequest,
  ): Promise<ChecklistItemDto> {
    return firstValueFrom(
      this.http.patch<ChecklistItemDto>(
        `${this.itemUrl(projectId, item)}/checklist/${lineId}`,
        request,
      ),
    );
  }

  /**
   * Moves a checklist line after another (needs `can.edit`).
   *
   * @param projectId Project id.
   * @param item Item id or number.
   * @param lineId Line id.
   * @param afterId The line to place it after, or null for the first place.
   * @returns The moved line.
   */
  moveChecklistLine(
    projectId: string,
    item: string | number,
    lineId: string,
    afterId: string | null,
  ): Promise<ChecklistItemDto> {
    return firstValueFrom(
      this.http.post<ChecklistItemDto>(
        `${this.itemUrl(projectId, item)}/checklist/${lineId}/move`,
        { afterId },
      ),
    );
  }

  /**
   * Deletes a checklist line (needs `can.edit`).
   *
   * @param projectId Project id.
   * @param item Item id or number.
   * @param lineId Line id.
   * @returns Resolves once deleted.
   */
  removeChecklistLine(projectId: string, item: string | number, lineId: string): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(`${this.itemUrl(projectId, item)}/checklist/${lineId}`),
    );
  }

  /**
   * Lists every bucket in column order.
   *
   * @param projectId Project id.
   * @returns All buckets.
   */
  buckets(projectId: string): Promise<BucketDto[]> {
    return fetchAll((cursor) => this.page<BucketDto>(`projects/${projectId}/buckets`, cursor));
  }

  /**
   * Creates a bucket as the last column (needs `MANAGE_BOARD`).
   *
   * @param projectId Project id.
   * @param request Name and entry rule.
   * @returns The new bucket.
   */
  createBucket(projectId: string, request: CreateBucketRequest): Promise<BucketDto> {
    return firstValueFrom(
      this.http.post<BucketDto>(apiUrl(`projects/${projectId}/buckets`), request),
    );
  }

  /**
   * Renames a bucket or changes its entry rule (needs `MANAGE_BOARD`).
   *
   * @param projectId Project id.
   * @param bucketId Bucket id.
   * @param request Fields to change.
   * @returns The updated bucket.
   */
  updateBucket(
    projectId: string,
    bucketId: string,
    request: UpdateBucketRequest,
  ): Promise<BucketDto> {
    return firstValueFrom(
      this.http.patch<BucketDto>(apiUrl(`projects/${projectId}/buckets/${bucketId}`), request),
    );
  }

  /**
   * Moves a bucket after another (needs `MANAGE_BOARD`).
   *
   * @param projectId Project id.
   * @param bucketId Bucket id.
   * @param afterId The bucket to place it after, or null for the first place.
   * @returns The moved bucket.
   */
  moveBucket(projectId: string, bucketId: string, afterId: string | null): Promise<BucketDto> {
    return firstValueFrom(
      this.http.post<BucketDto>(apiUrl(`projects/${projectId}/buckets/${bucketId}/move`), {
        afterId,
      }),
    );
  }

  /**
   * Deletes a bucket (needs `MANAGE_BOARD`). A bucket holding items needs a
   * target bucket for them.
   *
   * @param projectId Project id.
   * @param bucketId Bucket id.
   * @param moveItemsTo Bucket that receives its items, if any.
   * @returns Resolves once deleted.
   */
  deleteBucket(projectId: string, bucketId: string, moveItemsTo?: string): Promise<void> {
    const params = moveItemsTo
      ? new HttpParams().set('moveItemsTo', moveItemsTo)
      : new HttpParams();
    return firstValueFrom(
      this.http.delete<void>(apiUrl(`projects/${projectId}/buckets/${bucketId}`), { params }),
    );
  }

  /**
   * Lists every label.
   *
   * @param projectId Project id.
   * @returns All labels.
   */
  labels(projectId: string): Promise<LabelDto[]> {
    return fetchAll((cursor) => this.page<LabelDto>(`projects/${projectId}/labels`, cursor));
  }

  /**
   * Creates a label (needs `MANAGE_BOARD`).
   *
   * @param projectId Project id.
   * @param request Name and colour.
   * @returns The new label.
   */
  createLabel(projectId: string, request: CreateLabelRequest): Promise<LabelDto> {
    return firstValueFrom(
      this.http.post<LabelDto>(apiUrl(`projects/${projectId}/labels`), request),
    );
  }

  /**
   * Renames or recolours a label (needs `MANAGE_BOARD`).
   *
   * @param projectId Project id.
   * @param labelId Label id.
   * @param request Fields to change.
   * @returns The updated label.
   */
  updateLabel(projectId: string, labelId: string, request: UpdateLabelRequest): Promise<LabelDto> {
    return firstValueFrom(
      this.http.patch<LabelDto>(apiUrl(`projects/${projectId}/labels/${labelId}`), request),
    );
  }

  /**
   * Deletes a label (needs `MANAGE_BOARD`).
   *
   * @param projectId Project id.
   * @param labelId Label id.
   * @returns Resolves once deleted.
   */
  deleteLabel(projectId: string, labelId: string): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(apiUrl(`projects/${projectId}/labels/${labelId}`)),
    );
  }

  /**
   * Lists every sprint.
   *
   * @param projectId Project id.
   * @returns All sprints.
   */
  sprints(projectId: string): Promise<SprintDto[]> {
    return fetchAll((cursor) => this.page<SprintDto>(`projects/${projectId}/sprints`, cursor));
  }

  /**
   * Creates a planned sprint (needs `MANAGE_BOARD`).
   *
   * @param projectId Project id.
   * @param request Name and dates.
   * @returns The new sprint.
   */
  createSprint(projectId: string, request: CreateSprintRequest): Promise<SprintDto> {
    return firstValueFrom(
      this.http.post<SprintDto>(apiUrl(`projects/${projectId}/sprints`), request),
    );
  }

  /**
   * Edits a sprint (needs `MANAGE_BOARD`).
   *
   * @param projectId Project id.
   * @param sprintId Sprint id.
   * @param request Fields to change.
   * @returns The updated sprint.
   */
  updateSprint(
    projectId: string,
    sprintId: string,
    request: UpdateSprintRequest,
  ): Promise<SprintDto> {
    return firstValueFrom(
      this.http.patch<SprintDto>(apiUrl(`projects/${projectId}/sprints/${sprintId}`), request),
    );
  }

  /**
   * Makes a planned sprint the active one (needs `MANAGE_BOARD`).
   *
   * @param projectId Project id.
   * @param sprintId Sprint id.
   * @returns The started sprint.
   */
  startSprint(projectId: string, sprintId: string): Promise<SprintDto> {
    return firstValueFrom(
      this.http.post<SprintDto>(apiUrl(`projects/${projectId}/sprints/${sprintId}/start`), {}),
    );
  }

  /**
   * Closes a sprint, optionally moving its unfinished items (needs
   * `MANAGE_BOARD`).
   *
   * @param projectId Project id.
   * @param sprintId Sprint id.
   * @param request Where unfinished items go.
   * @returns The closed sprint and how many items moved.
   */
  closeSprint(
    projectId: string,
    sprintId: string,
    request: CloseSprintRequest,
  ): Promise<CloseSprintResult> {
    return firstValueFrom(
      this.http.post<CloseSprintResult>(
        apiUrl(`projects/${projectId}/sprints/${sprintId}/close`),
        request,
      ),
    );
  }

  /**
   * Deletes a sprint; its items go back to the backlog (needs `MANAGE_BOARD`).
   *
   * @param projectId Project id.
   * @param sprintId Sprint id.
   * @returns Resolves once deleted.
   */
  deleteSprint(projectId: string, sprintId: string): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(apiUrl(`projects/${projectId}/sprints/${sprintId}`)),
    );
  }

  /**
   * Builds the URL of one item.
   *
   * @param projectId Project id.
   * @param item Item id or number.
   * @returns The relative URL.
   */
  private itemUrl(projectId: string, item: string | number): string {
    return apiUrl(`projects/${projectId}/items/${encodeURIComponent(String(item))}`);
  }

  /**
   * Loads one page of a board list at the largest page size.
   *
   * @param path Path below `/api/v1`.
   * @param cursor Cursor from the previous page.
   * @returns One page.
   */
  private page<T>(path: string, cursor: string | undefined): Promise<Page<T>> {
    let params = new HttpParams().set('limit', MAX_PAGE_LIMIT);
    if (cursor) params = params.set('cursor', cursor);
    return firstValueFrom(this.http.get<Page<T>>(apiUrl(path), { params }));
  }
}
