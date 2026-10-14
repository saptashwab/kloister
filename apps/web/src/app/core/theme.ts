import {
  API_PREFIX,
  DEFAULT_THEME,
  type PublicBrandingDto,
  type ThemeDto,
  UiFont,
} from '@kloister/shared';
import {
  contrastRatio,
  MIN_CONTRAST,
  mixHex,
  parseHex,
  solidLabel,
  toHex,
  towardsContrast,
} from './colour';

/**
 * The backgrounds theme colours must stand out from, per mode (DESIGN §2.1):
 * the lightest background a primary-coloured text sits on in light mode
 * (the page ground, which is darker than the white surface and so the
 * stricter test) and in dark mode (the surface, the lightest dark background).
 */
const BACKGROUND = { light: '#F6F7F9', dark: '#161B24' } as const;

/** Card and panel surfaces, which soft fills are mixed onto. */
const SURFACE = { light: '#FFFFFF', dark: '#161B24' } as const;

/** Text on primary buttons, per mode (DESIGN §2.1 `--k-on-primary`). */
const ON_PRIMARY = { light: '#FFFFFF', dark: '#0E1117' } as const;

/** Contrast for non-text indicators such as the unread badge (WCAG 1.4.11). */
const GRAPHIC_CONTRAST = 3;

/**
 * The primary and accent tokens of the built-in indigo as designed
 * (DESIGN §2.1, `_tokens.scss`), used instead of derived shades.
 */
const DESIGNED: Record<'light' | 'dark', { primary: string; accent: string; onAccent: string }> = {
  light: { primary: '#4F46E5', accent: '#4F46E5', onAccent: '#FFFFFF' },
  dark: { primary: '#8B93FF', accent: '#8B93FF', onAccent: '#0E1117' },
};

/** One of the two modes. */
export type Mode = 'light' | 'dark';

/** Curated theme colours offered first in the pickers; any hex is allowed too. */
export const THEME_SWATCHES: readonly { name: string; hex: string }[] = [
  { name: 'Indigo', hex: '#4F46E5' },
  { name: 'Blue', hex: '#2563EB' },
  { name: 'Teal', hex: '#0F766E' },
  { name: 'Green', hex: '#15803D' },
  { name: 'Violet', hex: '#7C3AED' },
  { name: 'Pink', hex: '#BE185D' },
  { name: 'Red', hex: '#B91C1C' },
  { name: 'Orange', hex: '#C2410C' },
  { name: 'Slate', hex: '#475569' },
];

/** CSS family name of an admin's uploaded UI font. */
export const UPLOADED_FONT_FAMILY = 'k-uploaded-ui-font';

/** Font stacks of the UI font choices (DESIGN §6). */
export const FONT_STACKS: Record<UiFont, string> = {
  FIGTREE: "Figtree, system-ui, -apple-system, 'Segoe UI', sans-serif",
  ATKINSON_HYPERLEGIBLE:
    "'Atkinson Hyperlegible', system-ui, -apple-system, 'Segoe UI', sans-serif",
  IBM_PLEX_SANS: "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif",
  GEORGIA: "Georgia, 'Times New Roman', Times, serif",
  ARIAL: "Arial, 'Helvetica Neue', Helvetica, 'Liberation Sans', sans-serif",
  // Figtree takes over if the uploaded file cannot be loaded (DESIGN §6).
  UPLOADED: `'${UPLOADED_FONT_FAMILY}', Figtree, system-ui, sans-serif`,
};

/** Names of the UI font choices, for pickers. */
export const FONT_NAMES: Record<UiFont, string> = {
  FIGTREE: 'Figtree (default)',
  ATKINSON_HYPERLEGIBLE: 'Atkinson Hyperlegible',
  IBM_PLEX_SANS: 'IBM Plex Sans',
  GEORGIA: 'Georgia',
  ARIAL: 'Arial',
  UPLOADED: 'Uploaded font',
};

/** The theme colour tokens for one mode, all reaching AA contrast. */
export interface ModeColours {
  /** `--k-primary`: buttons, links, focus ring; text contrast with the background. */
  primary: string;
  /** `--k-on-primary`: text on primary buttons. */
  onPrimary: string;
  /** `--k-primary-soft`: selected rows and active chips. */
  primarySoft: string;
  /** `--k-primary-line`: borders of active chips and drop slots. */
  primaryLine: string;
  /** `--k-primary-ink`: text on the soft fill. */
  primaryInk: string;
  /** `--k-accent`: the unread badge and other small highlights. */
  accent: string;
  /** `--k-on-accent`: text on the accent. */
  onAccent: string;
}

/**
 * Derives the primary and accent tokens of one mode from the chosen colours
 * (DESIGN §2.1: "the soft, line and ink variants are derived from them so
 * contrast still holds"). The chosen colour is used as it is when it already
 * reaches WCAG AA, and otherwise darkened (light mode) or lightened (dark
 * mode) in small steps until it does, like label colours (DESIGN §4.3); the
 * stored colour never changes.
 *
 * - primary: 4.5:1 against the background, so links and primary text read;
 *   its button text (white in light mode, near-black in dark) then reaches
 *   4.5:1 as well
 * - soft: a light (or dark) tint of the primary on the surface
 * - ink: a shade of the primary reaching 4.5:1 on the soft fill
 * - accent: 3:1 against the surface as an indicator, with dark or white
 *   text chosen and the fill adjusted until that text reaches 4.5:1
 *
 * @param primary The chosen primary colour.
 * @param accent The chosen accent colour.
 * @param mode Light or dark mode.
 * @returns The tokens.
 */
export function deriveColours(primary: string, accent: string, mode: Mode): ModeColours {
  const away = mode === 'light' ? 'black' : 'white';
  const p = towardsContrast(normalise(primary), BACKGROUND[mode], away);
  const soft = mixHex(SURFACE[mode], p, mode === 'light' ? 0.1 : 0.2);
  const inkStart = mixHex(
    p,
    mode === 'light' ? '#000000' : '#FFFFFF',
    mode === 'light' ? 0.25 : 0.5,
  );
  const a = towardsContrast(normalise(accent), SURFACE[mode], away, GRAPHIC_CONTRAST);
  const badge = solidLabel(a);
  return {
    primary: p,
    onPrimary: ON_PRIMARY[mode],
    primarySoft: soft,
    primaryLine: mixHex(SURFACE[mode], p, mode === 'light' ? 0.45 : 0.5),
    primaryInk: towardsContrast(inkStart, soft, away),
    accent: badge.bg,
    onAccent: badge.fg,
  };
}

/** How one chosen colour is shown in one mode, for the picker's contrast note. */
export interface ColourCheck {
  /** The colour as shown. */
  shown: string;
  /** True when it had to be darkened or lightened. */
  adjusted: boolean;
  /** Contrast of text in that colour with the background (primary) or of its own text (accent). */
  ratio: number;
}

/**
 * Explains how a chosen colour is shown in each mode, so pickers can say
 * when it was adjusted for contrast and by how much.
 *
 * @param hex The chosen colour.
 * @param role Primary (text on the background) or accent (a filled badge).
 * @returns The check per mode.
 */
export function checkColour(hex: string, role: 'primary' | 'accent'): Record<Mode, ColourCheck> {
  const result = {} as Record<Mode, ColourCheck>;
  for (const mode of ['light', 'dark'] as const) {
    // The built-in colour keeps its designed tokens (see themeCss).
    const colours =
      normalise(hex) === DEFAULT_THEME.primary ? DESIGNED[mode] : deriveColours(hex, hex, mode);
    const shown = role === 'primary' ? colours.primary : colours.accent;
    const ratio =
      role === 'primary'
        ? contrastRatio(shown, BACKGROUND[mode])
        : contrastRatio(shown, colours.onAccent);
    result[mode] = { shown, adjusted: shown !== normalise(hex), ratio };
  }
  return result;
}

/**
 * The CSS rules that apply a theme and the UI font: custom properties for
 * light mode on `:root`, and dark-mode values both for the operating
 * system's preference and for `data-theme="dark"` (as in `_tokens.scss`).
 * Colours equal to the built-in default are left to the design tokens, so
 * the default look stays exactly as designed. Every value placed in the CSS
 * is a checked hex colour or a fixed font stack, never free text.
 *
 * @param theme The theme in effect.
 * @param branding The font choice and uploaded font files.
 * @returns The style sheet text; empty when nothing differs from the tokens.
 */
export function themeCss(
  theme: ThemeDto,
  branding: Pick<PublicBrandingDto, 'font' | 'fontFiles'>,
): string {
  const light: string[] = [];
  const dark: string[] = [];
  const custom =
    normalise(theme.primary) !== DEFAULT_THEME.primary ||
    normalise(theme.accent) !== DEFAULT_THEME.accent;
  if (custom) {
    for (const [mode, out] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      const derived = deriveColours(theme.primary, theme.accent, mode);
      // The built-in accent keeps its designed tokens, as in checkColour.
      const c =
        normalise(theme.accent) === DEFAULT_THEME.accent
          ? { ...derived, accent: DESIGNED[mode].accent, onAccent: DESIGNED[mode].onAccent }
          : derived;
      out.push(
        `--k-primary:${c.primary}`,
        `--k-on-primary:${c.onPrimary}`,
        `--k-primary-soft:${c.primarySoft}`,
        `--k-primary-line:${c.primaryLine}`,
        `--k-primary-ink:${c.primaryInk}`,
        `--k-accent:${c.accent}`,
        `--k-on-accent:${c.onAccent}`,
      );
    }
  }
  const rules: string[] = [];
  const faces = fontFaces(branding);
  if (faces !== '') rules.push(faces);
  const font = branding.font === UiFont.UPLOADED && faces === '' ? UiFont.FIGTREE : branding.font;
  if (font !== UiFont.FIGTREE) light.push(`--k-font:${FONT_STACKS[font]}`);
  if (light.length > 0) rules.push(`:root{${light.join(';')}}`);
  if (dark.length > 0) {
    const body = dark.join(';');
    rules.push(
      `@media (prefers-color-scheme: dark){:root:not([data-theme='light']){${body}}}`,
      `:root[data-theme='dark']{${body}}`,
    );
  }
  return rules.join('\n');
}

/** The only font URLs placed into CSS: the API's own versioned branding files. */
const FONT_URL = new RegExp(`^${API_PREFIX}/branding/fonts/(regular|bold)\\?v=[0-9a-f]{1,64}$`);

/**
 * `@font-face` rules for an uploaded UI font: the regular file for normal
 * weights and the optional bold file for bold (the browser synthesizes bold
 * without one).
 *
 * @param branding The font choice and files.
 * @returns The rules, or empty when no uploaded font is in use.
 */
function fontFaces(branding: Pick<PublicBrandingDto, 'font' | 'fontFiles'>): string {
  const files = branding.fontFiles;
  if (branding.font !== UiFont.UPLOADED || files === null || !FONT_URL.test(files.regular)) {
    return '';
  }
  const face = (url: string, weight: number): string =>
    `@font-face{font-family:'${UPLOADED_FONT_FAMILY}';src:url('${url}');font-weight:${weight};font-style:normal;font-display:swap}`;
  const rules = [face(files.regular, 400)];
  if (files.bold !== null && FONT_URL.test(files.bold)) rules.push(face(files.bold, 700));
  return rules.join('\n');
}

/**
 * Normalises a hex colour to `#RRGGBB` upper case.
 *
 * @param hex The colour.
 * @returns The normalised colour; the default primary for anything else.
 */
function normalise(hex: string): string {
  const rgb = parseHex(hex);
  return rgb === null ? DEFAULT_THEME.primary : toHex(rgb);
}

/** Re-exported so pickers can show the AA threshold they test against. */
export { MIN_CONTRAST };
