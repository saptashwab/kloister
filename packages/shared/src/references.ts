/**
 * Item references in rich text (M12): `KLO-12` names item 12 of the project
 * with key `KLO`; `#12` names item 12 of the same project. The server marks
 * the ones the writer can see as `<span data-ref="KLO-12">KLO-12</span>`.
 */

/** One reference found in text. */
export interface ReferenceToken {
  /** The text as written, e.g. `KLO-12` or `#12`. */
  text: string;
  /** Project key, or null for `#12` (the same project). */
  key: string | null;
  /** Item number. */
  number: number;
  /** Offset of the token in the text. */
  index: number;
}

/**
 * Builds the pattern of a reference: a 2–6 letter key and a number, or `#`
 * and a number, not glued to other words, keys or numbers.
 *
 * @returns A fresh global pattern (it carries match state).
 */
export function referencePattern(): RegExp {
  return /(?<![\p{L}\p{N}_#&-])(?:([A-Z]{2,6})-(\d{1,9})|#(\d{1,9}))(?![\p{L}\p{N}_-])/gu;
}

/**
 * Finds the references in plain text.
 *
 * @param text Text (not HTML).
 * @returns The tokens in order.
 */
export function referenceTokens(text: string): ReferenceToken[] {
  return [...text.matchAll(referencePattern())].map((m) => ({
    text: m[0],
    key: m[1] ?? null,
    number: Number(m[2] ?? m[3]),
    index: m.index ?? 0,
  }));
}

/**
 * The canonical form of a reference: `KEY-N`, or `#N` in a project without a
 * key (a personal space).
 *
 * @param key Project key, or null.
 * @param number Item number.
 * @returns The canonical text.
 */
export function referenceKey(key: string | null, number: number): string {
  return key === null ? `#${number}` : `${key}-${number}`;
}

/** The opening tag of a mark in stored HTML, with its canonical key. */
const MARK = /<span data-ref="([^"<>]{2,20})">/g;

/**
 * The references marked in stored (sanitized) HTML.
 *
 * @param html Stored HTML.
 * @returns Distinct canonical keys, in order of first mention.
 */
export function markedReferences(html: string): string[] {
  return [...new Set([...html.matchAll(MARK)].map((m) => m[1] ?? ''))].filter((k) => k !== '');
}

/**
 * Removes the marks of references the reader may not see, leaving a bare
 * span around the plain text, so nothing hints that the item exists (M12).
 * Only the opening tag changes, so the HTML stays balanced whatever the
 * mark holds.
 *
 * @param html Stored HTML.
 * @param visible Whether the reader may see the item with this canonical key.
 * @returns The HTML for this reader.
 */
export function unmarkReferences(html: string, visible: (key: string) => boolean): string {
  return html.replace(MARK, (whole, key: string) => (visible(key) ? whole : '<span>'));
}

/**
 * Splits a canonical key into project key and number.
 *
 * @param canonical `KEY-N` or `#N`.
 * @returns The parts, or null when malformed.
 */
export function parseReferenceKey(
  canonical: string,
): { key: string | null; number: number } | null {
  const match = /^(?:([A-Z]{2,6})-|#)(\d{1,9})$/.exec(canonical);
  return match === null ? null : { key: match[1] ?? null, number: Number(match[2]) };
}
