import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import {
  type BucketDto,
  type CreateItemRequest,
  ItemType,
  ITEM_TITLE_MAX,
  requiresBucket,
} from '@kloister/shared';
import { TYPE_LABELS } from '../../core/labels';

/** What the new item dialog offers. */
export interface NewItemData {
  /** The project's buckets, in board order. */
  buckets: BucketDto[];
}

/**
 * "New item" (DESIGN §7): type, title and bucket of a new item. Epics and
 * Features may stay off the board; Stories, Tasks and Bugs need a bucket
 * (SPEC §4). Answers the create request, or null when cancelled.
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
          <mat-select name="type" [(ngModel)]="type">
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
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" [mat-dialog-close]="null">Cancel</button>
        <button mat-flat-button type="submit" [disabled]="!valid()">Create</button>
      </mat-dialog-actions>
    </form>
  `,
})
export class NewItemDialog {
  /** Buckets to choose from. */
  protected readonly data = inject<NewItemData>(MAT_DIALOG_DATA);
  private readonly ref =
    inject<MatDialogRef<NewItemDialog, CreateItemRequest | null>>(MatDialogRef);

  /** Item types. */
  protected readonly types = Object.values(ItemType);
  /** Type names. */
  protected readonly typeLabels = TYPE_LABELS;
  /** Longest title accepted. */
  protected readonly titleMax = ITEM_TITLE_MAX;

  /** Typed title. */
  protected title = '';
  /** Chosen type. */
  protected type: ItemType = ItemType.TASK;
  /** Chosen bucket, or null for off the board. */
  protected bucketId: string | null = this.data.buckets[0]?.id ?? null;

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
   * @returns True with a title and, where needed, a bucket.
   */
  protected valid(): boolean {
    return this.title.trim() !== '' && (!this.needsBucket() || this.bucketId !== null);
  }

  /** Answers the create request. */
  protected submit(): void {
    if (!this.valid()) return;
    this.ref.close({ type: this.type, title: this.title.trim(), bucketId: this.bucketId });
  }
}
