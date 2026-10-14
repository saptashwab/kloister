/**
 * Reads the shared transition duration, including the reduced-motion override.
 *
 * @returns Milliseconds for Material dialog entry and exit.
 */
export function dialogMotion(): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--k-motion').trim();
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number * (value.endsWith('ms') ? 1 : 1000) : 0;
}
