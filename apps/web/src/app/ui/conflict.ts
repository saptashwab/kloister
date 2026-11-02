import type { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { ConfirmDialog, type ConfirmOptions } from './dialogs';
import { dialogMotion } from './motion';

/**
 * Asks whether to keep the caller's change after someone else changed the
 * same thing meanwhile (M10 plan section 4.3): "Keep mine" saves over
 * theirs, "Use theirs" drops the caller's change. Closing the dialog keeps
 * the caller's change, so nothing typed is discarded silently. Kept out of
 * the shared dialogs so the first page stays small.
 *
 * @param dialog Material's dialog service.
 * @param title E.g. "Pat (PM) changed this while you were editing".
 * @returns True for "Keep mine", false for "Use theirs".
 */
export async function keepMine(dialog: MatDialog, title: string): Promise<boolean> {
  const ref = dialog.open<ConfirmDialog, ConfirmOptions, boolean>(ConfirmDialog, {
    data: {
      title,
      message:
        'Keep mine saves your change over theirs. Use theirs keeps their change and drops yours.',
      confirm: 'Keep mine',
      cancel: 'Use theirs',
    },
    enterAnimationDuration: dialogMotion(),
    exitAnimationDuration: dialogMotion(),
    width: '440px',
    maxWidth: 'calc(100vw - 32px)',
    autoFocus: 'first-tabbable',
  });
  return (await firstValueFrom(ref.afterClosed())) !== false;
}
