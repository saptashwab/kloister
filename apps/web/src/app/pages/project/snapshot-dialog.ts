import { HttpClient, HttpParams } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import type { SnapshotPreviewDto } from '@kloister/shared';
import { firstValueFrom } from 'rxjs';
import { apiUrl, errorMessage } from '../../core/api';

/** Explicit source/filter/count preview for a readable workbook or offline ZIP. */
@Component({
  selector: 'app-snapshot-dialog',
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatCheckboxModule,
    MatSelectModule,
    MatFormFieldModule,
  ],
  styles: `
    mat-dialog-content {
      display: grid;
      gap: var(--k-space-3);
      overflow-wrap: anywhere;
    }
  `,
  template: `<h2 mat-dialog-title>Export snapshot</h2>
    <mat-dialog-content>
      <mat-form-field
        ><mat-label>Scope</mat-label
        ><mat-select [disabled]="busy()" [value]="scope()" (valueChange)="changeScope($event)"
          ><mat-option value="filtered">Current filtered view</mat-option
          ><mat-option value="all">{{
            data.source === 'me' ? 'All my work' : 'All visible project items'
          }}</mat-option></mat-select
        ></mat-form-field
      >
      <mat-checkbox [disabled]="busy()" [checked]="offline()" (change)="offline.set($event.checked)"
        >Include files for offline use (ZIP)</mat-checkbox
      >
      @if (preview(); as p) {
        <h3>{{ p.mode }} · {{ p.count }} items</h3>
        <p>{{ p.scope }}</p>
        <p>Filters: {{ p.filters }}</p>
        <p>{{ p.details }}</p>
      }
      <p>
        Every matching page is included. My work retains its assigned/created, source, Done and
        unarchived-project rules. Hidden ancestors remain titles only.
      </p>
      <p>Snapshots support offline reading. Recovery still requires database and file backups.</p>
      @if (data.msProject) {
        <section class="msp" aria-labelledby="msp-title">
          <h3 id="msp-title">Microsoft Project</h3>
          <p>
            The plan as a Microsoft Project file (.xml): every timeline row you can see, with dates,
            half days, links, assignees with their shares, progress and holidays. Open it in Project
            with File › Open. Filters do not apply.
          </p>
          <button mat-stroked-button type="button" [disabled]="busy()" (click)="downloadProject()">
            Download Microsoft Project file
          </button>
        </section>
      }
      @if (error()) {
        <p class="k-alert" role="alert">{{ error() }}</p>
      }
      @if (saved()) {
        <p role="status">{{ saved() }}</p>
      }</mat-dialog-content
    ><mat-dialog-actions align="end"
      ><button mat-button mat-dialog-close [disabled]="busy()">Close</button
      ><button mat-flat-button [disabled]="busy() || !preview()" (click)="download()">
        Download {{ offline() ? 'offline ZIP' : 'Excel workbook' }}
      </button></mat-dialog-actions
    >`,
})
export class SnapshotDialog {
  /** Original screen scope and filters. */
  protected readonly data = inject<{
    source: string;
    filters: Record<string, string | boolean>;
    msProject?: boolean;
  }>(MAT_DIALOG_DATA);
  private readonly http = inject(HttpClient);
  private readonly path =
    this.data.source === 'me' ? 'me/snapshots' : `projects/${this.data.source}/snapshots`;
  /** Explicit filtered/all-eligible choice. */
  protected readonly scope = signal('filtered');
  /** File inclusion is opt-in. */
  protected readonly offline = signal(false);
  /** Server-authoritative scope preview. */
  protected readonly preview = signal<SnapshotPreviewDto | null>(null);
  /** Request in progress. */
  protected readonly busy = signal(false);
  /** Honest download result, or empty. */
  protected readonly saved = signal('');
  /** Error requiring correction/retry. */
  protected readonly error = signal('');
  private run = 0;
  /** Starts the initial server scope preview. */
  constructor() {
    void this.changeScope('filtered');
  }
  /**
   * Recomputes preview when the scope changes and ignores stale answers.
   * @param scope Chosen source-relative scope.
   * @returns Resolves after the preview response.
   */
  protected async changeScope(scope: string): Promise<void> {
    const run = ++this.run;
    this.scope.set(scope);
    this.preview.set(null);
    this.error.set('');
    this.saved.set('');
    try {
      const preview = await firstValueFrom(
        this.http.get<SnapshotPreviewDto>(apiUrl(`${this.path}/preview`), {
          params: this.params(),
        }),
      );
      if (run === this.run) this.preview.set(preview);
    } catch (error) {
      if (run === this.run) this.error.set(errorMessage(error));
    }
  }
  /**
   * Serializes current filters without page cursors or client-provided readable IDs.
   * @returns Validated server query parameters.
   */
  private params(): HttpParams {
    return new HttpParams({
      fromObject: { ...this.data.filters, scope: this.scope(), offline: this.offline() },
    });
  }
  /**
   * Downloads complete server-generated bytes after a fresh scope check.
   * @returns Resolves when saved or the failure is displayed.
   */
  protected async download(): Promise<void> {
    const offline = this.offline();
    this.busy.set(true);
    this.error.set('');
    try {
      const blob = await firstValueFrom(
        this.http.get(apiUrl(this.path), { params: this.params(), responseType: 'blob' }),
      );
      save(blob, `snapshot.${offline ? 'zip' : 'xlsx'}`);
      this.saved.set('Snapshot downloaded. Scope was checked again when creating it.');
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Downloads the plan as a Microsoft Project file (v1.3.2), built by the
   * server from what the caller can see.
   * @returns Resolves when saved or the failure is displayed.
   */
  protected async downloadProject(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    this.saved.set('');
    try {
      const res = await firstValueFrom(
        this.http.get(apiUrl(`projects/${this.data.source}/timeline/msproject`), {
          responseType: 'blob',
          observe: 'response',
        }),
      );
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1];
      save(res.body!, name ?? 'plan.xml');
      this.saved.set('Microsoft Project file downloaded.');
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}

/**
 * Saves downloaded bytes as a file.
 * @param blob The bytes.
 * @param name File name.
 */
function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
