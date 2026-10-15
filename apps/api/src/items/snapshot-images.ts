import sanitizeHtml from 'sanitize-html';

/**
 * Reads actual image attributes, never image-looking ordinary text or links.
 * @param html Previously sanitized item content.
 * @returns Unique image sources in document order.
 */
export function inlineSources(html: string): string[] {
  const sources = new Set<string>();
  rewriteImages(html, (source) => {
    sources.add(source);
    return source;
  });
  return [...sources];
}

/**
 * Rewrites only image src attributes in already sanitized rich text.
 * @param html Previously sanitized HTML, including original readable formatting.
 * @param source Maps independently authorized image paths.
 * @returns HTML retaining ordinary text, links and formatting.
 */
export function rewriteImages(html: string, source: (original: string) => string): string {
  return sanitizeHtml(html, {
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
    allowedAttributes: { a: ['href', 'title', 'rel'], img: ['src', 'alt'], span: ['data-mention'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    transformTags: {
      img: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, src: source(attribs['src'] ?? '') },
      }),
    },
  });
}
