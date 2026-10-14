import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject, Injectable, Injector, signal } from '@angular/core';
import { SessionStore } from './session.store';

/**
 * Shared keyboard entry point (DESIGN §12). Pages register contextual
 * actions; dialogs are loaded only on request to preserve the initial budget.
 * This changes only navigation: the API still checks every action.
 */
@Injectable({ providedIn: 'root' })
export class Shortcuts {
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly session = inject(SessionStore);
  private readonly handlers: ((key: string) => boolean)[] = [];
  private opening = false;

  /** Field to open after a board shortcut opens the drawer. */
  readonly field = signal<string | null>(null);
  /** Whether single-character shortcuts are enabled on this browser (WCAG 2.1.4). */
  readonly enabled = signal(true);

  /** Installs one listener and removes it with the application. */
  constructor() {
    try {
      this.enabled.set(localStorage.getItem('k-shortcuts') !== 'off');
    } catch {
      /* Storage may be unavailable. */
    }
    const listener = (event: KeyboardEvent): void => this.handle(event);
    this.document.addEventListener('keydown', listener);
    inject(DestroyRef).onDestroy(() => this.document.removeEventListener('keydown', listener));
  }

  /**
   * Changes the browser-local shortcut preference without changing account data.
   *
   * @param enabled Whether single-character shortcuts should run.
   */
  setEnabled(enabled: boolean): void {
    this.enabled.set(enabled);
    try {
      localStorage.setItem('k-shortcuts', enabled ? 'on' : 'off');
    } catch {
      /* The current page still follows the choice. */
    }
  }

  /**
   * Registers a contextual action; the most recently opened page wins.
   *
   * @param handler Returns true after handling a key.
   * @param destroyRef The page's lifetime.
   */
  register(handler: (key: string) => boolean, destroyRef: DestroyRef): void {
    this.handlers.push(handler);
    destroyRef.onDestroy(() => {
      const index = this.handlers.indexOf(handler);
      if (index >= 0) this.handlers.splice(index, 1);
    });
  }

  /**
   * Opens the lazy command palette or shortcut reference.
   *
   * @param help True for the shortcut reference.
   * @returns Resolves once the dialog closes.
   */
  async open(help = false): Promise<void> {
    if (this.opening || !this.session.user() || this.session.user()?.mustChangePassword) return;
    this.opening = true;
    try {
      const module = await import('../ui/navigation-dialog');
      await module.openNavigation(this.injector, help);
    } finally {
      this.opening = false;
    }
  }

  /**
   * Dispatches unmodified keys only outside editors and open overlays.
   *
   * @param event The keyboard event.
   */
  private handle(event: KeyboardEvent): void {
    if (!this.enabled()) return;
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    if (!this.session.user() || this.session.user()?.mustChangePassword) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest(
        'input, textarea, select, [contenteditable], [role="textbox"], [role="combobox"]',
      )
    )
      return;
    if (this.document.querySelector('.cdk-overlay-container .cdk-overlay-pane:not(:empty)')) return;
    const key = event.key.toLowerCase();
    if (key === '/' || key === '?') {
      event.preventDefault();
      void this.open(key === '?');
    } else {
      for (const handler of [...this.handlers].reverse()) {
        if (handler(key)) {
          event.preventDefault();
          break;
        }
      }
    }
  }
}
