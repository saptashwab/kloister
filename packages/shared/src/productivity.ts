/** One confirmed independent copy. */
export interface ItemCopyRequest {
  /** Previewed title. */
  title: string;
  /** Project members, checked through ordinary assignment permissions. */
  assigneeIds: string[];
}

/** Same-space duplication, without inherited progress or relationships. */
export interface DuplicateItemRequest {
  /** Explicit independent copies. */
  copies: ItemCopyRequest[];
  /** Destination bucket. */
  bucketId?: string | null;
  /** Optional team. */
  teamId?: string | null;
  /** Optional readable parent. */
  parentId?: string | null;
  /** Keep start/due dates. */
  keepDates?: boolean;
  /** Keep the open sprint. */
  keepSprint?: boolean;
  /** Include non-inline attachments. */
  attachments?: boolean;
}

/** Self-only durable introduction eligibility. */
export interface IntroductionDto {
  /** True after the initial required password change until completion or Skip. */
  pending: boolean;
}

/** Server-calculated snapshot scope preview; no unreadable references. */
export interface SnapshotPreviewDto {
  /** Project name or My work. */
  scope: string;
  /** Filtered or all-eligible selection. */
  mode: string;
  /** Recorded filters. */
  filters: string;
  /** Every matching page's item count. */
  count: number;
  /** Included detail sheets and files. */
  details: string;
}
