import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import {
  type BucketDto,
  type CreateItemRequest,
  hasOwnSprint,
  isAllowedParent,
  ItemType,
  ITEM_TITLE_MAX,
  mayBeAdHoc,
  requiresBucket,
  type SprintDto,
} from '@kloister/shared';
import { TYPE_LABELS } from '../../core/labels';
import { DateField } from '../../ui/date-field';

/** An item the new item may sit under. */
export interface NewItemParent {
  /** Item id. */
  id: string;
  /** Display key, e.g. "KLO-3". */
  key: string;
  /** Title. */
  title: string;
  /** Type, which decides what may sit under it. */
  type: ItemType;
}

/** What the new item dialog offers. */
export interface NewItemData {
  /** The project's buckets, in board order. */
  buckets: BucketDto[];
  /** Items the caller sees in full that a new item may sit under. */
  parents?: NewItemParent[];
  /** Sprints a new item may join (not closed). */
  sprints?: SprintDto[];
  /** The project's "New items start in" bucket (M12); the first bucket when missing. */
  defaultBucketId?: string | null;
}

/**
 * "New item" (DESIGN §7): type, title and bucket of a new item, and
 * optionally its parent, sprint and dates. Those plan fields are offered
 * here because a project may keep later changes to PMs and Leads (SPEC §3.2,
 * M9.2). Epics and Features may stay off the board; Stories, Tasks and Bugs
 * need a bucket (SPEC §4), preselected from the project's "New items start
 * in" setting. Epics and Features take no sprint, and Tasks and Bugs may be
 * ad hoc, without a parent (M12). Answers the create request, or null when
 * cancelled.
 */
@Component({
  selector: 'app-new-item-dialog',
  imports: [
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    DateField,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form (ngSubmit)="submit()">
      <h2 mat-dialog-title>New item</h2>
      <mat-dialog-content style="display: flex; flex-direction: column; padding-top: 4px">
        <mat-form-field>
          <mat-label>Title</mat-label>
          <input
            matInput
            name="title"
            required
            [attr.maxlength]="titleMax"
            [(ngModel)]="title"
            cdkFocusInitial
          />
        </mat-form-field>
        <mat-form-field>
          <mat-label>Type</mat-label>
          <mat-select name="type" [(ngModel)]="type" (ngModelChange)="typeChanged()">
            @for (t of types; track t) {
              <mat-option [value]="t">{{ typeLabels[t] }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>Bucket</mat-label>
          <mat-select name="bucket" [(ngModel)]="bucketId">
            @if (!needsBucket()) {
              <mat-option [value]="null">Off the board</mat-option>
            }
            @for (b of data.buckets; track b.id) {
              <mat-option [value]="b.id">{{ b.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        @if (canBeAdHoc()) {
          <mat-slide-toggle
            name="adHoc"
            [(ngModel)]="adHoc"
            style="margin-bottom: var(--k-space-4)"
          >
            Ad hoc: not part of the plan
          </mat-slide-toggle>
        }
        @if (!adHoc && parentOptions().length > 0) {
          <mat-form-field>
            <mat-label>Parent</mat-label>
            <mat-select name="parent" [(ngModel)]="parentId">
              <mat-option [value]="null">No parent</mat-option>
              @for (p of parentOptions(); track p.id) {
                <mat-option [value]="p.id">{{ p.key }} {{ p.title }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        }
        @if (sprints.length > 0 && hasSprint()) {
          <mat-form-field>
            <mat-label>Sprint</mat-label>
            <mat-select name="sprint" [(ngModel)]="sprintId">
              <mat-option [value]="null">No sprint</mat-option>
              @for (s of sprints; track s.id) {
                <mat-option [value]="s.id">{{ s.name }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        }
        <div class="dates" style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px">
          <app-date-field
            label="Start date"
            [value]="startDate"
            (valueChange)="startDate = $event"
          />
          <span aria-hidden="true">→</span>
          <app-date-field
            label="Due date"
            [value]="dueDate"
            [min]="startDate"
            (valueChange)="dueDate = $event"
          />
        </div>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" [mat-dialog-close]="null">Cancel</button>
        <button mat-flat-button type="submit" [disabled]="!valid()">Create</button>
      </mat-dialog-actions>
    </form>
  `,
})
export class NewItemDialog {
  /** Buckets, parents and sprints to choose from. */
  protected readonly data = inject<NewItemData>(MAT_DIALOG_DATA);
  private readonly ref =
    inject<MatDialogRef<NewItemDialog, CreateItemRequest | null>>(MatDialogRef);

  /** Item types. */
  protected readonly types = Object.values(ItemType);
  /** Type names. */
  protected readonly typeLabels = TYPE_LABELS;
  /** Longest title accepted. */
  protected readonly titleMax = ITEM_TITLE_MAX;
  /** Sprints to offer. */
  protected readonly sprints = this.data.sprints ?? [];

  /** Typed title. */
  protected title = '';
  /** Chosen type. */
  protected type: ItemType = ItemType.TASK;
  /** Chosen bucket, or null for off the board. */
  protected bucketId: string | null =
    this.data.buckets.find((b) => b.id === this.data.defaultBucketId)?.id ??
    this.data.buckets[0]?.id ??
    null;
  /** Ad hoc: tracked but not part of the plan (M12). */
  protected adHoc = false;
  /** Chosen parent, or null. */
  protected parentId: string | null = null;
  /** Chosen sprint, or null. */
  protected sprintId: string | null = null;
  /** Start date, `YYYY-MM-DD`, or null. */
  protected startDate: string | null = null;
  /** Due date, `YYYY-MM-DD`, or null. */
  protected dueDate: string | null = null;

  /**
   * Parents the chosen type may sit under (SPEC §4.1).
   *
   * @returns The candidates.
   */
  protected parentOptions(): NewItemParent[] {
    return (this.data.parents ?? []).filter((p) => isAllowedParent(this.type, p.type));
  }

  /**
   * Reports whether the chosen type may be ad hoc.
   *
   * @returns True for Tasks and Bugs.
   */
  protected canBeAdHoc(): boolean {
    return mayBeAdHoc(this.type);
  }

  /**
   * Reports whether the chosen type has a sprint of its own.
   *
   * @returns False for Epics and Features.
   */
  protected hasSprint(): boolean {
    return hasOwnSprint(this.type);
  }

  /** Drops a parent, sprint or ad-hoc choice the new type may not have. */
  protected typeChanged(): void {
    if (!this.parentOptions().some((p) => p.id === this.parentId)) this.parentId = null;
    if (!this.hasSprint()) this.sprintId = null;
    if (!this.canBeAdHoc()) this.adHoc = false;
  }

  /**
   * Reports whether the type must have a bucket.
   *
   * @returns True for Stories, Tasks and Bugs.
   */
  protected needsBucket(): boolean {
    return requiresBucket(this.type);
  }

  /**
   * Reports whether the form can be sent.
   *
   * @returns True with a title, where needed a bucket, and dates in order.
   */
  protected valid(): boolean {
    return (
      this.title.trim() !== '' &&
      (!this.needsBucket() || this.bucketId !== null) &&
      (this.startDate === null || this.dueDate === null || this.startDate <= this.dueDate)
    );
  }

  /** Answers the create request; empty optional fields are left out. */
  protected submit(): void {
    if (!this.valid()) return;
    this.ref.close({
      type: this.type,
      title: this.title.trim(),
      bucketId: this.bucketId,
      ...(this.parentId === null || this.adHoc ? {} : { parentId: this.parentId }),
      ...(this.sprintId === null ? {} : { sprintId: this.sprintId }),
      ...(this.adHoc ? { adHoc: true } : {}),
      ...(this.startDate === null ? {} : { startDate: this.startDate }),
      ...(this.dueDate === null ? {} : { dueDate: this.dueDate }),
    });
  }
}
