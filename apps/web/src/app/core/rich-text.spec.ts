import {
  cleanPastedHtml,
  forDisplay,
  forEditing,
  imagesIn,
  isInlineImage,
  mentionAt,
  mentionSuggestions,
} from './rich-text';

const MENTION = '<span data-mention="u2">@Bob</span>';
const IMG = '<img src="api/v1/projects/p/items/i/images/a" alt="Shot">';

/**
 * A stand-in for Angular's sanitizer that, like it, drops `data-*`
 * attributes but keeps classes.
 *
 * @param html HTML.
 * @returns The HTML without data attributes.
 */
function dropData(html: string): string {
  return html.replace(/ data-[a-z-]+="[^"]*"/g, '');
}

describe('forDisplay', () => {
  it('marks mentions and makes images focusable', () => {
    const html = forDisplay(`<p>Hi ${MENTION}</p>${IMG}`);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('span')?.className).toBe('k-mention');
    const img = doc.querySelector('img');
    expect(img?.getAttribute('tabindex')).toBe('0');
    expect(img?.className).toBe('k-inline-img');
  });

  it('leaves empty text empty', () => {
    expect(forDisplay('')).toBe('');
  });
});

describe('forEditing', () => {
  it('keeps mention ids through a sanitizer that drops data attributes', () => {
    const html = forEditing(`<p>${MENTION} and <span data-mention="u3">@Cy</span></p>`, dropData);
    const spans = [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('span')];
    expect(
      spans.map((s) => [s.getAttribute('data-mention'), s.getAttribute('contenteditable')]),
    ).toEqual([
      ['u2', 'false'],
      ['u3', 'false'],
    ]);
  });

  it('turns mentions into plain spans when the sanitizer removed some', () => {
    const removeFirst = (html: string) =>
      dropData(html).replace(/<span class="k-mention">@Bob<\/span>/, '@Bob');
    const html = forEditing(`${MENTION} <span data-mention="u3">@Cy</span>`, removeFirst);
    expect(html).not.toContain('data-mention');
  });
});

describe('mentionAt', () => {
  it('finds a name being typed after @', () => {
    expect(mentionAt('Hello @Mi')).toEqual({ query: 'Mi', start: 6 });
    expect(mentionAt('@')).toEqual({ query: '', start: 0 });
    expect(mentionAt('(@ann')).toEqual({ query: 'ann', start: 1 });
  });

  it('ignores email addresses and finished words', () => {
    expect(mentionAt('mail me@example.org')).toBeNull();
    expect(mentionAt('@Mia ')).toBeNull();
  });
});

describe('mentionSuggestions', () => {
  const people = [
    { id: '3', name: 'Tim Miller' },
    { id: '1', name: 'Mia Member' },
    { id: '2', name: 'Ada Adams' },
  ];

  it('puts names starting with the query first, ignoring case', () => {
    expect(mentionSuggestions(people, 'mi').map((p) => p.id)).toEqual(['1', '3']);
    expect(mentionSuggestions(people, '').map((p) => p.id)).toEqual(['3', '1', '2']);
    expect(mentionSuggestions(people, 'zz')).toEqual([]);
  });
});

describe('isInlineImage and imagesIn', () => {
  it('accepts only PNG, JPEG, GIF and WebP', () => {
    expect(isInlineImage(new File(['x'], 'a.png', { type: 'image/png' }))).toBe(true);
    expect(isInlineImage(new File(['x'], 'a.svg', { type: 'image/svg+xml' }))).toBe(false);
    expect(isInlineImage(new File(['x'], 'a.pdf', { type: 'application/pdf' }))).toBe(false);
  });

  it('lists the images of rendered text', () => {
    const div = document.createElement('div');
    div.innerHTML = `${IMG}<p>x</p><img src="b">`;
    expect(imagesIn(div)).toEqual([
      { src: 'api/v1/projects/p/items/i/images/a', alt: 'Shot' },
      { src: 'b', alt: '' },
    ]);
  });
});

describe('cleanPastedHtml', () => {
  const prefix = 'api/v1/projects/p/items/i/images/';
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('keeps only images of the edited item', () => {
    const html = `<img src="${prefix}${id}"><img src="api/v1/projects/p/items/other/images/${id}"><img src="https://evil.example/x.png">`;
    const kept = cleanPastedHtml(html, (h) => h, prefix);
    expect(kept.match(/<img/g)).toHaveLength(1);
    expect(kept).toContain(`${prefix}${id}`);
    expect(cleanPastedHtml(html, (h) => h, null)).not.toContain('<img');
  });
});
