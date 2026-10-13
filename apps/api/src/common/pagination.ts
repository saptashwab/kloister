import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, type Page } from '@kloister/shared';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { LowercaseUuid } from './uuid.js';

/**
 * Query parameters shared by every cursor-paginated list endpoint (SPEC §8).
 * The cursor is the id of the last item on the previous page.
 */
export class PageQueryDto {
  /** Id of the last item already received. */
  @IsOptional()
  @LowercaseUuid()
  @IsUUID()
  cursor?: string;

  /** Page size, 1 to {@link MAX_PAGE_LIMIT}. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_LIMIT)
  limit?: number;
}

/**
 * Prisma arguments for one page: fetch one extra row to learn whether a next
 * page exists, starting after the cursor row.
 *
 * @param query Validated page query.
 * @returns `take`, and `cursor`/`skip` when a cursor was given.
 */
export function pageArgs(query: PageQueryDto): {
  take: number;
  cursor?: { id: string };
  skip?: number;
} {
  const take = (query.limit ?? DEFAULT_PAGE_LIMIT) + 1;
  return query.cursor === undefined ? { take } : { take, cursor: { id: query.cursor }, skip: 1 };
}

/**
 * Trims the extra row fetched by {@link pageArgs} and builds the page.
 *
 * @param rows Rows returned by Prisma (up to limit + 1).
 * @param query The same query passed to {@link pageArgs}.
 * @param map Converts a row to its DTO.
 * @returns The page with `nextCursor` set when more rows exist.
 */
export function toPage<R extends { id: string }, T>(
  rows: R[],
  query: PageQueryDto,
  map: (row: R) => T,
): Page<T> {
  const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(map),
    nextCursor: hasMore && last !== undefined ? last.id : null,
  };
}
