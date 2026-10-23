import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AdoDestinationDto,
  AdoDestinationInput,
  AdoExportRequest,
  AdoImportRequest,
  AdoPreview,
  AdoSampleResult,
  Page,
} from '@kloister/shared';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from './api';

/** Lazy transfer client; every capability is independently enforced by the API. */
@Injectable({ providedIn: 'root' })
export class AdoApiService {
  private readonly http = inject(HttpClient);
  /**
   * Reads sanitized export settings, also available to project Leads.
   * @param project Project identity.
   * @returns Reviewed destination or null.
   */
  profile(project: string): Promise<AdoDestinationDto | null> {
    return firstValueFrom(this.http.get<AdoDestinationDto | null>(this.url(project, 'profile')));
  }
  /**
   * Replaces PM-reviewed configuration.
   * @param project Project identity.
   * @param value Revision and mappings.
   * @returns Saved destination.
   */
  configure(project: string, value: AdoDestinationInput): Promise<AdoDestinationDto> {
    return firstValueFrom(
      this.http.put<AdoDestinationDto>(this.url(project, 'destination'), value),
    );
  }
  /**
   * Makes Detailed review mandatory or optional for the project, PM only.
   * @param project Project identity.
   * @param requireDetailedReview New policy.
   * @returns Saved destination.
   */
  reviewPolicy(project: string, requireDetailedReview: boolean): Promise<AdoDestinationDto> {
    return firstValueFrom(
      this.http.put<AdoDestinationDto>(this.url(project, 'review-policy'), {
        requireDetailedReview,
      }),
    );
  }
  /**
   * Reads a sample ADO export to suggest mappings, PM only; nothing is stored.
   * @param project Project identity.
   * @param csv Exported CSV text.
   * @returns Distinct values found in the file.
   */
  sample(project: string, csv: string): Promise<AdoSampleResult> {
    return firstValueFrom(this.http.post<AdoSampleResult>(this.url(project, 'sample'), { csv }));
  }
  /**
   * Previews outbound content without reserving creates.
   * @param project Project identity.
   * @param value Selection and outbound choices.
   * @returns Explicit rows, losses and blockers.
   */
  exportPreview(project: string, value: AdoExportRequest): Promise<AdoPreview> {
    return firstValueFrom(this.http.post<AdoPreview>(this.url(project, 'export/preview'), value));
  }
  /**
   * Reserves reviewed files for recovery.
   * @param project Project identity.
   * @param value Exact preview and retry identity.
   * @returns Recoverable batch.
   */
  prepare(project: string, value: AdoExportRequest): Promise<AdoPreview> {
    return firstValueFrom(this.http.post<AdoPreview>(this.url(project, 'export/prepare'), value));
  }
  /**
   * Uploads incoming review instructions, PM only.
   * @param project Project identity.
   * @param value Exact file and selections.
   * @returns Persisted preview.
   */
  importPreview(project: string, value: AdoImportRequest): Promise<AdoPreview> {
    return firstValueFrom(this.http.post<AdoPreview>(this.url(project, 'import/preview'), value));
  }
  /**
   * Applies an already reviewed preview, PM only.
   * @param project Project identity.
   * @param preview Exact persisted review.
   * @returns Idempotent receipt.
   */
  apply(project: string, preview: AdoPreview): Promise<AdoPreview> {
    return firstValueFrom(
      this.http.post<AdoPreview>(this.url(project, `batches/${preview.batchId}/apply`), {
        digest: preview.digest,
      }),
    );
  }
  /**
   * Downloads exact reserved bytes; never confirms remote import.
   * @param project Project identity.
   * @param batch Batch identity.
   * @returns ZIP file blob.
   */
  download(project: string, batch: string): Promise<Blob> {
    return firstValueFrom(
      this.http.get(this.url(project, `batches/${batch}/download`), { responseType: 'blob' }),
    );
  }
  /**
   * Reads a page of PM-only workflow history.
   * @param project Project identity.
   * @param cursor Optional next page.
   * @returns Batches without contents.
   */
  history(
    project: string,
    cursor?: string,
  ): Promise<
    Page<{ id: string; mode: string; review?: string; state: string; createdAt: string }>
  > {
    return firstValueFrom(
      this.http.get<
        Page<{ id: string; mode: string; review?: string; state: string; createdAt: string }>
      >(this.url(project, 'batches'), {
        params: cursor ? new HttpParams().set('cursor', cursor) : new HttpParams(),
      }),
    );
  }
  /**
   * Recovers a review/receipt, PM only.
   * @param project Project identity.
   * @param batch Batch identity.
   * @returns Review or compact receipt.
   */
  recover(project: string, batch: string): Promise<AdoPreview> {
    return firstValueFrom(this.http.get<AdoPreview>(this.url(project, `batches/${batch}`)));
  }
  /**
   * Explicitly cancels pending creates with a duplicate-risk acknowledgement, PM only.
   * @param project Project identity.
   * @param batch Pending identity.
   * @returns Cancelled receipt.
   */
  cancel(project: string, batch: string): Promise<AdoPreview> {
    return firstValueFrom(
      this.http.post<AdoPreview>(this.url(project, `batches/${batch}/cancel`), {
        duplicateRiskAcknowledged: true,
      }),
    );
  }
  private url(project: string, path: string): string {
    return apiUrl(`projects/${project}/ado/${path}`);
  }
}
