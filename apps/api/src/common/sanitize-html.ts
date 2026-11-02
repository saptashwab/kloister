import { referencePattern } from '@kloister/shared';
import sanitizeHtml from 'sanitize-html';

/**
 * What a rich-text field may contain beyond plain formatting. Both default to
 * nothing: without rules, images are dropped and mentions become plain text.
 */
export interface RichTextRules {
  /**
   * Inline images to keep (SPEC §5): an `<img>` survives only when its
   * source is exactly `prefix` followed by one of `ids`, i.e. the app's own
   * inline-image endpoint of the same item.
   */
  images?: { prefix: string; ids: ReadonlySet<string> };
  /**
   * Users who may be mentioned, with their display names: a
   * `<span data-mention="<id>">` survives only for these ids, and its text is
   * rewritten to `@<display name>`, so a mention always shows who it
   * notifies. Any other span is unwrapped to its text.
   */
  mentions?: ReadonlyMap<string, string>;
  /**
   * Item references the writer may see (M12), from the text as written
   * (`#12`, `KLO-12`) to the canonical key: such text, typed or already in a
   * `<span data-ref>`, becomes `<span data-ref="KLO-12">KLO-12</span>`. Any
   * other reference stays plain text.
   */
  references?: ReadonlyMap<string, string>;
}

/** Parents whose text is never turned into references. */
const NO_REFERENCES = new Set(['a', 'code', 'pre', 'span']);

/** A tag name that is never allowed, used to unwrap an element to its text. */
const UNWRAP = 'kloister-unwrap';

/**
 * The rich-text allow-list (SPEC §5): formatting, lists, quotes, code and
 * links, plus the inline images and mentions that {@link RichTextRules}
 * admit. No media, forms, scripts, styles or class names, so stored text can
 * neither run code nor load anything from another host.
 *
 * @param rules Images, mentions and references to keep.
 * @param found Collects the ids of the mentions kept.
 * @param refs Collects the canonical keys of the references kept.
 * @returns The sanitize-html options.
 */
function options(
  rules: RichTextRules,
  found: Set<string>,
  refs: Set<string> = new Set(),
): sanitizeHtml.IOptions {
  const images = rules.images;
  const mentions = rules.mentions ?? new Map<string, string>();
  const references = rules.references ?? new Map<string, string>();
  const imageAllowed = (src: string | undefined): boolean => {
    if (images === undefined || src === undefined || !src.startsWith(images.prefix)) return false;
    return images.ids.has(src.slice(images.prefix.length));
  };
  return {
    allowedTags: [
      'p',
      'br',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'strike',
      'del',
      'sub',
      'sup',
      'code',
      'pre',
      'blockquote',
      'ul',
      'ol',
      'li',
      'h1',
      'h2',
      'h3',
      'h4',
      'hr',
      'a',
      'img',
      'span',
    ],
    // `rel` is always overwritten by the transform below.
    allowedAttributes: {
      a: ['href', 'title', 'rel'],
      img: ['src', 'alt'],
      span: ['data-mention', 'data-ref'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    // Image sources are checked exactly by the filter below instead.
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    // Script and style bodies are dropped with their tags, not kept as text.
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title'],
    disallowedTagsMode: 'discard',
    transformTags: {
      // Links open without giving the target page a handle on the app.
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow' }),
      // Only mentions of allowed users stay spans; anything else keeps its text only.
      span: (tagName, attribs): sanitizeHtml.Tag => {
        const ref = attribs['data-ref'];
        const key = ref === undefined ? undefined : references.get(ref);
        if (key !== undefined) {
          refs.add(key);
          return { tagName, attribs: { 'data-ref': key }, text: key };
        }
        const id = attribs['data-mention']?.toLowerCase();
        const name = id === undefined ? undefined : mentions.get(id);
        if (id === undefined || name === undefined) return { tagName: UNWRAP, attribs: {} };
        // Collected while parsing, so text that merely looks like a mention
        // never counts as one.
        found.add(id);
        return { tagName, attribs: { 'data-mention': id }, text: `@${name}` };
      },
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && !imageAllowed(frame.attribs['src']),
    // Typed references the writer may see become marks; the replacement is
    // built only from the validated canonical key.
    textFilter: (text, tagName) =>
      references.size === 0 || NO_REFERENCES.has(tagName)
        ? text
        : text.replace(referencePattern(), (token) => {
            const key = references.get(token);
            if (key === undefined) return token;
            refs.add(key);
            return `<span data-ref="${key}">${key}</span>`;
          }),
  };
}

/**
 * Sanitizes user-supplied rich text against the allow-list (SPEC §5). Run on
 * every write of an HTML field: item descriptions and notes.
 *
 * @param html Untrusted HTML from a request body.
 * @param rules Inline images and mentions to keep; none by default.
 * @returns Safe HTML, trimmed.
 */
export function sanitizeRichText(html: string, rules: RichTextRules = {}): string {
  return sanitizeHtml(html, options(rules, new Set())).trim();
}

/**
 * Sanitizes rich text like {@link sanitizeRichText} and also reports whom
 * the kept mentions name and which items the kept references name.
 *
 * @param html Untrusted HTML from a request body.
 * @param rules Inline images, mentions and references to keep.
 * @returns Safe HTML, the mentioned user ids and the referenced canonical
 *   keys, each in order of first mention.
 */
export function sanitizeWithMentions(
  html: string,
  rules: RichTextRules,
): { html: string; mentioned: string[]; references: string[] } {
  const found = new Set<string>();
  const refs = new Set<string>();
  const clean = sanitizeHtml(html, options(rules, found, refs)).trim();
  return { html: clean, mentioned: [...found], references: [...refs] };
}

/** A uuid inside an inline-image source. */
const IMAGE_ID = /\/images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/**
 * Candidate inline-image ids in untrusted HTML, lowercased, for looking up
 * which of them really are images of the item before sanitizing.
 *
 * @param html Untrusted HTML.
 * @returns Distinct ids, at most 200.
 */
export function imageIdsIn(html: string): string[] {
  return [...new Set([...html.matchAll(IMAGE_ID)].map((m) => (m[1] ?? '').toLowerCase()))].slice(
    0,
    200,
  );
}

/**
 * The users mentioned in stored (already sanitized) HTML, found by parsing
 * it, never by searching its text.
 *
 * @param html HTML returned by {@link sanitizeRichText}.
 * @returns Distinct user ids, in order of first mention.
 */
export function mentionedIds(html: string): string[] {
  const found: string[] = [];
  sanitizeHtml(html, {
    allowedTags: false,
    allowedAttributes: false,
    transformTags: {
      span: (tagName, attribs): sanitizeHtml.Tag => {
        const id = attribs['data-mention'];
        if (id !== undefined && !found.includes(id)) found.push(id);
        return { tagName, attribs };
      },
    },
  });
  return found;
}
