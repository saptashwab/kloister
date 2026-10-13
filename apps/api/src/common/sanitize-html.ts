import sanitizeHtml from 'sanitize-html';

/**
 * The rich-text allow-list (SPEC §5). Formatting, lists, quotes, code and
 * links only: no images, media, forms, scripts, styles or class names, so
 * stored text can neither run code nor load anything from another host.
 */
const OPTIONS: sanitizeHtml.IOptions = {
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
  ],
  // `rel` is always overwritten by the transform below.
  allowedAttributes: { a: ['href', 'title', 'rel'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  // Script and style bodies are dropped with their tags, not kept as text.
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title'],
  disallowedTagsMode: 'discard',
  transformTags: {
    // Links open without giving the target page a handle on the app.
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow' }),
  },
};

/**
 * Sanitizes user-supplied rich text against the allow-list above (SPEC §5).
 * Run on every write of an HTML field (item descriptions; notes from M5).
 *
 * @param html Untrusted HTML from a request body.
 * @returns Safe HTML, trimmed.
 */
export function sanitizeRichText(html: string): string {
  return sanitizeHtml(html, OPTIONS).trim();
}
