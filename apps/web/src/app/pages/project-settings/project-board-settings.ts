import { Component, computed, effect, inject, input, model, output, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';
import {
  BOARD_NAME_MAX,
  type BucketDto,
  BucketRule,
  ItemStatus,
  type LabelDto,
  LabelStyle,
  type ProjectDto,
  type StatusToBucket,
  type UpdateBucketRequest,
  type UpdateLabelRequest,
} from '@kloister/shared';
import { errorMessage } from '../../core/api';
import { Dialogs } from '../../ui/dialogs';
import { ItemsApiService } from '../../core/items-api.service';
import { ProjectsApiService } from '../../core/projects-api.service';
import { LABEL_PALETTE } from '../../core/colour';
import { BUCKET_RULE_LABELS, STATUS_LABELS } from '../../core/labels';
import { EmptyState } from '../../ui/feedback';
import { Icon } from '../../ui/icon';
import { LabelPill } from '../../ui/label-pill';

/** Select value for "no mapping" in the status → bucket map. */
const NO_MOVE = '';

/** Colour offered for a new label: indigo from the curated palette. */
const DEFAULT_LABEL_COLOUR = '#3E63DD';

/**
 * Board settings inside the project settings page (SPEC §6): buckets with
 * their entry rules (SPEC §4.2), labels with the curated palette or a custom
 * colour (DESIGN §4), the project's label style, and the `statusToBucket`
 * map.
 *
 * Everyone who can open the project sees them. Buckets and labels can be
 * changed with `MANAGE_BOARD` (PM, Lead); the map and the label style are
 * project settings and need `MANAGE_PROJECT` (PM). The parent passes both flags (false on
 * archived projects); the API enforces the same rules.
 */
@Component({
  selector: 'app-project-board-settings',
  imports: [
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatMenuModule,
    MatSelectModule,
    EmptyState,
    Icon,
    LabelPill,
  ],
  styles: `
    .labels-card {
      display: flex;
      flex-direction: column;
      gap: var(--k-space-4);
    }
    .style-options {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(var(--k-size-200px), 1fr));
      gap: var(--k-size-10px);
      margin-top: var(--k-space-2);
    }
    .style-option {
      display: flex;
      flex-direction: column;
      gap: var(--k-size-6px);
      padding: var(--k-space-3);
      border: var(--k-line) solid var(--k-border);
      border-radius: var(--k-radius-md);
      cursor: pointer;
    }
    .style-option.on {
      border-color: var(--k-primary);
      background: var(--k-primary-soft);
    }
    .style-name {
      font-weight: 600;
    }
    .style-text {
      font-size: var(--k-small);
      color: var(--k-muted);
    }
    .sample,
    .palette-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--k-size-6px);
    }
    .label-list li {
      display: grid;
      width: min(100%, var(--k-label-row-width));
      grid-template-columns: var(--k-target) minmax(0, 1fr) var(--k-label-preview-width) var(
          --k-target
        );
      align-items: center;
      gap: var(--k-size-10px);
      padding: var(--k-space-1) 0;
    }
    .label-list .quick-add {
      min-width: 0;
      max-width: none;
      margin: 0;
    }
    .label-list app-label-pill {
      min-width: 0;
      overflow: hidden;
    }
    @media (max-width: 599px) {
      .label-list li {
        grid-template-columns: var(--k-target) minmax(0, 1fr) var(--k-target);
      }
      .label-list app-label-pill {
        grid-column: 2;
        grid-row: 2;
      }
      .label-list .k-icon-btn {
        grid-column: 3;
        grid-row: 1;
      }
    }
    .swatch {
      flex: none;
      width: var(--k-size-28px);
      height: var(--k-size-28px);
      padding: 0;
      border: var(--k-focus-width) solid var(--k-surface);
      border-radius: 50%;
      box-shadow: 0 0 0 var(--k-line) var(--k-border-strong);
      cursor: pointer;
    }
    .swatch.on {
      box-shadow: 0 0 0 var(--k-focus-width) var(--k-primary);
    }
    .swatch.small {
      width: var(--k-space-4);
      height: var(--k-space-4);
      margin-right: var(--k-space-2);
      vertical-align: middle;
    }
    .custom {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--k-space-2);
      padding: var(--k-space-2) var(--k-space-4);
      font-size: var(--k-body-sm);
    }
    .custom-input {
      width: var(--k-control-height);
      height: var(--k-size-28px);
      padding: 0;
      border: 0;
      background: transparent;
    }
  `,
  template: `
    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    <mat-card>
      <mat-card-header><mat-card-title>Buckets</mat-card-title></mat-card-header>
      <mat-card-content>
        <p>Moving a card into a bucket can set its status.</p>
        <div class="k-table-scroll" tabindex="0" role="region" aria-label="Scrollable table">
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
                      <button
                        mat-button
                        type="button"
                        [disabled]="first"
                        (click)="moveBucket(b, -1)"
                      >
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
        </div>

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
      <mat-card-content class="labels-card">
        <div role="radiogroup" aria-labelledby="label-style-title" class="styles">
          <div id="label-style-title" class="muted">
            Label style for this project{{ canManageProject() ? '' : ' (set by PMs)' }}
          </div>
          <div class="style-options">
            @for (option of styleOptions; track option.value) {
              <label
                class="style-option"
                [class.on]="project().settings.labelStyle === option.value"
              >
                <input
                  type="radio"
                  name="label-style"
                  [value]="option.value"
                  [checked]="project().settings.labelStyle === option.value"
                  [disabled]="!canManageProject()"
                  (change)="setLabelStyle(option.value)"
                />
                <span class="style-name">{{ option.name }}</span>
                <span class="style-text">{{ option.text }}</span>
                <span class="sample">
                  @for (l of sampleLabels(); track l.name) {
                    <app-label-pill [name]="l.name" [colour]="l.hex" [labelStyle]="option.value" />
                  }
                </span>
              </label>
            }
          </div>
        </div>

        <ul class="plain label-list">
          @for (l of labels(); track l.id) {
            <li>
              @if (canManageBoard()) {
                <button
                  type="button"
                  class="swatch"
                  [style.background]="l.colour"
                  [matMenuTriggerFor]="palette"
                  [matMenuTriggerData]="{ label: l }"
                  [attr.aria-label]="'Colour of ' + l.name"
                ></button>
                <input
                  class="quick-add"
                  [value]="l.name"
                  [attr.maxlength]="nameMax"
                  [attr.aria-label]="'Name of label ' + l.name"
                  (change)="renameLabel(l, $any($event.target))"
                />
                <app-label-pill
                  [name]="l.name"
                  [colour]="l.colour"
                  [labelStyle]="project().settings.labelStyle"
                />
                <button
                  type="button"
                  class="k-icon-btn sm"
                  [attr.aria-label]="'Delete label ' + l.name"
                  (click)="deleteLabel(l)"
                >
                  <app-icon name="trash" />
                </button>
              } @else {
                <app-label-pill
                  [name]="l.name"
                  [colour]="l.colour"
                  [labelStyle]="project().settings.labelStyle"
                />
              }
            </li>
          } @empty {
            <li>
              <app-empty-state
                title="No labels yet"
                [text]="
                  canManageBoard()
                    ? 'Labels give cards a coloured tag, such as frontend or customer.'
                    : ''
                "
              />
            </li>
          }
        </ul>

        <mat-menu #palette="matMenu">
          <ng-template matMenuContent let-label="label">
            <div class="palette" role="group" [attr.aria-label]="'Colours for ' + label.name">
              @for (c of paletteColours; track c.hex) {
                <button
                  type="button"
                  mat-menu-item
                  class="palette-item"
                  [attr.aria-label]="c.name"
                  (click)="updateLabel(label, { colour: c.hex })"
                >
                  <span class="swatch small" [style.background]="c.hex"></span>{{ c.name }}
                </button>
              }
            </div>
            <label class="custom">
              Custom colour
              <input
                type="color"
                [value]="label.colour"
                [attr.aria-label]="'Custom colour of ' + label.name"
                (click)="$event.stopPropagation()"
                (keydown)="$event.stopPropagation()"
                (change)="updateLabel(label, { colour: $any($event.target).value })"
              />
            </label>
          </ng-template>
        </mat-menu>

        @if (canManageBoard()) {
          <div class="new-label">
            <div class="palette-row" role="radiogroup" aria-label="New label colour">
              @for (c of paletteColours; track c.hex) {
                <button
                  type="button"
                  role="radio"
                  class="swatch"
                  [class.on]="newColour() === c.hex"
                  [style.background]="c.hex"
                  [attr.aria-checked]="newColour() === c.hex"
                  [attr.aria-label]="c.name"
                  (click)="newColour.set(c.hex)"
                ></button>
              }
              <input
                type="color"
                class="custom-input"
                aria-label="Custom colour for the new label"
                [value]="newColour()"
                (change)="newColour.set($any($event.target).value)"
              />
            </div>
            <div class="row">
              <mat-form-field>
                <mat-label>New label name</mat-label>
                <input
                  matInput
                  #labelName
                  [attr.maxlength]="nameMax"
                  (input)="newName.set(labelName.value)"
                  (keyup.enter)="createLabel(labelName)"
                />
              </mat-form-field>
              <app-label-pill
                [name]="newName() || 'Preview'"
                [colour]="newColour()"
                [labelStyle]="project().settings.labelStyle"
              />
              <button mat-button type="button" (click)="createLabel(labelName)">Add label</button>
            </div>
          </div>
        }
      </mat-card-content>
    </mat-card>
  `,
})
export class ProjectBoardSettings {
  private readonly api = inject(ItemsApiService);
  private readonly dialogs = inject(Dialogs);
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
  /** The curated label palette. */
  protected readonly paletteColours = LABEL_PALETTE;
  /** Name typed for the next new label, for its preview. */
  protected readonly newName = signal('');
  /** Colour of the next new label. */
  protected readonly newColour = signal(DEFAULT_LABEL_COLOUR);
  /** The three label styles (DESIGN §4.2). */
  protected readonly styleOptions: { value: LabelStyle; name: string; text: string }[] = [
    { value: LabelStyle.SOLID, name: 'Solid (default)', text: 'Full colour; the strongest cue.' },
    { value: LabelStyle.TINTED, name: 'Tinted', text: 'Soft colour; calm with many labels.' },
    { value: LabelStyle.COVER, name: 'Cover bar', text: 'Tinted, plus a colour bar on each card.' },
  ];

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

  /** Labels shown in the style previews: the first three, or samples. */
  protected readonly sampleLabels = computed(() => {
    const own = this.labels()
      .slice(0, 3)
      .map((l) => ({ name: l.name, hex: l.colour }));
    return own.length > 0
      ? own
      : [
          { name: 'frontend', hex: '#8E4EC6' },
          { name: 'customer', hex: '#F76B15' },
        ];
  });

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
   * Saves the project's label style (PMs only; the API checks again).
   *
   * @param labelStyle The new style.
   * @returns Resolves once saved.
   */
  protected async setLabelStyle(labelStyle: LabelStyle): Promise<void> {
    if (labelStyle === this.project().settings.labelStyle) return;
    await this.run(async () => {
      const project = await this.projectsApi.update(this.project().id, {
        settings: { labelStyle },
      });
      this.projectChange.emit(project);
    });
  }

  /**
   * Adds a label in the chosen colour.
   *
   * @param name The name field.
   * @returns Resolves once created.
   */
  protected async createLabel(name: HTMLInputElement): Promise<void> {
    const text = name.value.trim();
    if (text === '') return;
    await this.run(async () => {
      const label = await this.api.createLabel(this.project().id, {
        name: text,
        colour: this.newColour(),
      });
      this.labels.update((list) => [...list, label]);
      name.value = '';
      this.newName.set('');
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
    const confirmed = await this.dialogs.confirm({
      title: `Delete the label ${label.name}?`,
      message: 'It is removed from every item. This cannot be undone.',
      confirm: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
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
