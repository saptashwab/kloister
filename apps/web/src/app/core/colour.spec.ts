import { LabelStyle } from '@kloister/shared';
import {
  AVATAR_COLOURS,
  avatarColours,
  contrastRatio,
  DARK_TEXT,
  initials,
  LABEL_PALETTE,
  labelVars,
  LIGHT_TEXT,
  MIN_CONTRAST,
  parseHex,
  solidLabel,
  tintedLabel,
} from './colour';

describe('colour', () => {
  it('parses short and long hex colours', () => {
    expect(parseHex('#abc')).toEqual([170, 187, 204]);
    expect(parseHex('3E63DD')).toEqual([62, 99, 221]);
    expect(parseHex('red')).toBeNull();
  });

  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
    expect(contrastRatio('#4F46E5', '#FFFFFF')).toBeCloseTo(6.29, 1);
  });

  it('gives every palette colour solid text of at least 4.5:1, unchanged', () => {
    for (const { hex } of LABEL_PALETTE) {
      const c = solidLabel(hex);
      expect(c.bg).toBe(hex);
      expect(contrastRatio(c.bg, c.fg)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });

  it('picks the text colour with the higher contrast (DESIGN §4.3)', () => {
    const text = (name: string): string =>
      solidLabel(LABEL_PALETTE.find((p) => p.name === name)?.hex ?? '').fg;
    for (const name of ['Amber', 'Lime', 'Orange', 'Green', 'Teal', 'Cyan', 'Blue', 'Red']) {
      expect(text(name)).toBe(DARK_TEXT);
    }
    for (const name of ['Indigo', 'Violet', 'Pink', 'Slate']) {
      expect(text(name)).toBe(LIGHT_TEXT);
    }
  });

  it('adjusts custom fills in the mid-luminance band until text reaches 4.5:1', () => {
    // Neither text colour reaches 4.5:1 on this pink.
    expect(contrastRatio('#D6409F', DARK_TEXT)).toBeLessThan(MIN_CONTRAST);
    expect(contrastRatio('#D6409F', LIGHT_TEXT)).toBeLessThan(MIN_CONTRAST);
    for (const hex of [
      '#D6409F',
      '#E5484D',
      '#808080',
      '#7F7FFF',
      '#C0C0C0',
      '#000000',
      '#FFFFFF',
    ]) {
      const c = solidLabel(hex);
      expect(contrastRatio(c.bg, c.fg)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
    expect(solidLabel('#D6409F').bg).not.toBe('#D6409F');
  });

  it('keeps tinted label text readable in both modes', () => {
    for (const { hex } of LABEL_PALETTE) {
      for (const mode of ['light', 'dark'] as const) {
        const c = tintedLabel(hex, mode);
        expect(contrastRatio(c.bg, c.fg)).toBeGreaterThanOrEqual(MIN_CONTRAST);
      }
    }
  });

  it('builds CSS variables per label style', () => {
    expect(Object.keys(labelVars('#3E63DD', LabelStyle.SOLID))).toEqual([
      '--l-bg',
      '--l-fg',
      '--l-dot',
    ]);
    expect(labelVars('#3E63DD', LabelStyle.TINTED)).toHaveProperty('--l-fg-dark');
    expect(labelVars('#3E63DD', LabelStyle.COVER)).toHaveProperty('--l-bg-dark');
  });

  it('gives avatars a stable, readable colour pair', () => {
    for (const pair of AVATAR_COLOURS) {
      expect(contrastRatio(pair.bg, pair.fg)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
    const id = '6f1c0f2e-5a7b-4c2e-9d3a-0b1c2d3e4f50';
    expect(avatarColours(id)).toBe(avatarColours(id));
  });

  it('makes initials from display names', () => {
    expect(initials('Ann Lee')).toBe('AL');
    expect(initials('mia van der berg')).toBe('MB');
    expect(initials('pat')).toBe('P');
    expect(initials('  ')).toBe('?');
  });
});
