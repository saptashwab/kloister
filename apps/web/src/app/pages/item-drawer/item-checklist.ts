import {
  CdkDrag,
  type CdkDragDrop,
  CdkDragHandle,
  CdkDropList,
  moveItemInArray,
} from '@angular/cdk/drag-drop';
import { Component, effect, inject, input, output, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import {
  CHECKLIST_TEXT_MAX,
  type ChecklistItemDto,
  type UpdateChecklistItemRequest,
} from '@kloister/shared';
import { errorMessage } from '../../core/api';
import { ItemsApiService } from '../../core/items-api.service';

/**
 * An item's checklist (SPEC §6): add, reorder, tick, rename and delete lines.
 * Progress is shown as `done/total`; ticking never changes the item's status
 * (SPEC §4.2).
 *
 * Controls appear only when `canEdit` (the item's `can.edit` on an
 * unarchived project); the API checks every change again.
 */
@Component({
  selector: 'app-item-checklist',
  imports: [CdkDropList, CdkDrag, CdkDragHandle, MatButtonModule, MatCheckboxModule],
  styles: `
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      display: flex;
      align-items: center;
      gap: 4px;
      background: var(--mat-sys-surface);
    }
    .text {
      flex: 1;
      min-width: 0;
      border: none;
      background: transparent;
      color: inherit;
      font: inherit;
    }
    .handle {
      cursor: move;
      padding: 0 4px;
    }
  `,
  template: `
    <h4>Checklist {{ doneCount() }}/{{ lines().length }}</h4>
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
    <ul cdkDropList [cdkDropListDisabled]="!canEdit()" (cdkDropListDropped)="reorder($event)">
      @for (line of lines(); track line.id) {
        <li cdkDrag>
          @if (canEdit()) {
            <span class="handle" cdkDragHandle aria-hidden="true">⠿</span>
          }
          <mat-checkbox
            [checked]="line.done"
            [disabled]="!canEdit()"
            [aria-label]="'Done: ' + line.text"
            (change)="update(line, { done: $event.checked })"
          />
          @if (canEdit()) {
            <input
              class="text"
              [value]="line.text"
              [attr.maxlength]="textMax"
              [attr.aria-label]="'Checklist line ' + line.text"
              (change)="rename(line, $any($event.target))"
            />
            <button mat-button type="button" (click)="remove(line)">Delete</button>
          } @else {
            <span class="text">{{ line.text }}</span>
          }
        </li>
      }
    </ul>
    @if (canEdit()) {
      <input
        class="quick-add"
        placeholder="+ Add a checklist line"
        aria-label="New checklist line"
        [attr.maxlength]="textMax"
        (keyup.enter)="add($any($event.target))"
      />
    }
  `,
})
export class ItemChecklist {
  private readonly api = inject(ItemsApiService);

  /** Project id. */
  readonly projectId = input.required<string>();
  /** Item id. */
  readonly itemId = input.required<string>();
  /** The item's checklist from the API. */
  readonly items = input.required<ChecklistItemDto[]>();
  /** Show editing controls. */
  readonly canEdit = input(false);
  /** Emits after every saved change, so the drawer can refresh the item. */
  readonly changed = output<void>();

  /** Lines as currently shown. */
  protected readonly lines = signal<ChecklistItemDto[]>([]);
  /** Last error, if any. */
  protected readonly error = signal('');
  /** Longest line accepted. */
  protected readonly textMax = CHECKLIST_TEXT_MAX;

  /**
   * Shows the checklist passed in whenever it changes.
   */
  constructor() {
    effect(() => this.lines.set(this.items()));
  }

  /**
   * Counts ticked lines.
   *
   * @returns Number of done lines.
   */
  protected doneCount(): number {
    return this.lines().filter((l) => l.done).length;
  }

  /**
   * Adds a line at the end.
   *
   * @param input The text field.
   * @returns Resolves once saved.
   */
  protected async add(input: HTMLInputElement): Promise<void> {
    const text = input.value.trim();
    if (text === '') return;
    await this.run(async () => {
      const line = await this.api.addChecklistLine(this.projectId(), this.itemId(), { text });
      this.lines.update((lines) => [...lines, line]);
      input.value = '';
    });
  }

  /**
   * Saves a renamed line; an emptied line is put back.
   *
   * @param line The line.
   * @param input The text field.
   * @returns Resolves once saved.
   */
  protected async rename(line: ChecklistItemDto, input: HTMLInputElement): Promise<void> {
    const text = input.value.trim();
    if (text === '' || text === line.text) {
      input.value = line.text;
      return;
    }
    await this.update(line, { text });
  }

  /**
   * Ticks, unticks or renames a line.
   *
   * @param line The line.
   * @param change Fields to change.
   * @returns Resolves once saved.
   */
  protected async update(
    line: ChecklistItemDto,
    change: UpdateChecklistItemRequest,
  ): Promise<void> {
    await this.run(async () => {
      const updated = await this.api.updateChecklistLine(
        this.projectId(),
        this.itemId(),
        line.id,
        change,
      );
      this.lines.update((lines) => lines.map((l) => (l.id === updated.id ? updated : l)));
    });
  }

  /**
   * Deletes a line.
   *
   * @param line The line.
   * @returns Resolves once deleted.
   */
  protected async remove(line: ChecklistItemDto): Promise<void> {
    await this.run(async () => {
      await this.api.removeChecklistLine(this.projectId(), this.itemId(), line.id);
      this.lines.update((lines) => lines.filter((l) => l.id !== line.id));
    });
  }

  /**
   * Moves a dragged line after its new predecessor.
   *
   * @param event The CDK drop event.
   * @returns Resolves once saved.
   */
  protected async reorder(event: CdkDragDrop<unknown>): Promise<void> {
    if (event.previousIndex === event.currentIndex) return;
    const lines = [...this.lines()];
    const line = lines[event.previousIndex];
    if (line === undefined) return;
    moveItemInArray(lines, event.previousIndex, event.currentIndex);
    const previous = this.lines();
    this.lines.set(lines);
    const afterId = lines[event.currentIndex - 1]?.id ?? null;
    const ok = await this.run(async () => {
      await this.api.moveChecklistLine(this.projectId(), this.itemId(), line.id, afterId);
    });
    if (!ok) this.lines.set(previous);
  }

  /**
   * Runs a change, reporting success to the drawer or showing the error.
   *
   * @param action The work to do.
   * @returns True if it succeeded.
   */
  private async run(action: () => Promise<void>): Promise<boolean> {
    this.error.set('');
    try {
      await action();
      this.changed.emit();
      return true;
    } catch (error) {
      this.error.set(errorMessage(error));
      return false;
    }
  }
}
