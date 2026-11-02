import {
  type AssigneeShareDto,
  SHARE_MAX,
  SHARE_MIN,
  SHARE_STEP,
  type WorkItemDto,
} from '@kloister/shared';

// Assignee shares (docs/M13-PLAN.md §2): 100% unless someone sets less,
// shown only when not 100%, set with the inline 100 · 75 · 50 · 25 buttons, arrow
// keys, typed digits, an "Other %" field, the timeline Who text ("Ann, Bo 25") or by clicking a
// badge in the drawer, which cycles 25 → 50 → 100.

/** The shares offered as buttons, largest first. */
export const SHARE_PRESETS: readonly number[] = [100, 75, 50, 25];

/**
 * An item's assignees with their shares, falling back to 100% for data
 * without shares.
 *
 * @param item The item.
 * @returns The assignees in order.
 */
export function sharesOf(
  item: Pick<WorkItemDto, 'assigneeIds'> & Partial<WorkItemDto>,
): AssigneeShareDto[] {
  return item.assigneeIds.map((userId) => ({
    userId,
    share: item.assigneeShares?.find((a) => a.userId === userId)?.share ?? SHARE_MAX,
  }));
}

/**
 * One person's share on an item.
 *
 * @param item The item.
 * @param userId The person.
 * @returns Percent, or null when not assigned.
 */
export function shareOf(
  item: Pick<WorkItemDto, 'assigneeIds'> & Partial<WorkItemDto>,
  userId: string,
): number | null {
  return sharesOf(item).find((a) => a.userId === userId)?.share ?? null;
}

/**
 * Turns a typed number into a valid share: rounded to the nearest step of 5
 * and kept between 5 and 100.
 *
 * @param value The typed percent.
 * @returns The share.
 */
export function clampShare(value: number): number {
  if (!Number.isFinite(value)) return SHARE_MAX;
  const stepped = Math.round(value / SHARE_STEP) * SHARE_STEP;
  return Math.min(SHARE_MAX, Math.max(SHARE_MIN, stepped));
}

/**
 * The share a badge click moves to: 25 → 50 → 100 → 25; any other value goes
 * to the next of those above it.
 *
 * @param share Current percent.
 * @returns The next percent.
 */
export function nextShare(share: number): number {
  if (share >= SHARE_MAX) return 25;
  return share < 25 ? 25 : share < 50 ? 50 : SHARE_MAX;
}

/**
 * The share an arrow key moves to among the presets: ← lower, → higher.
 *
 * @param share Current percent.
 * @param direction -1 for lower, 1 for higher.
 * @returns The new percent.
 */
export function stepShare(share: number, direction: -1 | 1): number {
  const ascending = [...SHARE_PRESETS].sort((a, b) => a - b);
  if (direction > 0) return ascending.find((p) => p > share) ?? SHARE_MAX;
  return [...ascending].reverse().find((p) => p < share) ?? ascending[0];
}

/**
 * A name with its share when that is not 100%.
 *
 * @param name The person's name.
 * @param share Percent.
 * @returns E.g. "Bo 25%".
 */
export function shareLabel(name: string, share: number): string {
  return share === SHARE_MAX ? name : `${name} ${share}%`;
}

/**
 * The timeline Who cell's text: names, with the share after those below 100%.
 *
 * @param assignees The assignees.
 * @param nameOf A person's name.
 * @returns E.g. "Ann, Bo 25".
 */
export function whoText(
  assignees: readonly AssigneeShareDto[],
  nameOf: (userId: string) => string,
): string {
  return assignees
    .map((a) => (a.share === SHARE_MAX ? nameOf(a.userId) : `${nameOf(a.userId)} ${a.share}`))
    .join(', ');
}

/** A person the Who text can name. */
export interface WhoPerson {
  /** User id. */
  userId: string;
  /** Display name. */
  displayName: string;
  /** Email, also accepted. */
  email?: string;
}

/** What typed Who text resolves to. */
export interface ParsedWho {
  /** The assignees with their shares, in typed order. */
  assignees: AssigneeShareDto[];
  /** Parts that matched nobody, or more than one person. */
  unknown: string[];
}

/**
 * Reads typed Who text: names separated by commas (or semicolons), each with
 * an optional share, e.g. `Ann, Raj, Bo 25, Lee 25%`. A name without a number
 * is 100%. A name matches a person's full name, email, or a unique start of
 * either (ignoring case); naming someone twice keeps the last share.
 *
 * @param text The typed text.
 * @param people The people who may be named.
 * @returns The assignees and the parts that matched nobody.
 */
export function parseWho(text: string, people: readonly WhoPerson[]): ParsedWho {
  const result: ParsedWho = { assignees: [], unknown: [] };
  for (const raw of text.split(/[,;]/)) {
    const part = raw.trim();
    if (part === '') continue;
    const match = /^(.*?)\s*(\d{1,3})\s*%?$/.exec(part);
    const name = (match?.[1] ?? part).trim().toLowerCase();
    const share =
      match?.[2] === undefined || match[1]?.trim() === ''
        ? SHARE_MAX
        : clampShare(Number(match[2]));
    const exact = people.filter(
      (p) => p.displayName.toLowerCase() === name || p.email?.toLowerCase() === name,
    );
    const starts = people.filter(
      (p) =>
        p.displayName.toLowerCase().startsWith(name) || p.email?.toLowerCase().startsWith(name),
    );
    const person = exact.length === 1 ? exact[0] : starts.length === 1 ? starts[0] : undefined;
    if (name === '' || person === undefined) {
      result.unknown.push(part);
      continue;
    }
    result.assignees = result.assignees.filter((a) => a.userId !== person.userId);
    result.assignees.push({ userId: person.userId, share });
  }
  return result;
}

/**
 * The assignee list with one person's share changed (or the person added at
 * that share).
 *
 * @param assignees The current assignees.
 * @param userId The person.
 * @param share The new percent.
 * @returns The new list.
 */
export function withShareFor(
  assignees: readonly AssigneeShareDto[],
  userId: string,
  share: number,
): AssigneeShareDto[] {
  return assignees.some((a) => a.userId === userId)
    ? assignees.map((a) => (a.userId === userId ? { userId, share } : a))
    : [...assignees, { userId, share }];
}
