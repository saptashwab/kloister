import {
  imageIdsIn,
  mentionedIds,
  sanitizeRichText,
  sanitizeWithMentions,
} from './sanitize-html.js';

// Inline images and mentions (SPEC §5): images only from the item's own
// endpoint, mentions only of allowed users. The base allow-list is covered
// in item-helpers.spec.ts.

const IMG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_IMG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STRANGER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PREFIX = 'api/v1/projects/p/items/i/images/';
const images = { prefix: PREFIX, ids: new Set([IMG]) };

describe('sanitizeRichText inline images', () => {
  it('keeps an image of the same item with its alternative text', () => {
    const html = `<p><img src="${PREFIX}${IMG}" alt="Screenshot" /></p>`;
    expect(sanitizeRichText(html, { images })).toBe(
      `<p><img src="${PREFIX}${IMG}" alt="Screenshot" /></p>`,
    );
  });

  it('drops images of other items, other hosts, data URLs and unknown ids', () => {
    for (const src of [
      `api/v1/projects/p/items/other/images/${IMG}`,
      `https://evil.example/${PREFIX}${IMG}`,
      `/${PREFIX}${IMG}`,
      `${PREFIX}${OTHER_IMG}`,
      `${PREFIX}${IMG}?x=1`,
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
    ]) {
      expect(sanitizeRichText(`<p>a<img src="${src}">b</p>`, { images })).toBe('<p>ab</p>');
    }
  });

  it('drops every image when no image rule is given (new items)', () => {
    expect(sanitizeRichText(`<img src="${PREFIX}${IMG}">x`)).toBe('x');
  });

  it('strips image attributes other than src and alt', () => {
    expect(
      sanitizeRichText(`<img src="${PREFIX}${IMG}" onerror="x()" style="a" width="9">`, {
        images,
      }),
    ).toBe(`<img src="${PREFIX}${IMG}" />`);
  });
});

describe('sanitizeRichText mentions', () => {
  const mentions = new Map([[USER, 'Mia Member']]);

  it('keeps mentions of allowed users, lowercasing the id and showing their real name', () => {
    const html = `<p>Hi <span data-mention="${USER.toUpperCase()}" class="x">@Boss</span></p>`;
    expect(sanitizeRichText(html, { mentions })).toBe(
      `<p>Hi <span data-mention="${USER}">@Mia Member</span></p>`,
    );
  });

  it('unwraps mentions of anyone else, and plain spans, to their text', () => {
    expect(
      sanitizeRichText(`<span data-mention="${STRANGER}">@Eve</span> <span>x</span>`, {
        mentions,
      }),
    ).toBe('@Eve x');
    expect(sanitizeRichText(`<span data-mention="${USER}">@Mia</span>`)).toBe('@Mia');
  });

  it('reports mentioned users once, in order, from the parsed spans only', () => {
    const result = sanitizeWithMentions(
      `<span data-mention="${USER}">@Mia</span> <span data-mention="${USER}">@Mia</span>`,
      { mentions },
    );
    expect(result.mentioned).toEqual([USER]);
    expect(mentionedIds(result.html)).toEqual([USER]);
  });

  it('never counts text that only looks like a mention', () => {
    const spoof = `<p>data-mention="${USER}" hello</p>`;
    const result = sanitizeWithMentions(spoof, { mentions });
    expect(result.mentioned).toEqual([]);
    expect(mentionedIds(result.html)).toEqual([]);
  });
});

describe('imageIdsIn', () => {
  it('finds candidate image ids, lowercased and distinct', () => {
    const html = `<img src="${PREFIX}${IMG.toUpperCase()}"><img src="x/images/${IMG}"><img src="${PREFIX}${OTHER_IMG}">`;
    expect(imageIdsIn(html)).toEqual([IMG, OTHER_IMG]);
  });
});
