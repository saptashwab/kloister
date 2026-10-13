/** Gap between neighbouring positions when rows are appended or renumbered. */
export const POSITION_STEP = 1024;

/** A row ordered by a fractional `position`. */
export interface Positioned {
  /** Row id. */
  id: string;
  /** Sort key, ascending. */
  position: number;
}

/** Where a moved row goes, and which siblings must be renumbered first. */
export interface Placement {
  /** The moved row's new position. */
  position: number;
  /**
   * New positions for siblings, written before the moved row. Empty unless
   * the gap between the neighbours was used up by repeated moves.
   */
  renumber: Positioned[];
}

/**
 * Places a row right after a sibling (or first), using fractional positions
 * so that a move normally rewrites one row (SPEC §4 `position`). When the two
 * neighbours are too close for a midpoint, every sibling is renumbered with
 * {@link POSITION_STEP} gaps.
 *
 * @param siblings The other rows of the same list (without the moved row),
 *   ordered by position.
 * @param afterId Sibling to place the row after, or null for the first place.
 *   The caller must have checked it is one of `siblings`.
 * @returns The new position and any sibling renumbering.
 */
export function placeAfter(siblings: readonly Positioned[], afterId: string | null): Placement {
  const index = afterId === null ? -1 : siblings.findIndex((s) => s.id === afterId);
  if (afterId !== null && index === -1) throw new Error('afterId is not a sibling');
  const prev = index === -1 ? null : (siblings[index]?.position ?? null);
  const next = siblings[index + 1]?.position ?? null;
  const position = between(prev, next);
  if (position !== null) return { position, renumber: [] };

  // No room left between the neighbours: spread everything out again.
  const renumber = siblings.map((s, i) => ({
    id: s.id,
    position: (i + (i > index ? 2 : 1)) * POSITION_STEP,
  }));
  return { position: (index + 2) * POSITION_STEP, renumber };
}

/**
 * Position for a row appended after every sibling.
 *
 * @param last The current last position, or null for an empty list.
 * @returns The new position.
 */
export function positionAtEnd(last: number | null): number {
  return last === null ? POSITION_STEP : last + POSITION_STEP;
}

/**
 * A position strictly between two neighbours, or null if there is none
 * representable.
 *
 * @param prev Position before, or null at the start.
 * @param next Position after, or null at the end.
 * @returns The position, or null when the gap is exhausted.
 */
function between(prev: number | null, next: number | null): number | null {
  if (prev === null && next === null) return POSITION_STEP;
  if (prev === null) return (next as number) - POSITION_STEP;
  if (next === null) return prev + POSITION_STEP;
  const mid = prev + (next - prev) / 2;
  return mid > prev && mid < next ? mid : null;
}
