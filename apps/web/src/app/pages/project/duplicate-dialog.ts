import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import {
  ALLOWED_PARENT_TYPES,
  MAX_ASSIGNEES,
  type DuplicateItemRequest,
  type WorkItemDto,
  type WorkItemDetailDto,
} from '@kloister/shared';
import { firstValueFrom } from 'rxjs';
import { apiUrl, errorMessage } from '../../core/api';
import { ProjectContext } from '../../core/project-context';
import { SessionStore } from '../../core/session.store';
import { ToastService } from '../../ui/toast.service';

/** Explicit preview of independent fresh copies; assignment controls follow current capabilities. */
@Component({
  selector: 'app-duplicate-dialog',
  imports: [
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  styles: `
    mat-dialog-content {
      display: grid;
      gap: var(--k-space-3);
    }
    .preview {
      overflow-wrap: anywhere;
    }
  `,
  template: `
    <h2 mat-dialog-title>Duplicate item</h2>
    <mat-dialog-content>
      <p>
        Copies stay in {{ data.ctx.project()?.name }}. Each has its own status and checklist.
        Several assignees on one task share progress.
      </p>
      <mat-form-field
        ><mat-label>Copy mode</mat-label
        ><mat-select [(ngModel)]="mode"
          ><mat-option value="count">Number of copies</mat-option>
          @if (!personal()) {
            <mat-option value="people">One copy per person</mat-option>
          }
        </mat-select></mat-form-field
      >
      @if (mode === 'count') {
        <mat-form-field
          ><mat-label>Number of copies</mat-label
          ><input matInput type="number" min="1" max="1000" [(ngModel)]="count" /><mat-hint
            >Up to 1,000 copies per confirmation.</mat-hint
          ></mat-form-field
        >
      }
      @if (!personal()) {
        <mat-form-field
          ><mat-label>{{
            mode === 'people'
              ? 'People (one independent copy each)'
              : 'Optional assignees (shared per copy)'
          }}</mat-label
          ><mat-select multiple [(ngModel)]="assignees">
            @for (member of people(); track member.userId) {
              <mat-option [value]="member.userId">{{ member.displayName }}</mat-option>
            }
          </mat-select></mat-form-field
        >
      }
      <mat-form-field
        ><mat-label>Title for copies</mat-label><input matInput maxlength="255" [(ngModel)]="title"
      /></mat-form-field>
      <mat-form-field
        ><mat-label>Destination bucket</mat-label
        ><mat-select [(ngModel)]="bucketId"
          ><mat-option [value]="null">Off board (Epic or Feature)</mat-option>
          @for (bucket of data.ctx.buckets(); track bucket.id) {
            <mat-option [value]="bucket.id">{{ bucket.name }}</mat-option>
          }
        </mat-select></mat-form-field
      >
      @if (!personal()) {
        <mat-form-field
          ><mat-label>Team</mat-label
          ><mat-select [(ngModel)]="teamId" (valueChange)="assignees = []"
            ><mat-option [value]="null">No team</mat-option>
            @for (team of teams(); track team.id) {
              <mat-option [value]="team.id">{{ team.name }}</mat-option>
            }
          </mat-select></mat-form-field
        >
      }
      <mat-form-field
        ><mat-label>Optional parent</mat-label
        ><mat-select [(ngModel)]="parentId"
          ><mat-option [value]="null">No parent</mat-option>
          @for (parent of parents(); track parent.id) {
            <mat-option [value]="parent.id">{{ parent.key }} {{ parent.title }}</mat-option>
          }
        </mat-select></mat-form-field
      >
      <mat-checkbox [(ngModel)]="keepDates">Keep start and due dates</mat-checkbox>
      <mat-checkbox [(ngModel)]="keepSprint">Keep sprint (must still be open)</mat-checkbox>
      <mat-checkbox [(ngModel)]="attachments">Copy attachments</mat-checkbox>
      <p>
        Description images are copied and count against storage. Status, completion and checklist
        ticks reset. Notes, history, dependencies and children are excluded.
      </p>
      <h3>Preview · {{ copies().length }} independent copies</h3>
      <ol class="preview">
        @for (copy of copies(); track $index) {
          <li>{{ copy.title }} · {{ assignedNames(copy.assigneeIds) }}</li>
        }
      </ol>
      @if (error()) {
        <p class="k-alert" role="alert">{{ error() }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end"
      ><button mat-button mat-dialog-close [disabled]="busy()">Cancel</button
      ><button
        mat-flat-button
        type="button"
        [disabled]="
          busy() ||
          copies().length === 0 ||
          !title.trim() ||
          (mode === 'count' && assignees.length > maxAssignees)
        "
        (click)="create()"
      >
        Create {{ copies().length }} copies
      </button></mat-dialog-actions
    >
  `,
})
export class DuplicateDialog {
  /** Context supplied by a fully readable source action. */
  protected readonly data = inject<{ ctx: ProjectContext; item: WorkItemDto }>(MAT_DIALOG_DATA);
  private readonly http = inject(HttpClient);
  private readonly ref = inject(MatDialogRef<DuplicateDialog>);
  private readonly toast = inject(ToastService);
  private readonly user = inject(SessionStore).user;
  /** Explicit choice of shared-copy count versus independent per-person progress. */
  protected mode = 'count';
  /** Requested count; bounded visibly to keep the preview operable. */
  protected count = 1;
  /** Resulting copy title. */
  protected title = this.data.item.title;
  /** Chosen people, never inherited implicitly. */
  protected assignees: string[] = [];
  /** Same-space destination bucket. */
  protected bucketId = this.data.item.bucketId;
  /** Explicit optional destination team. */
  protected teamId: string | null =
    this.data.item.teamId !== null &&
    (this.data.ctx.canPickTeam(this.data.item.teamId) ||
      this.data.ctx.project()?.myTeams.some((team) => team.teamId === this.data.item.teamId))
      ? this.data.item.teamId
      : null;
  /** Parent is never inherited implicitly. */
  protected parentId: string | null = null;
  /** Dates are opt-in. */
  protected keepDates = false;
  /** Sprint is opt-in. */
  protected keepSprint = false;
  /** Non-inline attachments are opt-in. */
  protected attachments = false;
  /** Ordinary maximum assignments on a shared task. */
  protected readonly maxAssignees = MAX_ASSIGNEES;
  /** Submission state. */
  protected readonly busy = signal(false);
  /** Actionable server error, including stale permissions and quota failures. */
  protected readonly error = signal('');
  /** Personal ownership remains implicit. */
  protected readonly personal = computed(() => this.data.ctx.project()?.ownerId !== null);
  /**
   * Lists only people the caller may assign in this team.
   * @returns Available active project members.
   */
  protected people() {
    return this.data.ctx
      .members()
      .filter(
        (m) =>
          m.isActive &&
          (m.userId === this.user()?.id || this.data.ctx.canAssignOthers(this.teamId)),
      );
  }
  /**
   * Offers normal creation team destinations, including the caller's member teams.
   * @returns Permitted team choices.
   */
  protected teams() {
    return this.data.ctx
      .teams()
      .filter(
        (t) =>
          this.data.ctx.canPickTeam(t.id) ||
          this.data.ctx.project()?.myTeams.some((place) => place.teamId === t.id),
      );
  }
  /**
   * Offers only fully readable, compatible parent references.
   * @returns Parent candidates.
   */
  protected parents() {
    return this.data.ctx
      .items()
      .filter((i) => ALLOWED_PARENT_TYPES[this.data.item.type].includes(i.type));
  }
  /**
   * Builds the exact confirmation payload without inheriting assignments.
   * @returns The previewed independent titles and people.
   */
  protected copies() {
    const ids = this.assignees.filter((id) => this.people().some((m) => m.userId === id));
    if (this.mode === 'people')
      return ids.map((id) => ({ title: this.title.trim(), assigneeIds: [id] }));
    return Number.isInteger(this.count) && this.count >= 1 && this.count <= 1000
      ? Array.from({ length: this.count }, () => ({
          title: this.title.trim(),
          assigneeIds: this.personal() ? [] : ids,
        }))
      : [];
  }
  /**
   * Names the preview's ownership/assignments.
   * @param ids Previewed project members.
   * @returns Visible names.
   */
  protected assignedNames(ids: string[]): string {
    return this.personal()
      ? 'Only you (private)'
      : ids
          .map((id) => this.data.ctx.membersById().get(id)?.displayName ?? 'Unavailable')
          .join(', ') || 'Unassigned';
  }
  /**
   * Submits the confirmed batch and refreshes the ordinary source view.
   * @returns Resolves when created or the refusal is shown.
   */
  protected async create(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    const body: DuplicateItemRequest = {
      copies: this.copies(),
      bucketId: this.bucketId,
      teamId: this.teamId,
      parentId: this.parentId,
      keepDates: this.keepDates,
      keepSprint: this.keepSprint,
      attachments: this.attachments,
    };
    try {
      const result = await firstValueFrom(
        this.http.post<WorkItemDetailDto[]>(
          apiUrl(
            `projects/${this.data.ctx.project()?.id ?? ''}/items/${this.data.item.id}/duplicate`,
          ),
          body,
        ),
      );
      result.forEach((item) => this.data.ctx.upsert(item));
      this.toast.show(`${result.length} independent copies created`);
      this.ref.close(true);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}
