import type { FontType, InlineImageType } from '@kloister/shared';

/** How many leading bytes {@link sniffType} needs. */
export const SNIFF_BYTES = 16;

/** Type stored for files whose content matches no known signature. */
export const UNKNOWN_TYPE = 'application/octet-stream';

/**
 * Detects a file's type from its first bytes (its "magic number"), never
 * from its name or the client's claim (SPEC §5). Only PNG, JPEG, GIF, WebP
 * and PDF are recognised; SVG and other text formats never are, so they can
 * never be served as images.
 *
 * @param head The first {@link SNIFF_BYTES} bytes (fewer for tiny files).
 * @returns The MIME type, or null when unrecognised.
 */
export function sniffType(head: Uint8Array): InlineImageType | 'application/pdf' | null {
  const starts = (...bytes: number[]): boolean => bytes.every((b, i) => head[i] === b);
  const ascii = (offset: number, text: string): boolean =>
    [...text].every((c, i) => head[offset + i] === c.charCodeAt(0));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, '%PDF-')) return 'application/pdf';
  return null;
}

/**
 * Detects a font file from its first bytes (docs/DESIGN.md §6 upload rule):
 * WOFF2 (`wOF2`), WOFF (`wOFF`), TrueType (version 1.0 or `true`) and
 * OpenType with CFF outlines (`OTTO`). Font collections and anything else
 * are refused.
 *
 * @param head The first bytes of the file.
 * @returns The font type, or null when it is not a supported font.
 */
export function sniffFont(head: Uint8Array): FontType | null {
  const ascii = (text: string): boolean => [...text].every((c, i) => head[i] === c.charCodeAt(0));
  if (ascii('wOF2')) return 'font/woff2';
  if (ascii('wOFF')) return 'font/woff';
  if (ascii('OTTO')) return 'font/otf';
  if ((head[0] === 0 && head[1] === 1 && head[2] === 0 && head[3] === 0) || ascii('true')) {
    return 'font/ttf';
  }
  return null;
}

/**
 * Reports whether a detected type may be used as an inline image.
 *
 * @param type Result of {@link sniffType}.
 * @returns True for PNG, JPEG, GIF and WebP.
 */
export function isInlineImageType(type: string | null): type is InlineImageType {
  return (
    type === 'image/png' || type === 'image/jpeg' || type === 'image/gif' || type === 'image/webp'
  );
}

/**
 * Characters never kept in a file name: path separators, control characters
 * and format characters such as bidirectional overrides, which could make
 * `invoice‮fdp.exe` look like a PDF.
 */
const UNSAFE_NAME = /[\p{Cc}\p{Cf}/\\]/gu;

/**
 * Cleans an uploaded file name for storage and display: decodes the
 * percent-encoded header value, keeps only the last path segment, removes
 * control characters and shortens it.
 *
 * @param raw The header value, percent-encoded UTF-8, or undefined.
 * @param maxLength Longest name kept.
 * @returns A non-empty name.
 */
export function cleanFileName(raw: string | undefined, maxLength: number): string {
  let name = raw ?? '';
  try {
    name = decodeURIComponent(name);
  } catch {
    // Not valid percent-encoding: keep the raw text, cleaned below.
  }
  const last = name.split(/[/\\]/).pop() ?? '';
  const cleaned = last.replace(UNSAFE_NAME, '').trim();
  const short = [...cleaned].slice(0, maxLength).join('');
  return short === '' || short === '.' || short === '..' ? 'file' : short;
}

/**
 * Builds a `Content-Disposition` header (RFC 6266) with an ASCII fallback
 * name and the full UTF-8 name.
 *
 * @param kind `attachment` (download) or `inline`.
 * @param name The file name.
 * @returns The header value.
 */
export function contentDisposition(kind: 'attachment' | 'inline', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
