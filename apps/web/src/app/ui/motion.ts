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

/**
 * Scrolls an element into the middle of its scroller, smoothly unless the
 * user asked for reduced motion.
 *
 * @param element The element, or its id.
 * @returns True when the element exists.
 */
export function scrollToElement(element: string | Element | null): boolean {
  if (typeof element === 'string') element = document.getElementById(element);
  if (element === null) return false;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({
    block: 'center',
    inline: 'nearest',
    behavior: reduced ? 'auto' : 'smooth',
  });
  return true;
}
