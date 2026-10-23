import { Component, computed, inject, type OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { type DiskUsageDto, type FolderUsageDto, STORAGE_LIMITS } from '@kloister/shared';
import { formatSize } from '../../core/format';
import { SettingsApiService } from '../../core/settings-api.service';
import { wholeNumber } from '../../core/validators';
import { Skeleton } from '../../ui/feedback';
import { Icon } from '../../ui/icon';
import { ToastService } from '../../ui/toast.service';
import { AppDatePipe } from '../../ui/app-date.pipe';

/** One row of the disk usage list. */
interface UsageRow {
  /** What the folder holds. */
  name: string;
  /** The folder. */
  folder: FolderUsageDto;
  /** Share of the app folder, 0 to 100. */
  percent: number;
}

/**
 * Admin storage settings (SPEC §5, §6): the largest attachment and the
 * space each project may use, and the disk usage of the app's folder with
 * its attachments, backups and logs, plus the disk's free space.
 *
 * Permissions: admin route; the API refuses everyone else.
 */
@Component({
  selector: 'app-admin-storage',
  host: { class: 'k-tab' },
  imports: [
    AppDatePipe,
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    Icon,
    Skeleton,
  ],
  template: `
    <form class="k-panel" [formGroup]="form" (ngSubmit)="save()" aria-labelledby="limits-title">
      <h2 id="limits-title">Attachment limits</h2>
      <p class="lead">
        Images pasted into descriptions and notes count too. New limits apply to the next upload;
        files already stored are kept.
      </p>
      <div class="k-fields">
        <mat-form-field>
          <mat-label>Largest file (MB)</mat-label>
          <input matInput type="number" formControlName="maxFileSizeMb" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>Space per project (MB)</mat-label>
          <input matInput type="number" formControlName="projectQuotaMb" />
          <mat-hint>{{ quotaHint() }}</mat-hint>
        </mat-form-field>
        <mat-form-field
          ><mat-label>Personal space per user (MB)</mat-label
          ><input matInput type="number" formControlName="personalQuotaMb" /><mat-hint
            >Separate from project storage</mat-hint
          ></mat-form-field
        >
      </div>
      <div class="k-actions">
        <button mat-flat-button type="submit" [disabled]="form.invalid || busy()">
          Save limits
        </button>
      </div>
    </form>

    <section class="k-panel" aria-labelledby="usage-title">
      <h2 id="usage-title">Disk usage</h2>
      @if (usage(); as usage) {
        <p class="lead">Measured {{ usage.measuredAt | appDate }}.</p>
        @if (usage.disk; as disk) {
          <ul class="k-usage" aria-label="Disk">
            <li>
              <span class="name">Disk</span>
              <span class="size"
                >{{ size(disk.totalBytes - disk.freeBytes) }} used · {{ size(disk.freeBytes) }} free
                of {{ size(disk.totalBytes) }}</span
              >
              <span class="bar" aria-hidden="true"
                ><span [style.width.%]="usedPercent(disk)"></span
              ></span>
            </li>
          </ul>
        }
        <ul class="k-usage" aria-label="Folders">
          @for (row of rows(); track row.name) {
            <li>
              <span class="name">{{ row.name }}</span>
              <span class="size">{{ size(row.folder.bytes) }} in {{ row.folder.files }} files</span>
              <span class="bar" aria-hidden="true"
                ><span [style.width.%]="row.percent"></span
              ></span>
              <span class="path">{{ row.folder.path }}</span>
            </li>
          }
        </ul>
      } @else {
        <app-skeleton label="Measuring the disk usage" [rows]="4" />
      }
      <div class="k-actions">
        <button mat-button type="button" [disabled]="measuring()" (click)="measure()">
          <app-icon name="sprints" />Measure again
        </button>
      </div>
    </section>
  `,
})
export class AdminStoragePage implements OnInit {
  private readonly api = inject(SettingsApiService);
  private readonly toast = inject(ToastService);

  /** The last measurement. */
  protected readonly usage = signal<DiskUsageDto | null>(null);
  /** True while measuring. */
  protected readonly measuring = signal(false);
  /** True while saving. */
  protected readonly busy = signal(false);

  /** The limits form, with the API's ranges. */
  protected readonly form = inject(NonNullableFormBuilder).group({
    maxFileSizeMb: [25, wholeNumber(STORAGE_LIMITS.maxFileSizeMb)],
    projectQuotaMb: [2048, wholeNumber(STORAGE_LIMITS.projectQuotaMb)],
    personalQuotaMb: [1024, wholeNumber(STORAGE_LIMITS.personalQuotaMb)],
  });

  /** The folders, each as a share of the app folder. */
  protected readonly rows = computed<UsageRow[]>(() => {
    const usage = this.usage();
    if (usage === null) return [];
    const total = Math.max(usage.app.bytes, 1);
    const row = (name: string, folder: FolderUsageDto): UsageRow => ({
      name,
      folder,
      percent: Math.min(100, (folder.bytes / total) * 100),
    });
    return [
      row('App folder', usage.app),
      row('Attachments', usage.attachments),
      row('Backups', usage.backups),
      row('Logs', usage.logs),
    ];
  });

  /** Formats a size. */
  protected readonly size = formatSize;

  /**
   * Loads the limits and measures the disk usage.
   */
  ngOnInit(): void {
    void this.load();
    void this.measure();
  }

  /**
   * The quota in words.
   *
   * @returns E.g. "2.0 GB per project".
   */
  protected quotaHint(): string {
    const mb = Number(this.form.controls.projectQuotaMb.value);
    return Number.isFinite(mb) && mb > 0 ? `${formatSize(mb * 1024 * 1024)} per project` : '';
  }

  /**
   * The used share of the disk.
   *
   * @param disk The disk's size and free space.
   * @param disk.totalBytes Its size.
   * @param disk.freeBytes Its free space.
   * @returns 0 to 100.
   */
  protected usedPercent(disk: { totalBytes: number; freeBytes: number }): number {
    return disk.totalBytes > 0 ? ((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100 : 0;
  }

  /**
   * Measures the disk usage again.
   *
   * @returns Resolves once measured.
   */
  protected async measure(): Promise<void> {
    this.measuring.set(true);
    try {
      this.usage.set(await this.api.diskUsage());
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.measuring.set(false);
    }
  }

  /**
   * Saves the limits.
   *
   * @returns Resolves once saved.
   */
  protected async save(): Promise<void> {
    if (this.form.invalid) return;
    const v = this.form.getRawValue();
    this.busy.set(true);
    try {
      this.form.setValue(
        await this.api.saveStorage({
          maxFileSizeMb: Number(v.maxFileSizeMb),
          projectQuotaMb: Number(v.projectQuotaMb),
          personalQuotaMb: Number(v.personalQuotaMb),
        }),
      );
      this.toast.show('Attachment limits saved');
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Loads the stored limits.
   *
   * @returns Resolves once loaded.
   */
  private async load(): Promise<void> {
    try {
      this.form.setValue(await this.api.storage());
    } catch (error) {
      this.toast.error(error);
    }
  }
}
