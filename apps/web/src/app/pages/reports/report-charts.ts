import type { BurndownPointDto, ItemStatus } from '@kloister/shared';

// Chart geometry for the reports (docs/M13-PLAN.md §3): plain SVG shapes
// computed here, so the page draws them without a charting library and the
// arithmetic is tested on its own. Every chart has a table with its numbers.

/** One bar of the status chart. */
export interface StatusBar {
  /** Status name. */
  label: string;
  /** Items. */
  value: number;
  /** Bar length on a 0–100 scale. */
  width: number;
  /** Colour class: the status. */
  tone: string;
}

/**
 * Bars for items per status, scaled to the largest count.
 *
 * @param counts Items per status.
 * @returns One bar per status.
 */
export function statusBars(
  counts: readonly { status: ItemStatus; label: string; value: number }[],
): StatusBar[] {
  const max = Math.max(1, ...counts.map((c) => c.value));
  return counts.map((c) => ({
    label: c.label,
    value: c.value,
    width: Math.round((c.value / max) * 100),
    tone: c.status.toLowerCase(),
  }));
}

/** The shapes of a burndown chart. */
export interface BurndownChart {
  /** Drawing width. */
  width: number;
  /** Drawing height. */
  height: number;
  /** The y axis' top value, in working days. */
  max: number;
  /** `points` of the ideal line. */
  ideal: string;
  /** `points` of the remaining line, up to today. */
  actual: string;
  /** The remaining values as dots. */
  dots: { x: number; y: number }[];
}

/** Drawing size of the burndown. */
const WIDTH = 600;
const HEIGHT = 200;
/** Room for the top label. */
const TOP = 16;

/**
 * Lays out a burndown: one step per working day, remaining working days
 * against the ideal line.
 *
 * @param points The burndown.
 * @returns The chart, or null without days.
 */
export function burndownChart(points: readonly BurndownPointDto[]): BurndownChart | null {
  if (points.length === 0) return null;
  const max = Math.max(1, ...points.map((p) => Math.max(p.ideal, p.remaining ?? 0)));
  const step = points.length === 1 ? 0 : WIDTH / (points.length - 1);
  const x = (i: number) => Math.round(i * step * 10) / 10;
  const y = (v: number) => Math.round((TOP + (1 - v / max) * (HEIGHT - TOP)) * 10) / 10;
  const dots = points.flatMap((p, i) =>
    p.remaining === null ? [] : [{ x: x(i), y: y(p.remaining) }],
  );
  return {
    width: WIDTH,
    height: HEIGHT,
    max,
    ideal: points.map((p, i) => `${x(i)},${y(p.ideal)}`).join(' '),
    actual: dots.map((d) => `${d.x},${d.y}`).join(' '),
    dots,
  };
}
