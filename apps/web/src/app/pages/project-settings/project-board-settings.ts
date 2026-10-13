import { Component, computed, effect, inject, input, model, output, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import {
  BOARD_NAME_MAX,
  type BucketDto,
  BucketRule,
  ItemStatus,
  type LabelDto,
  type ProjectDto,
  type StatusToBucket,
  type UpdateBucketRequest,
  type UpdateLabelRequest,
} from '@kloister/shared';
import { errorMessage } from '../../core/api';
import { ItemsApiService } from '../../core/items-api.service';
import { ProjectsApiService } from '../../core/projects-api.service';
import { BUCKET_RULE_LABELS, STATUS_LABELS } from '../../core/labels';

/** Select value for "no mapping" in the status → bucket map. */
const NO_MOVE = '';

/** Colour offered for a new label: neutral slate. */
const DEFAULT_LABEL_COLOUR = '#64748b';

/**
 * Board settings inside the project settings page (SPEC §6): buckets with
 * their entry rules (SPEC §4.2), labels, and the `statusToBucket` map.
 *
 * Everyone who can open the project sees them. Buckets and labels can be
 * changed with `MANAGE_BOARD` (PM, Lead); the map is a project setting and
 * needs `MANAGE_PROJECT` (PM). The parent passes both flags (false on
 * archived projects); the API enforces the same rules.
 */
@Component({
  selector: 'app-project-board-settings',
  imports: [MatButtonModule, MatCardModule, MatFormFieldModule, MatInputModule, MatSelectModule],
  template: `
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    <mat-card>
      <mat-card-header><mat-card-title>Buckets</mat-card-title></mat-card-header>
      <mat-card-content>
        <p>Moving a card into a bucket can set its status.</p>
        <table class="data">
          <thead>
            <tr>
              <th scope="col">Bucket</th>
              <th scope="col">When a card enters</th>
              <th scope="col"><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <!-- Tracked by object: rows are rebuilt from the stored values after a refusal. -->
            @for (b of buckets(); track b; let first = $first, last = $last) {
              <tr>
                @if (canManageBoard()) {
                  <td>
                    <input
                      class="quick-add"
                      [value]="b.name"
                      [attr.maxlength]="nameMax"
                      [attr.aria-label]="'Name of ' + b.name"
                      (change)="renameBucket(b, $any($event.target))"
                    />
                  </td>
                  <td>
                    <div class="row">
                      <mat-select
                        [aria-label]="'Rule of ' + b.name"
                        [value]="b.onEnterMode"
                        (valueChange)="setRule(b, $event, b.onEnterStatus)"
                      >
                        @for (r of rules; track r) {
                          <mat-option [value]="r">{{ ruleLabels[r] }}</mat-option>
                        }
                      </mat-select>
                      @if (b.onEnterMode !== none) {
                        <mat-select
                          [aria-label]="'Status set by ' + b.name"
                          [value]="b.onEnterStatus"
                          (valueChange)="setRule(b, b.onEnterMode, $event)"
                        >
                          @for (s of statuses; track s) {
                            <mat-option [value]="s">{{ statusLabels[s] }}</mat-option>
                          }
                        </mat-select>
                      }
                    </div>
                  </td>
                  <td class="actions">
                    <button mat-button type="button" [disabled]="first" (click)="moveBucket(b, -1)">
                      Up
                    </button>
                    <button mat-button type="button" [disabled]="last" (click)="moveBucket(b, 1)">
                      Down
                    </button>
                    <button
                      mat-button
                      type="button"
                      [disabled]="buckets().length < 2"
                      (click)="deleting.set(b)"
                    >
                      Delete
                    </button>
                  </td>
                } @else {
                  <td>{{ b.name }}</td>
                  <td>{{ describeRule(b) }}</td>
                  <td></td>
                }
              </tr>
            }
          </tbody>
        </table>

        @if (deleting(); as b) {
          <div class="row" role="group" [attr.aria-label]="'Delete ' + b.name">
            <span>Delete {{ b.name }} and move its cards to</span>
            <mat-select
              aria-label="Bucket receiving the cards"
              [value]="moveTarget()"
              (valueChange)="moveTarget.set($event)"
            >
              @for (o of buckets(); track o.id) {
                @if (o.id !== b.id) {
                  <mat-option [value]="o.id">{{ o.name }}</mat-option>
                }
              }
            </mat-select>
            <button
              mat-flat-button
              type="button"
              [disabled]="!moveTarget()"
              (click)="deleteBucket(b)"
            >
              Delete bucket
            </button>
            <button mat-button type="button" (click)="deleting.set(null)">Cancel</button>
          </div>
        }

        @if (canManageBoard()) {
          <div class="row">
            <mat-form-field>
              <mat-label>New bucket name</mat-label>
              <input
                matInput
                #bucketName
                [attr.maxlength]="nameMax"
                (keyup.enter)="createBucket(bucketName)"
              />
            </mat-form-field>
            <button mat-button type="button" (click)="createBucket(bucketName)">Add bucket</button>
          </div>
        }
      </mat-card-content>
    </mat-card>

    <mat-card>
      <mat-card-header><mat-card-title>Status moves cards</mat-card-title></mat-card-header>
      <mat-card-content>
        <p>When an item's status changes in its details, its card can move to a bucket.</p>
        <div class="row">
          @for (s of statuses; track s) {
            <mat-form-field>
              <mat-label>{{ statusLabels[s] }}</mat-label>
              <mat-select
                [value]="map()[s] ?? noMove"
                [disabled]="!canManageProject()"
                (valueChange)="setMapping(s, $event)"
              >
                <mat-option [value]="noMove">Don't move</mat-option>
                @for (b of buckets(); track b.id) {
                  <mat-option [value]="b.id">{{ b.name }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
          }
        </div>
        @if (canManageProject() && mapChanged()) {
          <button mat-flat-button type="button" (click)="saveMap()">Save status moves</button>
        }
      </mat-card-content>
    </mat-card>

    <mat-card>
      <mat-card-header><mat-card-title>Labels</mat-card-title></mat-card-header>
      <mat-card-content>
        <ul class="labels">
          @for (l of labels(); track l.id) {
            <li class="row">
              @if (canManageBoard()) {
                <input
                  type="color"
                  [value]="l.colour"
                  [attr.aria-label]="'Colour of ' + l.name"
                  (change)="updateLabel(l, { colour: $any($event.target).value })"
                />
                <input
                  class="quick-add"
                  [value]="l.name"
                  [attr.maxlength]="nameMax"
                  [attr.aria-label]="'Name of label ' + l.name"
                  (change)="renameLabel(l, $any($event.target))"
                />
                <button mat-button type="button" (click)="deleteLabel(l)">Delete</button>
              } @else {
                <span class="label" [style.border-left-color]="l.colour">{{ l.name }}</span>
              }
            </li>
          } @empty {
            <li>No labels yet.</li>
          }
        </ul>
        @if (canManageBoard()) {
          <div class="row">
            <input
              type="color"
              #labelColour
              [value]="defaultColour"
              aria-label="New label colour"
            />
            <mat-form-field>
              <mat-label>New label name</mat-label>
              <input
                matInput
                #labelName
                [attr.maxlength]="nameMax"
                (keyup.enter)="createLabel(labelName, labelColour)"
              />
            </mat-form-field>
            <button mat-button type="button" (click)="createLabel(labelName, labelColour)">
              Add label
            </button>
          </div>
        }
      </mat-card-content>
    </mat-card>
  `,
})
export class ProjectBoardSettings {
  private readonly api = inject(ItemsApiService);
  private readonly projectsApi = inject(ProjectsApiService);

  /** The project. */
  readonly project = input.required<ProjectDto>();
  /** Buckets in column order; shared with the members section's bucket picker. */
  readonly buckets = model<BucketDto[]>([]);
  /** Show bucket and label controls (`MANAGE_BOARD`, project not archived). */
  readonly canManageBoard = input(false);
  /** Allow editing the status → bucket map (`MANAGE_PROJECT`, project not archived). */
  readonly canManageProject = input(false);
  /** Emits the project after its settings were saved. */
  readonly projectChange = output<ProjectDto>();

  /** Rule values. */
  protected readonly rules = Object.values(BucketRule);
  /** "No change" rule. */
  protected readonly none = BucketRule.NONE;
  /** Status values. */
  protected readonly statuses = Object.values(ItemStatus);
  /** Rule names. */
  protected readonly ruleLabels = BUCKET_RULE_LABELS;
  /** Status names. */
  protected readonly statusLabels = STATUS_LABELS;
  /** Longest bucket or label name. */
  protected readonly nameMax = BOARD_NAME_MAX;
  /** "Don't move" select value. */
  protected readonly noMove = NO_MOVE;
  /** Colour of a new label. */
  protected readonly defaultColour = DEFAULT_LABEL_COLOUR;

  /** Labels. */
  protected readonly labels = signal<LabelDto[]>([]);
  /** The status → bucket map being edited. */
  protected readonly map = signal<StatusToBucket>({});
  /** The bucket whose delete options are shown. */
  protected readonly deleting = signal<BucketDto | null>(null);
  /** Bucket that receives a deleted bucket's cards. */
  protected readonly moveTarget = signal('');
  /** Last error, if any. */
  protected readonly error = signal('');

  /** True when the edited map differs from the stored one. */
  protected readonly mapChanged = computed(
    () =>
      JSON.stringify(sorted(this.map())) !==
      JSON.stringify(sorted(this.project().settings.statusToBucket)),
  );

  /**
   * Loads labels and copies the stored map whenever the project changes.
   */
  constructor() {
    effect(() => this.map.set({ ...this.project().settings.statusToBucket }));
    effect(() => {
      const projectId = this.project().id;
      void this.run(async () => this.labels.set(await this.api.labels(projectId)));
    });
  }

  /**
   * Describes a bucket's entry rule for the read-only view.
   *
   * @param bucket The bucket.
   * @returns E.g. "Set status: Done".
   */
  protected describeRule(bucket: BucketDto): string {
    const rule = BUCKET_RULE_LABELS[bucket.onEnterMode];
    return bucket.onEnterStatus === null ? rule : `${rule}: ${STATUS_LABELS[bucket.onEnterStatus]}`;
  }

  /**
   * Adds a bucket as the last column.
   *
   * @param input The name field.
   * @returns Resolves once created.
   */
  protected async createBucket(input: HTMLInputElement): Promise<void> {
    const name = input.value.trim();
    if (name === '') return;
    await this.run(async () => {
      const bucket = await this.api.createBucket(this.project().id, { name });
      this.buckets.update((list) => [...list, bucket]);
      input.value = '';
    });
  }

  /**
   * Renames a bucket; an emptied name is put back.
   *
   * @param bucket The bucket.
   * @param input The name field.
   * @returns Resolves once saved.
   */
  protected async renameBucket(bucket: BucketDto, input: HTMLInputElement): Promise<void> {
    const name = input.value.trim();
    if (name === '' || name === bucket.name) {
      input.value = bucket.name;
      return;
    }
    await this.updateBucket(bucket, { name });
  }

  /**
   * Changes a bucket's entry rule. Rules that set a status default to the
   * status they are named after when none is chosen yet.
   *
   * @param bucket The bucket.
   * @param mode New rule.
   * @param status Status the rule sets.
   * @returns Resolves once saved.
   */
  protected async setRule(
    bucket: BucketDto,
    mode: BucketRule,
    status: ItemStatus | null,
  ): Promise<void> {
    const onEnterStatus = mode === BucketRule.NONE ? null : (status ?? ItemStatus.IN_PROGRESS);
    await this.updateBucket(bucket, { onEnterMode: mode, onEnterStatus });
  }

  /**
   * Moves a bucket one column left or right.
   *
   * @param bucket The bucket.
   * @param step -1 for left, 1 for right.
   * @returns Resolves once moved.
   */
  protected async moveBucket(bucket: BucketDto, step: -1 | 1): Promise<void> {
    const list = this.buckets();
    const index = list.findIndex((b) => b.id === bucket.id);
    const others = list.filter((b) => b.id !== bucket.id);
    const newIndex = index + step;
    const afterId = newIndex > 0 ? (others[newIndex - 1]?.id ?? null) : null;
    await this.run(async () => {
      await this.api.moveBucket(this.project().id, bucket.id, afterId);
      this.buckets.set(await this.api.buckets(this.project().id));
    });
  }

  /**
   * Deletes a bucket, moving its cards to the chosen bucket.
   *
   * @param bucket The bucket.
   * @returns Resolves once deleted.
   */
  protected async deleteBucket(bucket: BucketDto): Promise<void> {
    const target = this.moveTarget();
    await this.run(async () => {
      await this.api.deleteBucket(this.project().id, bucket.id, target || undefined);
      this.buckets.update((list) => list.filter((b) => b.id !== bucket.id));
      this.deleting.set(null);
      this.moveTarget.set('');
      // The API also removed the bucket from the status map.
      this.projectChange.emit(await this.projectsApi.get(this.project().id));
    });
  }

  /**
   * Sets or clears one entry of the status → bucket map (not yet saved).
   *
   * @param status The status.
   * @param bucketId Target bucket, or "don't move".
   */
  protected setMapping(status: ItemStatus, bucketId: string): void {
    this.map.update((map) => {
      const next = { ...map };
      if (bucketId === NO_MOVE) delete next[status];
      else next[status] = bucketId;
      return next;
    });
  }

  /**
   * Saves the status → bucket map.
   *
   * @returns Resolves once saved.
   */
  protected async saveMap(): Promise<void> {
    await this.run(async () => {
      const project = await this.projectsApi.update(this.project().id, {
        settings: { statusToBucket: this.map() },
      });
      this.projectChange.emit(project);
    });
  }

  /**
   * Adds a label.
   *
   * @param name The name field.
   * @param colour The colour field.
   * @returns Resolves once created.
   */
  protected async createLabel(name: HTMLInputElement, colour: HTMLInputElement): Promise<void> {
    const text = name.value.trim();
    if (text === '') return;
    await this.run(async () => {
      const label = await this.api.createLabel(this.project().id, {
        name: text,
        colour: colour.value,
      });
      this.labels.update((list) => [...list, label]);
      name.value = '';
    });
  }

  /**
   * Renames a label; an emptied name is put back.
   *
   * @param label The label.
   * @param input The name field.
   * @returns Resolves once saved.
   */
  protected async renameLabel(label: LabelDto, input: HTMLInputElement): Promise<void> {
    const name = input.value.trim();
    if (name === '' || name === label.name) {
      input.value = label.name;
      return;
    }
    await this.updateLabel(label, { name });
  }

  /**
   * Renames or recolours a label.
   *
   * @param label The label.
   * @param change Fields to change.
   * @returns Resolves once saved.
   */
  protected async updateLabel(label: LabelDto, change: UpdateLabelRequest): Promise<void> {
    await this.run(async () => {
      const updated = await this.api.updateLabel(this.project().id, label.id, change);
      this.labels.update((list) => list.map((l) => (l.id === updated.id ? updated : l)));
    });
  }

  /**
   * Deletes a label after confirmation; it is removed from every item.
   *
   * @param label The label.
   * @returns Resolves once deleted.
   */
  protected async deleteLabel(label: LabelDto): Promise<void> {
    if (!confirm(`Delete the label ${label.name}? It is removed from every item.`)) return;
    await this.run(async () => {
      await this.api.deleteLabel(this.project().id, label.id);
      this.labels.update((list) => list.filter((l) => l.id !== label.id));
    });
  }

  /**
   * Saves a bucket change.
   *
   * @param bucket The bucket.
   * @param change Fields to change.
   * @returns Resolves once saved.
   */
  private async updateBucket(bucket: BucketDto, change: UpdateBucketRequest): Promise<void> {
    const ok = await this.run(async () => {
      const updated = await this.api.updateBucket(this.project().id, bucket.id, change);
      this.buckets.update((list) => list.map((b) => (b.id === updated.id ? updated : b)));
    });
    // Fresh objects rebuild the rows, so the controls show the stored values.
    if (!ok) this.buckets.update((list) => list.map((b) => ({ ...b })));
  }

  /**
   * Runs an action, showing any error instead of throwing.
   *
   * @param action The work to do.
   * @returns True if it succeeded.
   */
  private async run(action: () => Promise<void>): Promise<boolean> {
    this.error.set('');
    try {
      await action();
      return true;
    } catch (error) {
      this.error.set(errorMessage(error));
      return false;
    }
  }
}

/**
 * Sorts a map's keys, for comparing two maps.
 *
 * @param map The map.
 * @returns Entries sorted by status.
 */
function sorted(map: StatusToBucket): [string, string | undefined][] {
  return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
}
