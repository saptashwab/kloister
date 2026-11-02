import type { Injector } from '@angular/core';
import { LiveService } from './live.service';

/** Offers the first-login introduction (M6.8); loaded together with live updates. */
export { offerIntroduction } from '../pages/help/tour';

/**
 * Starts live updates afresh for the signed-in user (M10). Loaded with the
 * sign-in extras (the introduction), so the first page stays small.
 *
 * @param injector The app's injector.
 */
export function startLive(injector: Injector): void {
  const live = liveOf(injector);
  live?.stop();
  live?.start();
}

/**
 * Stops live updates, e.g. at sign-out.
 *
 * @param injector The app's injector.
 */
export function stopLive(injector: Injector): void {
  liveOf(injector)?.stop();
}

/**
 * The live service, unless the app was torn down meanwhile (the module
 * loads asynchronously).
 *
 * @param injector The app's injector.
 * @returns The service, or null.
 */
function liveOf(injector: Injector): LiveService | null {
  try {
    return injector.get(LiveService);
  } catch {
    return null;
  }
}
