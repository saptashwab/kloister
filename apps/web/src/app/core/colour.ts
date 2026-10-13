import { LabelStyle } from '@kloister/shared';

/** Dark label text (DESIGN §4.3). */
export const DARK_TEXT = '#111827';
/** Light label text (DESIGN §4.3). */
export const LIGHT_TEXT = '#FFFFFF';
/** Contrast every label text must reach (WCAG 2.2 AA, normal text). */
export const MIN_CONTRAST = 4.5;

/** Surface colours tinted labels sit on, per mode (DESIGN §2.1). */
const SURFACE = { light: '#FFFFFF', dark: '#161B24' } as const;

/** The curated label palette (DESIGN §4.1). */
export const LABEL_PALETTE: readonly { name: string; hex: string }[] = [
  { name: 'Red', hex: '#E5484D' },
  { name: 'Orange', hex: '#F76B15' },
  { name: 'Amber', hex: '#FFB224' },
  { name: 'Lime', hex: '#99D52A' },
  { name: 'Green', hex: '#30A46C' },
  { name: 'Teal', hex: '#12A594' },
  { name: 'Cyan', hex: '#05A2C2' },
  { name: 'Blue', hex: '#0090FF' },
  { name: 'Indigo', hex: '#3E63DD' },
  { name: 'Violet', hex: '#8E4EC6' },
  { name: 'Pink', hex: '#C2378E' },
  { name: 'Slate', hex: '#6B7280' },
];

/** An sRGB colour as 0–255 channels. */
type Rgb = [number, number, number];

/**
 * Parses `#RRGGBB` or `#RGB` (any case).
 *
 * @param hex The colour.
 * @returns Its channels, or null when it is not a hex colour.
 */
export function parseHex(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (match === null) return null;
  let digits = match[1] ?? '';
  if (digits.length === 3) digits = [...digits].map((d) => d + d).join('');
  const n = parseInt(digits, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Formats channels as `#RRGGBB`.
 *
 * @param rgb The channels.
 * @returns The hex colour, upper case.
 */
export function toHex(rgb: Rgb): string {
  return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/**
 * WCAG relative luminance.
 *
 * @param rgb The colour.
 * @returns 0 (black) to 1 (white).
 */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio between two colours.
 *
 * @param a First colour (hex).
 * @param b Second colour (hex).
 * @returns The ratio, 1 to 21; 1 when either colour is not a hex colour.
 */
export function contrastRatio(a: string, b: string): number {
  const x = parseHex(a);
  const y = parseHex(b);
  if (x === null || y === null) return 1;
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Mixes two colours.
 *
 * @param a First colour.
 * @param b Second colour.
 * @param amount Share of `b`, 0 to 1.
 * @returns The mix.
 */
function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  return a.map((v, i) => v + ((b[i] ?? 0) - v) * amount) as Rgb;
}

/**
 * Steps a colour towards black or white until a text colour reaches
 * {@link MIN_CONTRAST} on it (or on the colour, as text, against a fixed
 * background). Used only when the plain colour falls short.
 *
 * @param start The colour to adjust.
 * @param against The fixed colour it is compared with.
 * @param towards Black or white.
 * @returns The first step that reaches the minimum.
 */
function adjust(start: Rgb, against: string, towards: Rgb): string {
  for (let step = 0; step <= 20; step++) {
    const candidate = toHex(mix(start, towards, step * 0.05));
    if (contrastRatio(candidate, against) >= MIN_CONTRAST) return candidate;
  }
  return toHex(towards);
}

/** Colours of one label pill. */
export interface LabelColours {
  /** Fill. */
  bg: string;
  /** Text. */
  fg: string;
  /** The small dot before the name. */
  dot: string;
}

/**
 * Colours of a solid label (DESIGN §4.3): dark or white text, whichever
 * contrasts more with the fill. If neither reaches 4.5:1, the fill shown is
 * darkened (white text) or lightened (dark text) until it does; the stored
 * colour does not change.
 *
 * @param hex The label colour.
 * @returns The pill colours.
 */
export function solidLabel(hex: string): LabelColours {
  const rgb = parseHex(hex) ?? [107, 114, 128];
  const fill = toHex(rgb);
  const darkText = contrastRatio(fill, DARK_TEXT) >= contrastRatio(fill, LIGHT_TEXT);
  const fg = darkText ? DARK_TEXT : LIGHT_TEXT;
  const bg = adjust(rgb, fg, darkText ? [255, 255, 255] : [0, 0, 0]);
  return { bg, fg, dot: darkText ? 'rgba(17,24,39,.55)' : 'rgba(255,255,255,.75)' };
}

/**
 * Colours of a tinted label (DESIGN §4.2): a soft fill of the label colour
 * on the surface, with text in a darker (light mode) or lighter (dark mode)
 * shade of the same hue, checked against the fill for 4.5:1.
 *
 * @param hex The label colour.
 * @param mode Light or dark mode.
 * @returns The pill colours.
 */
export function tintedLabel(hex: string, mode: 'light' | 'dark'): LabelColours {
  const rgb = parseHex(hex) ?? [107, 114, 128];
  const surface = parseHex(SURFACE[mode]) ?? [255, 255, 255];
  const bg = toHex(mix(surface, rgb, mode === 'light' ? 0.14 : 0.24));
  const start = mode === 'light' ? mix(rgb, [0, 0, 0], 0.45) : mix(rgb, [255, 255, 255], 0.45);
  const fg = adjust(start, bg, mode === 'light' ? [0, 0, 0] : [255, 255, 255]);
  return { bg, fg, dot: toHex(rgb) };
}

/**
 * CSS custom properties for a label pill in a project's label style, read by
 * the `.k-label` class: solid labels look the same in both modes; tinted and
 * cover-bar labels have separate dark-mode colours.
 *
 * @param hex The label colour.
 * @param style The project's label style.
 * @returns Property names and values.
 */
export function labelVars(hex: string, style: LabelStyle): Record<string, string> {
  if (style === LabelStyle.SOLID) {
    const c = solidLabel(hex);
    return { '--l-bg': c.bg, '--l-fg': c.fg, '--l-dot': c.dot };
  }
  const light = tintedLabel(hex, 'light');
  const dark = tintedLabel(hex, 'dark');
  return {
    '--l-bg': light.bg,
    '--l-fg': light.fg,
    '--l-dot': light.dot,
    '--l-bg-dark': dark.bg,
    '--l-fg-dark': dark.fg,
  };
}

/**
 * Avatar colour pairs: a soft fill with dark initials, each at least 4.5:1
 * (DESIGN §9).
 */
export const AVATAR_COLOURS: readonly { bg: string; fg: string }[] = [
  { bg: '#E0E7FF', fg: '#3730A3' },
  { bg: '#FCE7F3', fg: '#9D174D' },
  { bg: '#DCFCE7', fg: '#166534' },
  { bg: '#FEF3C7', fg: '#92400E' },
  { bg: '#E0F2FE', fg: '#075985' },
  { bg: '#EDE9FE', fg: '#5B21B6' },
  { bg: '#FFE4E6', fg: '#9F1239' },
  { bg: '#CCFBF1', fg: '#115E59' },
];

/**
 * A person's avatar colours, derived from their user id so they stay the
 * same everywhere and across sessions.
 *
 * @param userId The user id.
 * @returns The colour pair.
 */
export function avatarColours(userId: string): { bg: string; fg: string } {
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLOURS[hash % AVATAR_COLOURS.length] ?? { bg: '#E0E7FF', fg: '#3730A3' };
}

/**
 * Initials for an avatar, e.g. "Ann Lee" → "AL".
 *
 * @param name Display name.
 * @returns One or two capital letters.
 */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : [parts[0] ?? '?'];
  return letters.map((p) => (p ?? '?').charAt(0).toUpperCase()).join('');
}
