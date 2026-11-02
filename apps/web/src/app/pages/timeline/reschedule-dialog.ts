import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { KeptReason, type RescheduleResultDto, type ScheduleDates } from '@kloister/shared';
import { dueText, startText } from '../../core/timeline-logic';
import { Icon } from '../../ui/icon';

/** What the dialog shows. */
export interface RescheduleDialogData {
  /** The previewed plan. */
  plan: RescheduleResultDto;
  /** `YYYY-MM-DD`, for short dates. */
  today: string;
  /** The caller is a PM and may switch the project to automatic moving. */
  canSwitch: boolean;
}

/** The person's choice: move dependents, change only the requested items, or cancel (null). */
export type RescheduleChoice = { move: boolean; always: boolean } | null;

/** Words for why a dependent item stays. */
const KEPT_REASON: Record<KeptReason, string> = {
  NOT_EDITABLE: "you can't edit it",
  STARTED: 'already started, keeps its dates',
  PINNED: 'pinned to start no earlier than its pinned date',
};

/**
 * Confirms dependent moves before a date change applies, for projects without
 * automatic moving (SPEC §6.4, docs/M9-PLAN.md §4.3).
 */
@Component({
  selector: 'app-reschedule-dialog',
  imports: [MatDialogModule, MatButtonModule, MatCheckboxModule, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .moves {
      border: var(--k-line) solid var(--k-border);
      border-radius: var(--k-radius-md);
      overflow: auto;
      max-height: 40vh;
    }
    .move {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: var(--k-space-1) var(--k-space-3);
      padding: var(--k-space-2) var(--k-space-3);
      border-top: var(--k-line) solid var(--k-border);
    }
    .move:first-child {
      border-top: 0;
    }
    .was {
      color: var(--k-muted);
      text-decoration: line-through;
    }
    .now {
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: var(--k-space-1);
    }
    .always {
      display: block;
      margin-top: var(--k-space-4);
      padding: var(--k-space-2) var(--k-space-3);
      border-radius: var(--k-radius-md);
      background: var(--k-primary-soft);
      color: var(--k-primary-ink);
    }
    ul {
      margin: var(--k-space-2) 0 0;
      padding-left: var(--k-space-6);
    }
  `,
  template: `
    <h2 mat-dialog-title>{{ title() }}</h2>
    <mat-dialog-content>
      <p>{{ intro() }}</p>
      @if (moves().length > 0) {
        <div class="moves" role="list" aria-label="Proposed moves">
          @for (c of moves(); track c.item.id) {
            <div class="move" role="listitem">
              <span class="k-key">{{ c.item.key }}</span>
              <span>{{ c.item.title }}</span>
              <span></span>
              <span>
                <span class="was">{{ range(c.from) }}</span>
                <span class="now">
                  <app-icon [name]="c.earlier ? 'arrowLeft' : 'arrowRight'" [size]="14" />
                  <span class="visually-hidden">{{ c.earlier ? 'earlier,' : 'later,' }}</span>
                  {{ range(c.to) }}
                </span>
              </span>
            </div>
          }
        </div>
      }
      @if (data.plan.kept.length > 0) {
        <p>
          <strong>Not changed ({{ data.plan.kept.length }})</strong>
        </p>
        <ul>
          @for (k of data.plan.kept; track k.item.id) {
            <li>
              <span class="k-key">{{ k.item.key }}</span> {{ k.item.title }}: {{ reason[k.reason] }}
            </li>
          }
        </ul>
      }
      @if (data.canSwitch && moves().length > 0) {
        <mat-checkbox class="always" [checked]="always()" (change)="always.set($event.checked)">
          <strong>Always move dependent items in this project</strong><br />
          Moves then happen straight away for everyone, with Undo. You can change this in Settings ›
          General.
        </mat-checkbox>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" [mat-dialog-close]="null">Cancel</button>
      @if (moves().length > 0) {
        <button mat-stroked-button type="button" (click)="close(false)">
          Change only {{ requestedLabel() }}
        </button>
        <button mat-flat-button type="button" (click)="close(true)" cdkFocusInitial>
          Move {{ moves().length }} {{ moves().length === 1 ? 'item' : 'items' }}
        </button>
      } @else {
        <button mat-flat-button type="button" (click)="close(true)" cdkFocusInitial>Apply</button>
      }
    </mat-dialog-actions>
  `,
})
export class RescheduleDialog {
  /** The plan and context. */
  protected readonly data = inject<RescheduleDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<RescheduleDialog, RescheduleChoice>>(MatDialogRef);
  /** Reason texts. */
  protected readonly reason = KEPT_REASON;
  /** "Always move" is ticked. */
  protected readonly always = signal(false);

  /** The dependent moves, with their direction. */
  protected readonly moves = computed(() =>
    this.data.plan.changes
      .filter((c) => !c.requested)
      .map((c) => ({
        ...c,
        earlier:
          (c.to.startDate ?? c.to.dueDate ?? '') < (c.from.startDate ?? c.from.dueDate ?? ''),
      })),
  );

  /** The requested items' keys. */
  protected readonly requestedLabel = computed(() => {
    const keys = this.data.plan.changes.filter((c) => c.requested).map((c) => c.item.key);
    return keys.length === 1 ? keys[0] : `${keys.length} items`;
  });

  /** The question. */
  protected readonly title = computed(() => {
    const n = this.moves().length;
    return n === 0 ? 'Apply this change?' : `Move ${n} dependent ${n === 1 ? 'item' : 'items'}?`;
  });

  /** One line on what changed and why the moves follow. */
  protected readonly intro = computed(() => {
    const snapped = this.data.plan.changes.find((c) => c.snapped);
    if (snapped !== undefined)
      return `${snapped.item.key} cannot start before its predecessors finish, so it starts ${startText(snapped.to, this.data.today)}.`;
    return this.moves().length > 0
      ? 'These items follow their predecessors and keep their durations.'
      : 'No other item moves.';
  });

  /**
   * A date range as the grid shows it.
   *
   * @param dates The dates.
   * @returns E.g. "5 Nov, 2nd half – 11 Nov, 1st half".
   */
  protected range(dates: ScheduleDates): string {
    return [startText(dates, this.data.today), dueText(dates, this.data.today)]
      .filter((t) => t !== '')
      .join(' – ');
  }

  /**
   * Closes with the choice.
   *
   * @param move Move dependent items too.
   */
  protected close(move: boolean): void {
    this.ref.close({ move, always: move && this.always() });
  }
}
