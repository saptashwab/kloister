import { inject, Injectable } from '@angular/core';
import {
  MatSnackBar,
  type MatSnackBarRef,
  type TextOnlySnackBar,
} from '@angular/material/snack-bar';
import { errorMessage } from '../core/api';

/** How long a toast stays, in ms, while not hovered or focused (DESIGN §11). */
export const TOAST_MS = 6000;

/**
 * Toasts (DESIGN §11) on Angular Material's snack bar: a short sentence of
 * what happened, with Undo for reversible changes. One toast at a time; the
 * newest replaces the last. The snack bar announces toasts to screen
 * readers; a toast stays while the pointer or keyboard focus is on it, so
 * Undo can be reached without a race.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly snackBar = inject(MatSnackBar);

  /**
   * Shows a confirmation, with an Undo action when `undo` is given. If the
   * undo itself fails, its error is shown instead.
   *
   * @param message What happened.
   * @param undo Reverses the change.
   */
  show(message: string, undo?: () => Promise<void>): void {
    const ref = this.snackBar.open(message, undo === undefined ? undefined : 'Undo', {
      panelClass: 'k-toast',
      horizontalPosition: 'start',
      politeness: 'polite',
    });
    this.dismissLater(ref, TOAST_MS);
    if (undo !== undefined) {
      ref.onAction().subscribe(() => {
        undo().then(
          () => this.show('Change undone'),
          (error: unknown) => this.error(error),
        );
      });
    }
  }

  /**
   * Shows an error: the API's reason, without Undo.
   *
   * @param error The error or message.
   */
  error(error: unknown): void {
    const ref = this.snackBar.open(
      typeof error === 'string' ? error : errorMessage(error),
      'Dismiss',
      {
        panelClass: ['k-toast', 'k-toast-error'],
        horizontalPosition: 'start',
        politeness: 'assertive',
      },
    );
    this.dismissLater(ref, TOAST_MS * 1.5);
  }

  /**
   * Dismisses a toast after a delay that pauses while the pointer or focus
   * is on it (the snack bar's own duration cannot pause).
   *
   * @param ref The open toast.
   * @param ms Delay once the toast is left alone.
   */
  private dismissLater(ref: MatSnackBarRef<TextOnlySnackBar>, ms: number): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => ref.dismiss(), ms);
    };
    const pause = (): void => clearTimeout(timer);
    start();
    ref.afterOpened().subscribe(() => {
      const panels = document.querySelectorAll<HTMLElement>('.mat-mdc-snack-bar-container.k-toast');
      const panel = panels.item(panels.length - 1);
      if (panel === null) return;
      panel.addEventListener('mouseenter', pause);
      panel.addEventListener('focusin', pause);
      panel.addEventListener('mouseleave', start);
      panel.addEventListener('focusout', start);
    });
    ref.afterDismissed().subscribe(() => clearTimeout(timer));
  }
}
