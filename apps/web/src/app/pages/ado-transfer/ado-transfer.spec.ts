import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type {
  AdoDestinationDto,
  AdoExportRequest,
  AdoImportRequest,
  AdoPreview,
} from '@kloister/shared';
import { makeProject, settle } from '../../../testing/fixtures';
import { AdoApiService } from '../../core/ado-api.service';
import { ProjectContext } from '../../core/project-context';
import { ToastService } from '../../ui/toast.service';
import { Dialogs } from '../../ui/dialogs';
import { AdoTransferPage } from './ado-transfer';

interface Internals {
  inbound: AdoImportRequest;
  outbound: AdoExportRequest;
  preview: { (): AdoPreview | null; set(value: AdoPreview | null): void };
  destination(): AdoDestinationDto | null;
  changed(): void;
  dirty(): boolean;
  exportPreview(): Promise<void>;
  file(event: Event): Promise<void>;
  filename: string;
}

async function render(permissions: ('EXPORT_ADO' | 'IMPORT_ADO')[] = ['EXPORT_ADO', 'IMPORT_ADO']) {
  const project = signal(makeProject({ myPermissions: permissions }));
  const api = {
    profile: vi.fn().mockResolvedValue(null),
    exportPreview: vi.fn(),
    configure: vi.fn(),
    history: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  };
  const ctx = {
    project,
    has: (p: 'EXPORT_ADO' | 'IMPORT_ADO') => project().myPermissions.includes(p),
    writable: () => !project().archivedAt,
    refresh: vi.fn().mockResolvedValue(undefined),
    items: signal([]),
    labels: signal([]),
    buckets: signal([]),
    sprints: signal([]),
    members: signal([]),
  };
  await TestBed.configureTestingModule({
    imports: [AdoTransferPage],
    providers: [
      provideRouter([]),
      { provide: ProjectContext, useValue: ctx },
      { provide: AdoApiService, useValue: api },
      { provide: ToastService, useValue: { show: vi.fn() } },
      { provide: Dialogs, useValue: { confirm: vi.fn() } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(AdoTransferPage);
  await settle(fixture);
  return { fixture, page: fixture.componentInstance as unknown as Internals, project, api };
}

describe('lazy transfer review lifecycle', () => {
  it('keeps Viewer snapshots separate and never loads transfer metadata without permission', async () => {
    const { fixture, api } = await render([]);
    expect(api.profile).not.toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'requires project PM or project Lead',
    );
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Export…');
  });
  it('offers project Leads export only and directs initial setup to a PM', async () => {
    const { fixture } = await render(['EXPORT_ADO']);
    const text = (fixture.nativeElement as HTMLElement).textContent;
    expect(text).toContain('Export CSV');
    expect(text).not.toContain('Import / reconcile CSV');
    expect(text).toContain('project PM must configure');
  });
  it('clears every file-bound approval before reading another CSV, including on UTF-8 decode failure', async () => {
    const { page } = await render();
    page.inbound.confirmedNew = ['21'];
    page.inbound.choices = { '21': { title: 'incoming' } };
    page.inbound.manualLinks = { '21': 'old' };
    page.inbound.destinationAcknowledged = true;
    page.inbound.csv = 'old';
    const target = {
      files: [
        { name: 'bad.csv', size: 1, arrayBuffer: () => Promise.resolve(Uint8Array.of(255).buffer) },
      ],
      value: 'file',
    };
    await page.file({ target } as unknown as Event);
    expect(page.inbound.csv).toBe('');
    expect(page.inbound.confirmedNew).toEqual([]);
    expect(page.inbound.manualLinks).toEqual({});
    expect(page.inbound.choices).toEqual({});
    expect(page.inbound.destinationAcknowledged).toBe(false);
    expect(page.filename).toBe('');
  });
  it('invalidates actionable reviews when choices change without hiding field comparisons', async () => {
    const { page } = await render();
    const preview = { digest: 'review' } as AdoPreview;
    page.preview.set(preview);
    const key = page.inbound.idempotencyKey;
    page.changed();
    expect(page.preview()).toBe(preview);
    expect(page.dirty()).toBe(true);
    expect(page.inbound.idempotencyKey).not.toBe(key);
  });
  it('floats the long conflict label before an empty resolution is focused', async () => {
    const { page, fixture } = await render();
    page.preview.set({
      batchId: null,
      digest: 'review',
      destination: {
        organization: 'collection',
        remoteProject: 'remote',
        profile: { process: 'Agile' },
        revision: 1,
      } as AdoDestinationDto,
      rows: [
        {
          index: 0,
          itemId: 'local-item',
          remoteId: '72001',
          title: 'Remote starting example',
          kind: 'update',
          selected: true,
          differences: [
            {
              field: 'title',
              local: 'Local title',
              incoming: 'Remote starting example',
              baselineLocal: null,
              baselineRemote: null,
              conflict: true,
            },
          ],
          warnings: [],
        },
      ],
      files: [],
      warnings: [],
      errors: [],
      state: 'PREVIEW',
    });
    await settle(fixture);
    const field = (fixture.nativeElement as HTMLElement).querySelector(
      '.ado-difference mat-form-field',
    );
    expect(field?.querySelector('mat-select')?.classList.contains('mat-mdc-select-empty')).toBe(
      true,
    );
    expect(field?.querySelector('mat-select')?.getAttribute('aria-expanded')).toBe('false');
    expect(
      field?.querySelector('label')?.classList.contains('mdc-floating-label--float-above'),
    ).toBe(true);
    expect(field?.textContent).toContain('Choose title for Remote starting example');
  });
  it('discards a delayed old-project preview and clears approvals on project navigation', async () => {
    const { page, api, fixture, project } = await render();
    let resolve!: (p: AdoPreview) => void;
    api.exportPreview.mockReturnValue(
      new Promise<AdoPreview>((r) => {
        resolve = r;
      }),
    );
    page.inbound.confirmedNew = ['21'];
    const pending = page.exportPreview();
    project.set(
      makeProject({ id: 'p2', key: 'NEXT', myPermissions: ['EXPORT_ADO', 'IMPORT_ADO'] }),
    );
    await settle(fixture);
    resolve({ digest: 'old-project' } as AdoPreview);
    await pending;
    expect(page.preview()).toBeNull();
    expect(page.inbound.confirmedNew).toEqual([]);
  });
});
