import { INLINE_IMAGE_TYPES, type ItemType, parseReferenceKey } from '@kloister/shared';

/** Someone who can be mentioned in a note. */
export interface Mentionable {
  /** User id. */
  id: string;
  /** Display name. */
  name: string;
}

/** An image in a description or note, for the full-size viewer. */
export interface ViewerImage {
  /** App-relative source. */
  src: string;
  /** Alternative text, used as the viewer's name. */
  alt: string;
}

/** An item that can be referenced with `#` or its key (M12). */
export interface Referable {
  /** Canonical key, e.g. `KLO-12` (`#12` in a personal space). */
  key: string;
  /** Title. */
  title: string;
  /** Type. */
  type: ItemType;
}

/** Class of a mention in displayed and edited rich text. */
export const MENTION_CLASS = 'k-mention';

/** Class of an item reference in displayed and edited rich text (M12). */
export const REFERENCE_CLASS = 'k-ref';

/**
 * The app path of a referenced item's drawer, relative to the base href so
 * it also works below a path prefix.
 *
 * @param key Canonical key.
 * @returns The path, or null when the key is malformed.
 */
export function referencePath(key: string): string | null {
  const ref = parseReferenceKey(key);
  return ref === null ? null : `p/${ref.key ?? 'personal'}/items/${ref.number}`;
}

/** Class of an inline image in displayed rich text. */
export const IMAGE_CLASS = 'k-inline-img';

/**
 * Parses HTML into an inert document: nothing in it runs or loads.
 *
 * @param html HTML.
 * @returns The document.
 */
function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/**
 * Prepares stored rich text (already sanitized by the API, SPEC §5) for an
 * `[innerHTML]` binding, which Angular sanitizes again: mentions get the
 * mention style, item references (M12) become links to the item's drawer
 * and images become focusable, so Enter can open the viewer. Only classes,
 * links and `tabindex` are added, all of which Angular keeps. The API sends
 * marks only for items the reader can see.
 *
 * @param html Stored HTML.
 * @returns HTML for display.
 */
export function forDisplay(html: string): string {
  if (html === '') return '';
  const doc = parse(html);
  for (const span of doc.body.querySelectorAll('span[data-mention]')) {
    span.classList.add(MENTION_CLASS);
  }
  for (const span of doc.body.querySelectorAll('span[data-ref]')) {
    const key = span.getAttribute('data-ref') ?? '';
    const path = referencePath(key);
    if (path === null) {
      span.replaceWith(doc.createTextNode(span.textContent ?? ''));
      continue;
    }
    const link = doc.createElement('a');
    link.className = REFERENCE_CLASS;
    link.setAttribute('href', path);
    link.textContent = key;
    span.replaceWith(link);
  }
  for (const img of doc.body.querySelectorAll('img')) {
    img.classList.add(IMAGE_CLASS);
    img.setAttribute('tabindex', '0');
  }
  return doc.body.innerHTML;
}

/**
 * Prepares stored rich text for a content-editable area. It is sanitized
 * like any displayed HTML, which drops `data-*` attributes, so each
 * mention's user id and each reference's key (M12) are carried over by
 * position and put back afterwards. Mentions and references are not editable
 * letter by letter: they are removed whole.
 *
 * @param html Stored HTML.
 * @param sanitize Angular's HTML sanitizer.
 * @returns HTML to put into the editing area.
 */
export function forEditing(html: string, sanitize: (html: string) => string): string {
  if (html === '') return '';
  const doc = parse(html);
  const ids: string[] = [];
  for (const span of doc.body.querySelectorAll('span[data-mention]')) {
    ids.push(span.getAttribute('data-mention') ?? '');
    span.setAttribute('class', MENTION_CLASS);
  }
  const keys: string[] = [];
  for (const span of doc.body.querySelectorAll('span[data-ref]')) {
    keys.push(span.getAttribute('data-ref') ?? '');
    span.setAttribute('class', REFERENCE_CLASS);
  }
  const clean = parse(sanitize(doc.body.innerHTML));
  const refs = [...clean.body.querySelectorAll(`span.${REFERENCE_CLASS}`)];
  refs.forEach((span, index) => {
    const key = refs.length === keys.length ? keys[index] : undefined;
    if (key === undefined || parseReferenceKey(key) === null) {
      span.removeAttribute('class');
      return;
    }
    span.setAttribute('data-ref', key);
    span.setAttribute('contenteditable', 'false');
  });
  const marked = [...clean.body.querySelectorAll(`span.${MENTION_CLASS}`)];
  marked.forEach((span, index) => {
    const id = marked.length === ids.length ? ids[index] : undefined;
    if (id === undefined || id === '') {
      span.removeAttribute('class');
      return;
    }
    span.setAttribute('data-mention', id);
    span.setAttribute('contenteditable', 'false');
  });
  return clean.body.innerHTML;
}

/**
 * Cleans HTML pasted from elsewhere before it enters an editing area: it is
 * sanitized like displayed HTML, and only images of the edited item itself
 * are kept. The API keeps nothing else on save (SPEC §5), so the editor
 * never shows a picture that would vanish, nor loads one from another host.
 *
 * @param html Pasted HTML.
 * @param sanitize Angular's HTML sanitizer.
 * @param imagePrefix The item's inline-image URL prefix, or null to drop every image.
 * @returns HTML to insert.
 */
export function cleanPastedHtml(
  html: string,
  sanitize: (html: string) => string,
  imagePrefix: string | null,
): string {
  const doc = parse(sanitize(html));
  for (const img of doc.body.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    const id =
      imagePrefix !== null && src.startsWith(imagePrefix) ? src.slice(imagePrefix.length) : '';
    if (!/^[0-9a-f-]{36}$/.test(id)) img.remove();
  }
  return doc.body.innerHTML;
}

/**
 * Builds the HTML of a mention for inserting into an editing area.
 *
 * @param person Who is mentioned.
 * @returns A non-editable span carrying the user id.
 */
export function mentionElement(person: Mentionable): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = MENTION_CLASS;
  span.setAttribute('data-mention', person.id);
  span.setAttribute('contenteditable', 'false');
  span.textContent = `@${person.name}`;
  return span;
}

/**
 * Builds a reference for inserting into an editing area (M12).
 *
 * @param item The referenced item.
 * @returns A non-editable span carrying the key.
 */
export function referenceElement(item: Referable): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = REFERENCE_CLASS;
  span.setAttribute('data-ref', item.key);
  span.setAttribute('contenteditable', 'false');
  span.textContent = item.key;
  return span;
}

/** A `#` or `KEY-` being typed, with what follows it so far. */
const REFERENCE_QUERY = /(?:^|[\s(])(#|[A-Z]{2,6}-)([^\s#@]{0,40})$/u;

/**
 * Finds an item reference being typed just before the caret (M12): `#` and
 * a number or words, or the project key and a dash.
 *
 * @param before The text of the caret's text node up to the caret.
 * @param projectKey The open project's key, or null in a personal space.
 * @returns The typed query and where its `#` or key starts, or null.
 */
export function referenceAt(
  before: string,
  projectKey: string | null,
): { query: string; start: number } | null {
  const match = REFERENCE_QUERY.exec(before);
  if (match === null) return null;
  const lead = match[1] ?? '';
  if (lead !== '#' && lead !== `${projectKey ?? ''}-`) return null;
  const query = match[2] ?? '';
  return { query, start: before.length - query.length - lead.length };
}

/**
 * The items offered for a typed reference: numbers starting with the query
 * first, then titles containing it.
 *
 * @param items Items the writer can see.
 * @param query What follows `#` or the key.
 * @param limit Most suggestions.
 * @returns Suggestions in order.
 */
export function referenceSuggestions(
  items: readonly Referable[],
  query: string,
  limit = 8,
): Referable[] {
  const q = query.toLowerCase();
  const number = (key: string): string => /\d+$/.exec(key)?.[0] ?? '';
  const byNumber = items.filter((i) => q !== '' && number(i.key).startsWith(q));
  const byTitle = items.filter((i) => !byNumber.includes(i) && i.title.toLowerCase().includes(q));
  return [...byNumber, ...byTitle].slice(0, limit);
}

/** An `@` being typed: at the start of the text or after a space or bracket. */
const MENTION_QUERY = /(?:^|[\s(])@([^\s@]{0,40})$/u;

/**
 * Finds a mention being typed just before the caret.
 *
 * @param before The text of the caret's text node up to the caret.
 * @returns The typed name so far and where its `@` is, or null.
 */
export function mentionAt(before: string): { query: string; start: number } | null {
  const match = MENTION_QUERY.exec(before);
  if (match === null) return null;
  const query = match[1] ?? '';
  return { query, start: before.length - query.length - 1 };
}

/**
 * The people offered for a typed name: names starting with it first, then
 * names containing it, case-insensitively.
 *
 * @param people Everyone who can be mentioned.
 * @param query The typed name.
 * @param limit Most suggestions.
 * @returns Suggestions in order.
 */
export function mentionSuggestions(
  people: readonly Mentionable[],
  query: string,
  limit = 8,
): Mentionable[] {
  const q = query.toLowerCase();
  const starts = people.filter((p) => p.name.toLowerCase().startsWith(q));
  const contains = people.filter(
    (p) => !p.name.toLowerCase().startsWith(q) && p.name.toLowerCase().includes(q),
  );
  return [...starts, ...contains].slice(0, limit);
}

/**
 * Reports whether a file is an image the API accepts inline (SPEC §5). The
 * API checks the content again; this only spares a pointless upload.
 *
 * @param file A pasted or dropped file.
 * @returns True for PNG, JPEG, GIF and WebP.
 */
export function isInlineImage(file: File): boolean {
  return (INLINE_IMAGE_TYPES as readonly string[]).includes(file.type);
}

/**
 * The images inside a rendered description or note, in order.
 *
 * @param container The element holding the rich text.
 * @returns The images.
 */
export function imagesIn(container: Element): ViewerImage[] {
  return [...container.querySelectorAll('img')].map((img) => ({
    src: img.getAttribute('src') ?? '',
    alt: img.getAttribute('alt') ?? '',
  }));
}
