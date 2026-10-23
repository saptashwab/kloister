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
  review(): string;
  show(field: string, value: unknown): string;
  confirmAllNew(): void;
  incomingRows: { set(value: unknown[]): void };
  setReview(mode: 'quick' | 'detailed'): void;
}

async function render(
  permissions: ('EXPORT_ADO' | 'IMPORT_ADO')[] = ['EXPORT_ADO', 'IMPORT_ADO'],
  destination: AdoDestinationDto | null = null,
) {
  const project = signal(makeProject({ myPermissions: permissions }));
  const api = {
    profile: vi.fn().mockResolvedValue(destination),
    sample: vi.fn(),
    reviewPolicy: vi.fn(),
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
    itemsById: signal(new Map([['i1', { key: 'KLO-7', title: 'Parent' }]])),
    membersById: signal(new Map([['u1', { displayName: 'Mia Member' }]])),
    labelsById: signal(new Map([['l1', { name: 'frontend' }]])),
    sprintsById: signal(new Map()),
    bucketsById: signal(new Map()),
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
    expect(text).toContain('Export to ADO');
    expect(text).not.toContain('Import from ADO');
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
    expect(field?.textContent).toContain('Choose Title for Remote starting example');
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
  it('shows names and statuses instead of identifiers', async () => {
    const { page } = await render();
    expect(page.show('status', 'IN_PROGRESS')).toBe('In progress');
    expect(page.show('assigneeIds', ['u1'])).toBe('Mia Member');
    expect(page.show('labelIds', ['l1', 'label:new-tag'])).toBe('frontend, new-tag (new)');
    expect(page.show('parentId', 'i1')).toBe('KLO-7 Parent');
    expect(page.show('description', '<p>Hello <b>there</b></p>')).toBe('Hello there');
    expect(page.show('sprintId', null)).toBe('—');
  });
  it('uses Quick review by default and Detailed when a PM requires it', async () => {
    const quick = await render();
    expect(quick.page.review()).toBe('quick');
    quick.page.setReview('detailed');
    expect(quick.page.inbound.review).toBe('detailed');
    expect(quick.page.outbound.review).toBe('detailed');
    TestBed.resetTestingModule();
    const required = await render(['EXPORT_ADO', 'IMPORT_ADO'], {
      id: 'd',
      organization: 'collection',
      remoteProject: 'remote',
      profile: {
        process: 'Agile',
        reverseTypes: {},
        incomingStates: {},
        incomingIdentities: {},
        tags: {},
        iterations: {},
      },
      revision: 1,
      requireDetailedReview: true,
    } as unknown as AdoDestinationDto);
    expect(required.page.review()).toBe('detailed');
    const toggle = (required.fixture.nativeElement as HTMLElement).querySelector(
      'mat-button-toggle-group',
    );
    expect(toggle?.textContent).toContain('Quick review');
    expect((required.fixture.nativeElement as HTMLElement).textContent).toContain(
      'A project PM requires Detailed review',
    );
  });
  it('fills suggested mappings from a sample export without saving them', async () => {
    const { page, api, fixture } = await render();
    const ctx = TestBed.inject(ProjectContext) as unknown as {
      buckets: { set(v: unknown[]): void };
      labels: { set(v: unknown[]): void };
      sprints: { set(v: unknown[]): void };
    };
    ctx.buckets.set([{ id: 'b-active', name: 'Active' }]);
    ctx.labels.set([{ id: 'l-front', name: 'Frontend' }]);
    ctx.sprints.set([{ id: 's1', name: 'Sprint 1', adoIterationPath: null }]);
    api.sample.mockResolvedValue({
      headers: [],
      process: 'Scrum',
      types: ['Product Backlog Item', 'Task'],
      states: [
        { type: 'Product Backlog Item', state: 'Approved' },
        { type: 'Task', state: 'Active' },
      ],
      tags: ['frontend', 'unmapped'],
      iterations: ['Remote\\Sprint 1'],
      identities: [],
      dateHeaders: ['Target Date'],
      dateOrder: 'DMY',
      rows: 2,
    });
    const file = {
      name: 'sample.csv',
      size: 3,
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode('a,b').buffer),
    };
    const internals = page as unknown as {
      sample(event: Event): Promise<void>;
      profile: { process: string; dateOrder?: string; fields: Record<string, string> };
      reverse: { remote: string; local: string }[];
      states: { type: string; state: string; status: string; bucketId: string }[];
      tags: { tag: string; labelId: string }[];
      iterations: { path: string; sprintId: string }[];
    };
    await internals.sample({ target: { files: [file], value: 'x' } } as unknown as Event);
    await settle(fixture);
    expect(api.configure).not.toHaveBeenCalled();
    expect(internals.profile.process).toBe('Scrum');
    expect(internals.profile.dateOrder).toBe('DMY');
    expect(internals.profile.fields['dueDate']).toBe('Target Date');
    expect(internals.reverse).toEqual([
      { remote: 'Product Backlog Item', local: 'STORY' },
      { remote: 'Task', local: 'TASK' },
    ]);
    expect(internals.states).toEqual([
      { type: 'Product Backlog Item', state: 'Approved', status: 'NOT_STARTED', bucketId: '' },
      { type: 'Task', state: 'Active', status: 'NOT_STARTED', bucketId: 'b-active' },
    ]);
    expect(internals.tags).toEqual([
      { tag: 'frontend', labelId: 'l-front' },
      { tag: 'unmapped', labelId: '' },
    ]);
    expect(internals.iterations).toEqual([{ path: 'Remote\\Sprint 1', sprintId: 's1' }]);
  });
  it('confirms every unmatched uploaded row as new in one step', async () => {
    const { page } = await render();
    page.incomingRows.set([
      { index: 0, itemId: null, remoteId: '21' },
      { index: 1, itemId: 'linked', remoteId: '22' },
      { index: 2, itemId: null, remoteId: '23' },
    ]);
    page.confirmAllNew();
    expect(page.inbound.confirmedNew).toEqual(['21', '23']);
  });
});
