import { DEFAULT_THEME, ThemeMode, UiFont } from '@kloister/shared';
import { contrastRatio } from './colour';
import { checkColour, deriveColours, FONT_STACKS, THEME_SWATCHES, themeCss } from './theme';

/** Backgrounds of each mode (DESIGN §2.1): ground, surface, sunken. */
const BACKGROUNDS = {
  light: ['#F6F7F9', '#FFFFFF', '#FBFBFC'],
  dark: ['#0E1117', '#161B24', '#121720', '#0B0E13'],
} as const;

/** Swatches plus colours that are hard to make readable. */
const COLOURS = [
  ...THEME_SWATCHES.map((s) => s.hex),
  '#FFFF00',
  '#FFFFFF',
  '#000000',
  '#777777',
  '#00FF00',
  '#0000FF',
  '#FF00FF',
  '#1D2040',
];

const NO_FONT = { font: UiFont.FIGTREE, fontFiles: null };

describe('theme colours (DESIGN §2.1, WCAG 2.2 AA)', () => {
  for (const mode of ['light', 'dark'] as const) {
    it.each(COLOURS)(`keeps every %s derived token readable in ${mode} mode`, (hex) => {
      const c = deriveColours(hex, hex, mode);
      for (const bg of BACKGROUNDS[mode]) {
        // Links and primary text on every background.
        expect(contrastRatio(c.primary, bg)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(c.onPrimary, c.primary)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.primaryInk, c.primarySoft)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.onAccent, c.accent)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('keeps a colour that is already readable and darkens or lightens one that is not', () => {
    expect(deriveColours('#0F766E', '#0F766E', 'light').primary).toBe('#0F766E');
    const yellow = checkColour('#FFFF00', 'primary');
    expect(yellow.light.adjusted).toBe(true);
    expect(yellow.light.ratio).toBeGreaterThanOrEqual(4.5);
    expect(yellow.dark.adjusted).toBe(false);
    const navy = checkColour('#1D2040', 'primary');
    expect(navy.light.adjusted).toBe(false);
    expect(navy.dark.adjusted).toBe(true);
  });
});

describe('themeCss', () => {
  it('leaves the default theme and font to the design tokens', () => {
    expect(themeCss(DEFAULT_THEME, NO_FONT)).toBe('');
    expect(themeCss({ ...DEFAULT_THEME, mode: ThemeMode.DARK }, NO_FONT)).toBe('');
  });

  it('overrides the primary and accent tokens in both modes for a custom theme', () => {
    const css = themeCss(
      { mode: ThemeMode.SYSTEM, primary: '#0F766E', accent: '#C2410C' },
      NO_FONT,
    );
    expect(css).toContain(':root{--k-primary:#0F766E;');
    expect(css).toContain('--k-on-accent:');
    expect(css).toContain("@media (prefers-color-scheme: dark){:root:not([data-theme='light']){");
    expect(css).toContain(":root[data-theme='dark']{--k-primary:");
    // Only hex colours, never text from the theme, reach the style sheet.
    expect(css).not.toMatch(/url|expression|;\s*}/i);
  });

  it('sets the UI font stack, and @font-face rules for uploaded files', () => {
    expect(themeCss(DEFAULT_THEME, { font: UiFont.GEORGIA, fontFiles: null })).toBe(
      `:root{--k-font:${FONT_STACKS.GEORGIA}}`,
    );
    const css = themeCss(DEFAULT_THEME, {
      font: UiFont.UPLOADED,
      fontFiles: {
        regular: 'api/v1/branding/fonts/regular?v=0123abcd',
        bold: 'api/v1/branding/fonts/bold?v=4567ef',
      },
    });
    expect(css).toContain("src:url('api/v1/branding/fonts/regular?v=0123abcd');font-weight:400");
    expect(css).toContain("src:url('api/v1/branding/fonts/bold?v=4567ef');font-weight:700");
    expect(css).toContain('font-display:swap');
    expect(css).toContain(`--k-font:${FONT_STACKS.UPLOADED}`);
  });

  it('falls back to Figtree when uploaded font URLs are not the app’s own', () => {
    const css = themeCss(DEFAULT_THEME, {
      font: UiFont.UPLOADED,
      fontFiles: { regular: "https://example.com/x.woff2');}body{display:none", bold: null },
    });
    expect(css).toBe('');
  });
});
