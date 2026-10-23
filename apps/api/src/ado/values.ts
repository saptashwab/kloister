import type { AdoDateOrder, AdoField } from '@kloister/shared';
import { invalidField } from '../common/api-exception.js';
import { isCalendarDate } from '../common/dates.js';
import { sanitizeRichText } from '../common/sanitize-html.js';

/**
 * Writes a calendar date the way ADO's CSV import accepts it under any user locale. Noon UTC keeps
 * the same calendar day for every viewer within eleven hours of UTC; plain `YYYY-MM-DD` is rejected
 * by the import for users whose locale is not ISO.
 * @param date `YYYY-MM-DD` or null.
 * @returns Import cell text, empty for no date.
 */
export function adoDate(date: string | null | undefined): string {
  return date ? `${date}T12:00:00Z` : '';
}

/**
 * Reads a date cell from an ADO export. Exports use the exporting user's locale and time zone
 * (for example `02/11/2026 05:30:00`); the calendar date shown is the one ADO showed that user.
 * @param value Cell text.
 * @param order Day/month order confirmed for this destination, if any.
 * @param header Column name for error messages.
 * @returns `YYYY-MM-DD`, or null for an empty cell.
 */
export function parseAdoDate(
  value: string,
  order: AdoDateOrder | undefined,
  header: string,
): string | null {
  const text = value.trim();
  if (text === '') return null;
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/u.exec(text);
  if (iso && isCalendarDate(iso[1])) return iso[1];
  const local =
    /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp][Mm])?)?$/u.exec(
      text,
    );
  if (local) {
    const [a, b, year] = [Number(local[1]), Number(local[2]), local[3]];
    // A part above 12 proves the order; otherwise the destination's confirmed order decides.
    const resolved: AdoDateOrder | undefined = a > 12 ? 'DMY' : b > 12 ? 'MDY' : order;
    if (!resolved)
      throw invalidField(
        header,
        `Date "${text}" could be day/month or month/day; choose the date order in Transfer settings`,
      );
    if (order && resolved !== order)
      throw invalidField(header, `Date "${text}" does not match the configured date order`);
    const [day, month] = resolved === 'DMY' ? [a, b] : [b, a];
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (isCalendarDate(date)) return date;
  }
  throw invalidField(header, `Unrecognized date "${text}"`);
}

/**
 * Finds the email in an ADO identity cell such as `Display Name <name@example.org>`.
 * @param value Identity text.
 * @returns Lowercased email, or null.
 */
export function identityEmail(value: string): string | null {
  const match =
    /<([^<>\s@]+@[^<>\s]+)>\s*$/u.exec(value) ?? /^\s*([^<>\s@]+@[^<>\s]+)\s*$/u.exec(value);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Visible text of rich text, so ADO's own HTML normalization (extra spaces, entity changes)
 * never counts as an edit.
 * @param html Rich text.
 * @returns Collapsed plain text.
 */
export function textOf(html: string): string {
  return sanitizeRichText(html)
    .replace(/<(?:br|\/p|\/li|\/div|\/h\d)\b[^>]*>/giu, ' ')
    .replace(/<[^>]*>/gu, '')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Compares one transfer field across the two systems, ignoring representation-only differences.
 * @param field Transfer field.
 * @param a One value.
 * @param b Other value.
 * @returns True when both mean the same.
 */
export function sameValue(field: AdoField, a: unknown, b: unknown): boolean {
  const blank = (v: unknown) =>
    v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
  if (blank(a) || blank(b)) return blank(a) && blank(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    const sorted = (v: unknown[]) => JSON.stringify(v.map((x) => JSON.stringify(x)).sort());
    return sorted(a as unknown[]) === sorted(b as unknown[]);
  }
  if (field === 'description') return textOf(String(a)) === textOf(String(b));
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  return String(a) === String(b);
}

/**
 * Removes the generated transfer details block that ends with this item's issued reference.
 * Works on ADO's normalized HTML, so a prepared file that was never imported, or ADO's own
 * whitespace changes, never break the next import.
 * @param html Incoming description.
 * @param reference Issued reference of the linked item.
 * @returns Description without the block, or the sanitized input when no block is present.
 */
export function stripFooter(html: string, reference: string): string {
  const clean = sanitizeRichText(html);
  const marker = `Kloister reference: ${reference}`;
  const at = clean.lastIndexOf(marker);
  if (at < 0) return clean;
  if (textOf(clean.slice(at + marker.length)) !== '')
    throw invalidField(
      'Description',
      'Text was added after the generated transfer details. Move it above the details block or match the row manually.',
    );
  const heading = clean.lastIndexOf('Kloister transfer details', at);
  const anchor = heading >= 0 ? heading : at;
  const hr = clean.lastIndexOf('<hr', anchor);
  const paragraph = clean.lastIndexOf('<p', anchor);
  // Start at the rule only when nothing but markup sits between it and the heading.
  const start = hr >= 0 && textOf(clean.slice(hr, anchor)) === '' ? hr : paragraph;
  return clean.slice(0, Math.max(0, start)).trimEnd();
}
