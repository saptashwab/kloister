/** Page size used when a list request does not pass `limit`. */
export const DEFAULT_PAGE_LIMIT = 50;

/** Largest `limit` a list endpoint accepts. */
export const MAX_PAGE_LIMIT = 100;

/**
 * One page of a cursor-paginated list (SPEC §8).
 *
 * Pass `nextCursor` back as `?cursor=` to fetch the following page; it is
 * null on the last page.
 */
export interface Page<T> {
  /** Items on this page, newest first unless the endpoint says otherwise. */
  items: T[];
  /** Opaque cursor for the next page, or null when there are no more items. */
  nextCursor: string | null;
}
