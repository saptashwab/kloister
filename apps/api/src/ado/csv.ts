import { ADO_LIMITS } from '@kloister/shared';
import { invalidField } from '../common/api-exception.js';

/** Strict parsed CSV with absent columns distinguishable from empty cells. */
export interface CsvTable {
  /** Unique case-sensitive headers. */
  headers: string[];
  /** Data rows, with exactly one cell per header. */
  rows: Record<string, string>[];
}

/**
 * Reads RFC 4180 quoting, BOM and common line endings without guessing malformed input.
 * @param text Operator-carried UTF-8 text.
 * @returns Validated table, with at most 1,000 data rows.
 */
export function readCsv(text: string): CsvTable {
  if (Buffer.byteLength(text, 'utf8') > ADO_LIMITS.uploadBytes)
    throw invalidField('csv', 'CSV exceeds 10 MiB');
  if (text.includes('\0') || /[\uFFFD\uD800-\uDFFF]/u.test(text))
    throw invalidField('csv', 'CSV must be valid UTF-8 without NUL');
  text = text.replace(/^\uFEFF/u, '');
  const records: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false;
  const endCell = () => {
    if (Buffer.byteLength(cell, 'utf8') > ADO_LIMITS.cellBytes)
      throw invalidField('csv', 'CSV cell exceeds 1 MiB');
    row.push(cell);
    cell = '';
    closed = false;
  };
  const endRow = () => {
    endCell();
    records.push(row);
    row = [];
    if (records.length > ADO_LIMITS.rows + 1)
      throw invalidField('csv', 'CSV exceeds 1,000 data rows');
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += c;
    } else if (c === ',') endCell();
    else if (c === '\r' || c === '\n') {
      endRow();
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else if (c === '"' && cell === '' && !closed) quoted = true;
    else {
      if (closed || c === '"') throw invalidField('csv', 'Malformed CSV quoting');
      cell += c;
    }
  }
  if (quoted) throw invalidField('csv', 'Unclosed CSV quote');
  if (cell !== '' || row.length > 0 || closed) endRow();
  const headers = records.shift();
  if (
    !headers ||
    headers.length === 0 ||
    headers.some((h) => h === '' || h !== h.trim() || /[\r\n]/u.test(h))
  )
    throw invalidField('csv', 'Missing or invalid headers');
  if (new Set(headers.map((h) => h.toLowerCase())).size !== headers.length)
    throw invalidField('csv', 'Duplicate headers');
  if (!headers.includes('Work Item Type') || !headers.some((h) => /^Title(?: [1-9]\d*)?$/u.test(h)))
    throw invalidField('csv', 'Work Item Type and Title columns are required');
  return {
    headers,
    rows: records.map((r) => {
      if (r.length !== headers.length)
        throw invalidField('csv', 'CSV row width differs from headers');
      return Object.fromEntries(headers.map((h, i) => [h, r[i]]));
    }),
  };
}

/**
 * Produces UTF-8 BOM/CRLF CSV. Formula-like text is rejected instead of mutating its content.
 * @param headers Explicit reviewed columns.
 * @param rows Complete data rows.
 * @returns CSV bytes for import, never a spreadsheet formula.
 */
export function writeCsv(headers: string[], rows: string[][]): string {
  if (rows.length > ADO_LIMITS.rows) throw invalidField('csv', 'CSV exceeds 1,000 rows');
  const quote = (s: string): string => {
    if (/^[\s\uFEFF]*[=+@-]/u.test(s))
      throw invalidField(
        'csv',
        'Formula-like cell blocked; review the source value before transfer',
      );
    if (
      Buffer.byteLength(s, 'utf8') > ADO_LIMITS.cellBytes ||
      s.includes('\0') ||
      /[\uD800-\uDFFF]/u.test(s)
    )
      throw invalidField('csv', 'Invalid or oversized output cell');
    return `"${s.replaceAll('"', '""')}"`;
  };
  if (rows.some((r) => r.length !== headers.length))
    throw invalidField('csv', 'Invalid output row width');
  return '\uFEFF' + [headers, ...rows].map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n';
}

/**
 * Validates remote identity without unsafe numeric coercion.
 * @param value Remote ID text.
 * @returns The unchanged canonical positive ID.
 */
export function remoteId(value: string): string {
  if (!/^[1-9]\d{0,19}$/u.test(value))
    throw invalidField('ID', 'ADO IDs must be canonical positive decimal strings');
  return value;
}
