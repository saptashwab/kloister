import { isCalendarDate, fromDbDate, toDbDate } from './dates.js';
import { placeAfter, POSITION_STEP, positionAtEnd } from './positions.js';
import { sanitizeRichText } from './sanitize-html.js';
import { lowercaseUuids, UuidParamCasePipe } from './uuid.js';

// Helpers added with work items: fractional positions, calendar dates and the
// rich-text allow-list (SPEC §5).

describe('placeAfter', () => {
  const rows = (...positions: number[]) =>
    positions.map((position, i) => ({ id: `r${i}`, position }));

  it('places first, between and last without renumbering', () => {
    expect(placeAfter([], null)).toEqual({ position: POSITION_STEP, renumber: [] });
    expect(placeAfter(rows(1024, 2048), null)).toEqual({ position: 0, renumber: [] });
    expect(placeAfter(rows(1024, 2048), 'r0')).toEqual({ position: 1536, renumber: [] });
    expect(placeAfter(rows(1024, 2048), 'r1')).toEqual({ position: 3072, renumber: [] });
  });

  it('renumbers every sibling when the gap is used up', () => {
    const a = 1;
    const b = a + Number.EPSILON;
    const result = placeAfter(rows(a, b, 5), 'r0');
    expect(result.renumber).toEqual([
      { id: 'r0', position: POSITION_STEP },
      { id: 'r1', position: 3 * POSITION_STEP },
      { id: 'r2', position: 4 * POSITION_STEP },
    ]);
    expect(result.position).toBe(2 * POSITION_STEP);
  });

  it('keeps finding room across many bisections', () => {
    // Always insert right after the first row, squeezing the same gap.
    let [first, second] = rows(0, 1);
    for (let i = 0; i < 200 && first !== undefined && second !== undefined; i++) {
      const { position, renumber } = placeAfter([first, second], first.id);
      const updated = new Map(renumber.map((r) => [r.id, r.position]));
      first = { ...first, position: updated.get(first.id) ?? first.position };
      second = { ...second, position: updated.get(second.id) ?? second.position };
      expect(position).toBeGreaterThan(first.position);
      expect(position).toBeLessThan(second.position);
      // The new row becomes the second row for the next round.
      second = { id: `n${i}`, position };
    }
  });

  it('refuses an afterId that is not a sibling', () => {
    expect(() => placeAfter(rows(1), 'nope')).toThrow();
  });

  it('appends after the last position', () => {
    expect(positionAtEnd(null)).toBe(POSITION_STEP);
    expect(positionAtEnd(10)).toBe(10 + POSITION_STEP);
  });
});

describe('calendar dates', () => {
  it.each(['2026-01-31', '2024-02-29'])('accepts %s', (value) => {
    expect(isCalendarDate(value)).toBe(true);
    expect(fromDbDate(toDbDate(value))).toBe(value);
  });

  it.each(['2026-02-30', '2026-13-01', '26-01-01', '2026-01-01T00:00:00Z', 20260101, null])(
    'rejects %s',
    (value) => {
      expect(isCalendarDate(value)).toBe(false);
    },
  );

  it('maps null through', () => {
    expect(fromDbDate(null)).toBeNull();
  });
});

describe('sanitizeRichText (SPEC §5 allow-list)', () => {
  it('keeps allowed formatting', () => {
    const html =
      '<p><strong>Bold</strong> <em>it</em></p><ul><li>one</li></ul><pre><code>x</code></pre>';
    expect(sanitizeRichText(html)).toBe(html);
  });

  it('drops scripts, styles and event handlers', () => {
    expect(sanitizeRichText('<p onclick="x()">Hi</p><script>alert(1)</script>')).toBe('<p>Hi</p>');
    expect(sanitizeRichText('<style>p{}</style><p style="color:red">x</p>')).toBe('<p>x</p>');
  });

  it('drops images, iframes and forms so nothing loads from another host', () => {
    expect(
      sanitizeRichText(
        '<img src="http://t.example/x.png"><iframe src="x"></iframe><form></form>ok',
      ),
    ).toBe('ok');
  });

  it('only keeps http, https and mailto links, with a safe rel', () => {
    expect(sanitizeRichText('<a href="javascript:alert(1)">x</a>')).toBe(
      '<a rel="noopener noreferrer nofollow">x</a>',
    );
    expect(sanitizeRichText('<a href="https://example.org" target="_blank">x</a>')).toBe(
      '<a href="https://example.org" rel="noopener noreferrer nofollow">x</a>',
    );
    expect(sanitizeRichText('<a href="https://example.org" rel="opener">x</a>')).toBe(
      '<a href="https://example.org" rel="noopener noreferrer nofollow">x</a>',
    );
    expect(sanitizeRichText('<a href="//example.org">x</a>')).toBe(
      '<a rel="noopener noreferrer nofollow">x</a>',
    );
  });

  it('escapes stray markup and trims', () => {
    expect(sanitizeRichText('  a < b  ')).toBe('a &lt; b');
  });
});

describe('uuid case normalisation', () => {
  const UPPER = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  const lower = UPPER.toLowerCase();

  it('lowercases uuids and uuid arrays only', () => {
    expect(lowercaseUuids(UPPER)).toBe(lower);
    expect(lowercaseUuids([UPPER, 'KLO'])).toEqual([lower, 'KLO']);
    expect(lowercaseUuids('KLO')).toBe('KLO');
    expect(lowercaseUuids(42)).toBe(42);
  });

  it('only touches path parameters', () => {
    const pipe = new UuidParamCasePipe();
    expect(pipe.transform(UPPER, { type: 'param' })).toBe(lower);
    expect(pipe.transform(UPPER, { type: 'body' })).toBe(UPPER);
  });
});
