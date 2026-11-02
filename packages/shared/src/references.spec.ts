import {
  markedReferences,
  parseReferenceKey,
  referenceKey,
  referenceTokens,
  unmarkReferences,
} from './index.js';

describe('item references (M12)', () => {
  it('finds keys and same-project numbers, not glued to other words', () => {
    expect(
      referenceTokens('See KLO-12, #7 and (OPS-3). Not ABC-1x, xKLO-2, #4a, &#39; or 2-KLO-5').map(
        (t) => t.text,
      ),
    ).toEqual(['KLO-12', '#7', 'OPS-3']);
    expect(referenceTokens('#12')[0]).toEqual({ text: '#12', key: null, number: 12, index: 0 });
    expect(referenceTokens('TOOLONGKEY-1 or K-1')).toEqual([]);
  });

  it('unmarks marks whatever they hold', () => {
    expect(unmarkReferences('<span data-ref="KLO-1">KLO-1<b></b>z</span>', () => false)).toBe(
      '<span>KLO-1<b></b>z</span>',
    );
  });

  it('builds and parses canonical keys, with #N for personal spaces', () => {
    expect(referenceKey('KLO', 12)).toBe('KLO-12');
    expect(referenceKey(null, 12)).toBe('#12');
    expect(parseReferenceKey('KLO-12')).toEqual({ key: 'KLO', number: 12 });
    expect(parseReferenceKey('#3')).toEqual({ key: null, number: 3 });
    expect(parseReferenceKey('klo-1')).toBeNull();
  });

  it('reads marks and turns hidden ones back into plain text', () => {
    const html =
      '<p><span data-ref="KLO-1">KLO-1</span> and <span data-ref="OPS-2">OPS-2</span> <span data-mention="x">@A</span></p>';
    expect(markedReferences(html)).toEqual(['KLO-1', 'OPS-2']);
    expect(unmarkReferences(html, (key) => key === 'KLO-1')).toBe(
      '<p><span data-ref="KLO-1">KLO-1</span> and <span>OPS-2</span> <span data-mention="x">@A</span></p>',
    );
  });
});
