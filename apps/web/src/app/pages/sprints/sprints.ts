import { Component, computed, inject, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import {
  BOARD_NAME_MAX,
  ItemStatus,
  ITERATION_PATH_MAX,
  ProjectPermission,
  type SprintDto,
  SprintState,
} from '@kloister/shared';
import { errorMessage } from '../../core/api';
import { NONE } from '../../core/board-logic';
import { ItemsApiService } from '../../core/items-api.service';
import { SPRINT_STATE_LABELS } from '../../core/labels';
import { ProjectContext } from '../../core/project-context';
import { required } from '../../core/validators';

/** Close-dialog choice: leave unfinished items in the closed sprint. */
const KEEP = 'keep';

/**
 * Sprints (SPEC §6): list, create and edit, set active, open the sprint
 * board (the board filtered to one sprint), and close a sprint with the
 * option to move its unfinished items to another open sprint or the
 * backlog.
 *
 * Everyone can see the sprints and open their boards; the management
 * controls appear only with `MANAGE_BOARD` (PM, Lead) on an unarchived
 * project. The API enforces the same rules, including that only one sprint
 * is active at a time.
 */
@Component({
  selector: 'app-sprints',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  template: `
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
    @if (notice()) {
      <p role="status">{{ notice() }}</p>
    }

    @if (canManage()) {
      <mat-card>
        <mat-card-header>
          <mat-card-title>{{ editing() ? 'Edit sprint' : 'New sprint' }}</mat-card-title>
        </mat-card-header>
        <mat-card-content>
          <form class="row" [formGroup]="form" (ngSubmit)="submit()">
            <mat-form-field>
              <mat-label>Name</mat-label>
              <input matInput formControlName="name" [attr.maxlength]="nameMax" />
            </mat-form-field>
            <mat-form-field>
              <mat-label>Start</mat-label>
              <input matInput type="date" formControlName="startDate" />
            </mat-form-field>
            <mat-form-field>
              <mat-label>End</mat-label>
              <input matInput type="date" formControlName="endDate" />
            </mat-form-field>
            <mat-form-field>
              <mat-label>ADO iteration path (optional)</mat-label>
              <input matInput formControlName="adoIterationPath" [attr.maxlength]="pathMax" />
            </mat-form-field>
            <button mat-flat-button type="submit" [disabled]="form.invalid">
              {{ editing() ? 'Save' : 'Create sprint' }}
            </button>
            @if (editing()) {
              <button mat-button type="button" (click)="cancelEdit()">Cancel</button>
            }
          </form>
        </mat-card-content>
      </mat-card>
    }

    @if (closing(); as sprint) {
      <mat-card>
        <mat-card-header
          ><mat-card-title>Close {{ sprint.name }}</mat-card-title></mat-card-header
        >
        <mat-card-content>
          <p>{{ unfinished(sprint.id) }} unfinished items are in this sprint.</p>
          <div class="row">
            <mat-form-field>
              <mat-label>Unfinished items</mat-label>
              <mat-select [value]="closeTarget()" (valueChange)="closeTarget.set($event)">
                <mat-option [value]="keep">Leave them in this sprint</mat-option>
                <mat-option [value]="none">Move them to the backlog</mat-option>
                @for (s of openSprints(); track s.id) {
                  @if (s.id !== sprint.id) {
                    <mat-option [value]="s.id">Move them to {{ s.name }}</mat-option>
                  }
                }
              </mat-select>
            </mat-form-field>
            <button mat-flat-button type="button" (click)="close(sprint)">Close sprint</button>
            <button mat-button type="button" (click)="closing.set(null)">Cancel</button>
          </div>
        </mat-card-content>
      </mat-card>
    }

    <table class="data">
      <thead>
        <tr>
          <th scope="col">Sprint</th>
          <th scope="col">Dates</th>
          <th scope="col">State</th>
          <th scope="col">Items</th>
          <th scope="col"><span class="visually-hidden">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        @for (s of ctx.sprints(); track s.id) {
          <tr>
            <td>{{ s.name }}</td>
            <td>{{ s.startDate }} – {{ s.endDate }}</td>
            <td>{{ stateLabels[s.state] }}</td>
            <td>{{ itemCount(s.id) }}</td>
            <td class="actions">
              <a mat-button [routerLink]="['/p', key()]" [queryParams]="{ sprint: s.id }"
                >Sprint board</a
              >
              @if (canManage()) {
                @if (s.state !== closed) {
                  <button mat-button type="button" (click)="edit(s)">Edit</button>
                }
                @if (s.state === planned) {
                  <button mat-button type="button" (click)="start(s)">Set active</button>
                }
                @if (s.state !== closed) {
                  <button mat-button type="button" (click)="openClose(s)">Close</button>
                }
                <button mat-button type="button" (click)="remove(s)">Delete</button>
              }
            </td>
          </tr>
        } @empty {
          <tr>
            <td colspan="5">No sprints yet.</td>
          </tr>
        }
      </tbody>
    </table>
  `,
})
export class SprintsPage implements OnInit {
  /** Shared project state. */
  protected readonly ctx = inject(ProjectContext);
  private readonly api = inject(ItemsApiService);

  /** "Keep" close choice for the template. */
  protected readonly keep = KEEP;
  /** "Backlog" close choice for the template. */
  protected readonly none = NONE;
  /** Closed state for the template. */
  protected readonly closed = SprintState.CLOSED;
  /** Planned state for the template. */
  protected readonly planned = SprintState.PLANNED;
  /** State names. */
  protected readonly stateLabels = SPRINT_STATE_LABELS;
  /** Longest sprint name. */
  protected readonly nameMax = BOARD_NAME_MAX;
  /** Longest iteration path. */
  protected readonly pathMax = ITERATION_PATH_MAX;

  /** The sprint being edited, or null when the form creates one. */
  protected readonly editing = signal<SprintDto | null>(null);
  /** The sprint whose close options are shown. */
  protected readonly closing = signal<SprintDto | null>(null);
  /** Where unfinished items go when closing. */
  protected readonly closeTarget = signal<string>(KEEP);
  /** Last error, if any. */
  protected readonly error = signal('');
  /** Last success message. */
  protected readonly notice = signal('');

  /** True when sprint management is offered: `MANAGE_BOARD` on an unarchived project. */
  protected readonly canManage = computed(
    () => this.ctx.writable() && this.ctx.has(ProjectPermission.MANAGE_BOARD),
  );
  /** Project key, for the sprint board links. */
  protected readonly key = computed(() => this.ctx.project()?.key ?? '');
  /** Sprints that are not closed. */
  protected readonly openSprints = computed(() =>
    this.ctx.sprints().filter((s) => s.state !== SprintState.CLOSED),
  );

  /** Create/edit form. */
  protected readonly form = inject(NonNullableFormBuilder).group({
    name: ['', [required, Validators.maxLength(BOARD_NAME_MAX)]],
    startDate: ['', [required]],
    endDate: ['', [required]],
    adoIterationPath: ['', [Validators.maxLength(ITERATION_PATH_MAX)]],
  });

  /**
   * Loads fresh project data when the page opens.
   */
  ngOnInit(): void {
    void this.run(() => this.ctx.refresh());
  }

  /**
   * Counts the visible items in a sprint.
   *
   * @param sprintId Sprint id.
   * @returns Item count.
   */
  protected itemCount(sprintId: string): number {
    return this.ctx.items().filter((i) => i.sprintId === sprintId).length;
  }

  /**
   * Counts the visible unfinished (not Done) items in a sprint.
   *
   * @param sprintId Sprint id.
   * @returns Item count.
   */
  protected unfinished(sprintId: string): number {
    return this.ctx.items().filter((i) => i.sprintId === sprintId && i.status !== ItemStatus.DONE)
      .length;
  }

  /**
   * Fills the form with a sprint for editing.
   *
   * @param sprint The sprint.
   */
  protected edit(sprint: SprintDto): void {
    this.editing.set(sprint);
    this.form.setValue({
      name: sprint.name,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
      adoIterationPath: sprint.adoIterationPath ?? '',
    });
  }

  /**
   * Leaves edit mode and clears the form.
   */
  protected cancelEdit(): void {
    this.editing.set(null);
    this.form.reset();
  }

  /**
   * Creates a sprint, or saves the one being edited.
   *
   * @returns Resolves once saved.
   */
  protected async submit(): Promise<void> {
    const project = this.ctx.project();
    if (project === null || this.form.invalid) return;
    const { name, startDate, endDate, adoIterationPath } = this.form.getRawValue();
    const request = {
      name: name.trim(),
      startDate,
      endDate,
      adoIterationPath: adoIterationPath.trim() || null,
    };
    const editing = this.editing();
    await this.run(async () => {
      const saved =
        editing === null
          ? await this.api.createSprint(project.id, request)
          : await this.api.updateSprint(project.id, editing.id, request);
      this.replace(saved);
      this.cancelEdit();
    });
  }

  /**
   * Makes a planned sprint the active one.
   *
   * @param sprint The sprint.
   * @returns Resolves once started.
   */
  protected async start(sprint: SprintDto): Promise<void> {
    const project = this.ctx.project();
    if (project === null) return;
    await this.run(async () => this.replace(await this.api.startSprint(project.id, sprint.id)));
  }

  /**
   * Shows the close options for a sprint.
   *
   * @param sprint The sprint.
   */
  protected openClose(sprint: SprintDto): void {
    this.closeTarget.set(KEEP);
    this.closing.set(sprint);
  }

  /**
   * Closes a sprint, moving unfinished items as chosen, then reloads the
   * items whose sprint changed.
   *
   * @param sprint The sprint.
   * @returns Resolves once closed.
   */
  protected async close(sprint: SprintDto): Promise<void> {
    const project = this.ctx.project();
    if (project === null) return;
    const target = this.closeTarget();
    await this.run(async () => {
      const result = await this.api.closeSprint(
        project.id,
        sprint.id,
        target === KEEP ? {} : { moveUnfinishedTo: target === NONE ? null : target },
      );
      this.closing.set(null);
      await this.ctx.refresh();
      this.notice.set(`${result.sprint.name} closed; ${result.movedItems} unfinished items moved.`);
    });
  }

  /**
   * Deletes a sprint after confirmation; its items return to the backlog.
   *
   * @param sprint The sprint.
   * @returns Resolves once deleted.
   */
  protected async remove(sprint: SprintDto): Promise<void> {
    const project = this.ctx.project();
    if (project === null || !confirm(`Delete ${sprint.name}? Its items leave the sprint.`)) return;
    await this.run(async () => {
      await this.api.deleteSprint(project.id, sprint.id);
      await this.ctx.refresh();
    });
  }

  /**
   * Stores a sprint returned by the API.
   *
   * @param sprint The sprint.
   */
  private replace(sprint: SprintDto): void {
    this.ctx.sprints.update((list) =>
      list.some((s) => s.id === sprint.id)
        ? list.map((s) => (s.id === sprint.id ? sprint : s))
        : [...list, sprint],
    );
  }

  /**
   * Runs an action, showing any error instead of throwing.
   *
   * @param action The work to do.
   * @returns Resolves when done.
   */
  private async run(action: () => Promise<void>): Promise<void> {
    this.error.set('');
    this.notice.set('');
    try {
      await action();
    } catch (error) {
      this.error.set(errorMessage(error));
    }
  }
}
