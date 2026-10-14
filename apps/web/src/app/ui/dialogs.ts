import { ChangeDetectionStrategy, Component, inject, Injectable } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import {
  MAT_DIALOG_DATA,
  MatDialog,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { firstValueFrom } from 'rxjs';
import { dialogMotion } from './motion';

/** What a confirm dialog asks. */
export interface ConfirmOptions {
  /** Title naming the thing and the action, e.g. "Delete KLO-4?". */
  title: string;
  /** The consequence, in one or two sentences. */
  message: string;
  /** Label of the confirming button, e.g. "Delete". */
  confirm: string;
  /** Destructive actions get the danger colour. */
  danger?: boolean;
}

/** What a prompt dialog asks. */
export interface PromptOptions {
  /** Dialog title. */
  title: string;
  /** Field label. */
  label: string;
  /** Initial value. */
  value?: string;
  /** Label of the confirming button. */
  confirm: string;
  /** Longest value accepted. */
  maxLength?: number;
}

/**
 * Confirm dialog (DESIGN §11), replacing the browser's `confirm()`: title,
 * consequence, Cancel (initial focus) and the action. Focus is trapped and
 * returned to the trigger by Material's dialog.
 */
@Component({
  selector: 'app-confirm-dialog',
  imports: [MatDialogModule, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>{{ data.message }}</mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" [mat-dialog-close]="false" cdkFocusInitial>Cancel</button>
      <button
        mat-flat-button
        type="button"
        [mat-dialog-close]="true"
        [class.k-danger-btn]="data.danger"
      >
        {{ data.confirm }}
      </button>
    </mat-dialog-actions>
  `,
})
export class ConfirmDialog {
  /** The question. */
  protected readonly data = inject<ConfirmOptions>(MAT_DIALOG_DATA);
}

/**
 * Prompt dialog, replacing the browser's `prompt()`: one text field.
 */
@Component({
  selector: 'app-prompt-dialog',
  imports: [MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form (ngSubmit)="submit()">
      <h2 mat-dialog-title>{{ data.title }}</h2>
      <mat-dialog-content>
        <mat-form-field style="width: 100%; margin-top: 4px">
          <mat-label>{{ data.label }}</mat-label>
          <input
            matInput
            name="value"
            [(ngModel)]="value"
            [attr.maxlength]="data.maxLength ?? null"
            cdkFocusInitial
          />
        </mat-form-field>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" [mat-dialog-close]="null">Cancel</button>
        <button mat-flat-button type="submit">{{ data.confirm }}</button>
      </mat-dialog-actions>
    </form>
  `,
})
export class PromptDialog {
  /** The question. */
  protected readonly data = inject<PromptOptions>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<PromptDialog, string | null>>(MatDialogRef);
  /** The typed value. */
  protected value = this.data.value ?? '';

  /**
   * Closes the dialog with the typed value.
   */
  protected submit(): void {
    this.ref.close(this.value);
  }
}

/**
 * Opens the app's confirm and prompt dialogs and returns their answers as
 * promises.
 */
@Injectable({ providedIn: 'root' })
export class Dialogs {
  private readonly dialog = inject(MatDialog);

  /**
   * Asks for confirmation.
   *
   * @param options The question.
   * @returns True when confirmed.
   */
  async confirm(options: ConfirmOptions): Promise<boolean> {
    const ref = this.dialog.open<ConfirmDialog, ConfirmOptions, boolean>(ConfirmDialog, {
      data: options,
      enterAnimationDuration: dialogMotion(),
      exitAnimationDuration: dialogMotion(),
      width: '440px',
      maxWidth: 'calc(100vw - 32px)',
      autoFocus: 'first-tabbable',
    });
    return (await firstValueFrom(ref.afterClosed())) === true;
  }

  /**
   * Asks for one line of text.
   *
   * @param options The question.
   * @returns The trimmed value, or null when cancelled or left empty.
   */
  async prompt(options: PromptOptions): Promise<string | null> {
    const ref = this.dialog.open<PromptDialog, PromptOptions, string | null>(PromptDialog, {
      data: options,
      enterAnimationDuration: dialogMotion(),
      exitAnimationDuration: dialogMotion(),
      width: '440px',
      maxWidth: 'calc(100vw - 32px)',
    });
    const value = (await firstValueFrom(ref.afterClosed()))?.trim() ?? '';
    return value === '' ? null : value;
  }
}
