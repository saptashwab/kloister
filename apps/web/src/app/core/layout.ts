import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { SessionStore } from './session.store';

/** Screens wide enough for the full sidebar, where the rail is a choice. */
const WIDE = '(min-width: 1024px)';

/** Browser storage keys of the two choices. */
const RAIL_KEY = 'k-rail';
const FOLD_KEY = 'k-fold';

/**
 * Reads a remembered on/off choice.
 *
 * @param key Storage key.
 * @returns True when it was switched on in this browser.
 */
function remembered(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'on';
  } catch {
    return false;
  }
}

/**
 * Keeps an on/off choice for this browser.
 *
 * @param key Storage key.
 * @param on The choice.
 */
function remember(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? 'on' : 'off');
  } catch {
    /* The open page still follows the choice. */
  }
}

/**
 * Whether the screen is wide enough for the rail to be a choice.
 *
 * @returns True on wide screens (and where the media query cannot be asked).
 */
function wide(): boolean {
  return typeof matchMedia !== 'function' || matchMedia(WIDE).matches;
}

/**
 * Room for the page (DESIGN §7, v1.4.0): the sidebar can shrink to an icon
 * rail and a project's toolbars can fold into one slim row, each remembered
 * in this browser rather than as a setting. Ctrl+\ (⌘\ on a Mac) folds both
 * or, when either is folded, unfolds both; it also works inside the
 * timeline grid and text fields, since it uses a modifier.
 */
@Injectable({ providedIn: 'root' })
export class Layout {
  /** Whether the sidebar is an icon rail (wide screens; tablets always have it). */
  readonly rail = signal(remembered(RAIL_KEY));
  /** Whether project toolbars are folded into the slim row. */
  readonly folded = signal(remembered(FOLD_KEY));

  private readonly session = inject(SessionStore);

  /** Installs the shortcut and removes it with the application. */
  constructor() {
    const document = inject(DOCUMENT);
    const listener = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.code !== 'Backslash' && event.key !== '\\') return;
      // Signed out there is nothing to fold; a held key does not flicker.
      if (!this.session.user() || event.repeat) return;
      event.preventDefault();
      this.toggleBoth();
    };
    document.addEventListener('keydown', listener);
    inject(DestroyRef).onDestroy(() => document.removeEventListener('keydown', listener));
  }

  /**
   * Shrinks or widens the sidebar.
   *
   * @param on True for the icon rail; the opposite of now when omitted.
   */
  setRail(on = !this.rail()): void {
    this.rail.set(on);
    remember(RAIL_KEY, on);
  }

  /**
   * Folds or unfolds project toolbars.
   *
   * @param on True to fold; the opposite of now when omitted.
   */
  setFolded(on = !this.folded()): void {
    this.folded.set(on);
    remember(FOLD_KEY, on);
  }

  /**
   * The shortcut: folds both when both are open, otherwise opens both. The
   * rail counts only where it shows (wide screens), so a press always
   * changes what is on screen.
   */
  toggleBoth(): void {
    const railShown = this.rail() && wide();
    const fold = !railShown && !this.folded();
    this.setRail(fold);
    this.setFolded(fold);
  }
}
