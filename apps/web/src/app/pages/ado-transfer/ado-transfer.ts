import { Component, computed, effect, inject, signal } from '@angular/core';
import { JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import {
  type AdoChoice,
  type AdoDestinationDto,
  type AdoExportRequest,
  type AdoField,
  type AdoImportRequest,
  type AdoPreview,
  type AdoPreviewRow,
  type AdoProcess,
  type AdoProfile,
  type ItemType,
  ItemType as Types,
  ItemStatus,
  ProjectPermission,
} from '@kloister/shared';
import { AdoApiService } from '../../core/ado-api.service';
import { errorMessage } from '../../core/api';
import { ProjectContext } from '../../core/project-context';
import { Dialogs } from '../../ui/dialogs';
import { ToastService } from '../../ui/toast.service';

/** Separate lazy offline transfer workflow; snapshots retain their existing Export control. */
@Component({
  selector: 'app-ado-transfer',
  imports: [
    FormsModule,
    RouterLink,
    JsonPipe,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  styleUrl: './ado-transfer.scss',
  templateUrl: './ado-transfer.html',
})
export class AdoTransferPage {
  /** Shared authorized project data. */
  protected readonly ctx = inject(ProjectContext);
  private readonly api = inject(AdoApiService);
  private readonly toast = inject(ToastService);
  private readonly dialogs = inject(Dialogs);
  private readonly route = inject(ActivatedRoute);
  /** Current capability; system administration is deliberately irrelevant. */
  protected readonly canExport = computed(
    () => this.ctx.has(ProjectPermission.EXPORT_ADO) && this.ctx.project()?.ownerId === null,
  );
  /** PM-only incoming/settings controls. */
  protected readonly canImport = computed(
    () => this.ctx.has(ProjectPermission.IMPORT_ADO) && this.ctx.project()?.ownerId === null,
  );
  /** Changed decisions require a fresh server preview before applying. */
  protected readonly dirty = signal(false);
  /** Visible workflow. */
  protected readonly tab = signal<'export' | 'import' | 'settings' | 'recovery'>('export');
  /** Last server preview, invalidated on every review change. */
  protected readonly preview = signal<AdoPreview | null>(null);
  /** Retains row choices while incoming previews narrow selection. */
  protected readonly incomingRows = signal<AdoPreviewRow[]>([]);
  /** Saved destination, used separately from editable settings. */
  protected readonly destination = signal<AdoDestinationDto | null>(null);
  /** Serialized actions disable repeated clicks. */
  protected readonly busy = signal(false);
  /** Inline failure, also announced. */
  protected readonly error = signal('');
  /** Config draft fields. */
  protected organization = '';
  /** Remote project identity. */
  protected remoteProject = '';
  /** Editable reviewed profile. */
  protected profile = initialProfile('Agile');
  /** Available process choices. */
  protected readonly processes: AdoProcess[] = ['Basic', 'Agile', 'Scrum', 'CMMI', 'Custom'];
  /** Local type choices. */
  protected readonly types = Object.values(Types);
  /** Local status choices. */
  protected readonly statuses = Object.values(ItemStatus);
  /** Enabled optional field editor rows. */
  protected readonly fields = [
    'priority',
    'labelIds',
    'sprintId',
    'startDate',
    'dueDate',
    'area',
  ] as const;
  /** Outbound selection; all matching rows are read on the server. */
  protected outbound: AdoExportRequest = {
    selection: {
      scope: 'project',
      labelIds: [],
      labelMode: 'any',
      ancestors: true,
      excludeDone: false,
      notes: false,
    },
    assignees: {},
    choices: {},
    freshnessAcknowledged: false,
  };
  /** Incoming defaults are link-only so creation defaults never silently overwrite local intent. */
  protected inbound: AdoImportRequest = {
    csv: '',
    mode: 'reconcile',
    selectedRows: null,
    destinationAcknowledged: false,
    manualLinks: {},
    confirmedNew: [],
    omittedParents: [],
    choices: {},
    types: {},
    createLabels: [],
    idempotencyKey: crypto.randomUUID(),
  };
  /** Filename for operator confidence, never used as identity. */
  protected filename = '';
  /** Editable reverse map rows. */
  protected reverse: { remote: string; local: ItemType }[] = [];
  /** Reviewed incoming state/bucket rows. */
  protected states: { type: string; state: string; status: ItemStatus; bucketId: string }[] = [];
  /** Explicit incoming identity aliases. */
  protected identities: { alias: string; userId: string }[] = [];
  /** Explicit tag maps. Empty label means omit. */
  protected tags: { tag: string; labelId: string }[] = [];
  /** Explicit iteration maps. Empty sprint means no sprint. */
  protected iterations: { path: string; sprintId: string }[] = [];
  /** Recoverable workflow list. */
  protected history: { id: string; mode: string; state: string; createdAt: string }[] = [];
  /** Next history page. */
  protected nextCursor: string | null = null;
  private projectId = '';
  private epoch = 0;
  private contextKey = '';

  /** Loads only for the currently authorized project, ignoring delayed prior-project answers. */
  constructor() {
    effect(() => {
      const project = this.ctx.project();
      const key = `${project?.id ?? ''}:${this.canExport()}:${this.canImport()}`;
      if (key === this.contextKey) return;
      this.contextKey = key;
      this.epoch++;
      this.projectId = project?.id ?? '';
      this.preview.set(null);
      this.destination.set(null);
      this.incomingRows.set([]);
      this.inbound = {
        csv: '',
        mode: 'reconcile',
        selectedRows: null,
        destinationAcknowledged: false,
        manualLinks: {},
        confirmedNew: [],
        omittedParents: [],
        choices: {},
        types: {},
        createLabels: [],
        idempotencyKey: crypto.randomUUID(),
      };
      this.outbound = {
        selection: {
          scope: 'project',
          labelIds: [],
          labelMode: 'any',
          ancestors: true,
          excludeDone: false,
          notes: false,
        },
        assignees: {},
        choices: {},
        freshnessAcknowledged: false,
      };
      this.history = [];
      this.nextCursor = null;
      this.filename = '';
      this.organization = '';
      this.remoteProject = '';
      this.profile = initialProfile('Agile');
      this.reverse = [];
      this.states = [];
      this.identities = [];
      this.tags = [];
      this.iterations = [];
      if (!project || !this.canExport()) {
        this.busy.set(false);
        return;
      }
      this.busy.set(true);
      void (async () => {
        await this.ctx.refresh();
        const destination = await this.answer(this.api.profile(project.id));
        if (this.ctx.project()?.id !== project.id) return;
        this.destination.set(destination);
        if (destination) this.editDestination(destination);
        else if (this.canImport()) this.tab.set('settings');
        const selected = this.route.snapshot.queryParamMap.get('items');
        if (selected) {
          this.outbound.selection.scope = 'manual';
          this.outbound.selection.itemIds = selected.split(',');
        }
        const sprint = this.route.snapshot.queryParamMap.get('sprint');
        if (sprint && !selected) {
          this.outbound.selection.scope = 'sprint';
          this.outbound.selection.rootId = sprint;
        }
      })()
        .catch((error: unknown) => {
          if (!(error instanceof StaleTransfer) && this.contextKey === key)
            this.error.set(errorMessage(error));
        })
        .finally(() => {
          if (this.contextKey === key) this.busy.set(false);
        });
    });
  }

  /** Clears any stale actionable preview after a form change. */
  protected changed(): void {
    this.epoch++;
    this.dirty.set(true);
    this.inbound.idempotencyKey = crypto.randomUUID();
    delete this.outbound.idempotencyKey;
  }
  /**
   * Switches workflow and clears its previous review.
   * @param tab Next workflow.
   */
  protected switchTab(tab: 'export' | 'import' | 'settings' | 'recovery'): void {
    this.epoch++;
    this.tab.set(tab);
    this.preview.set(null);
    if (tab === 'recovery') void this.loadHistory();
  }
  /**
   * Loads a conservative preset that still requires review.
   * @param process Selected process.
   */
  protected preset(process: AdoProcess): void {
    this.profile = initialProfile(process);
    this.reverse = [];
    this.states = [];
    this.identities = [];
    this.tags = [];
    this.iterations = [];
    this.changed();
  }
  /** Saves reviewed mappings with existing project references only. */
  protected async save(): Promise<void> {
    await this.run(async () => {
      const profile = structuredClone(this.profile);
      profile.reverseTypes = Object.fromEntries(this.reverse.map((r) => [r.remote, r.local]));
      profile.incomingStates = Object.fromEntries(
        this.states.map((s) => [
          `${s.type}\n${s.state}`,
          { status: s.status, bucketId: s.bucketId },
        ]),
      );
      profile.incomingIdentities = Object.fromEntries(
        this.identities.map((i) => [i.alias, i.userId || null]),
      );
      profile.tags = Object.fromEntries(this.tags.map((t) => [t.tag, t.labelId || null]));
      profile.iterations = Object.fromEntries(
        this.iterations.map((i) => [i.path, i.sprintId || null]),
      );
      const destination = await this.answer(
        this.api.configure(this.projectId, {
          organization: this.organization,
          remoteProject: this.remoteProject,
          profile,
          revision: this.destination()?.revision ?? 0,
        }),
      );
      this.destination.set(destination);
      this.editDestination(destination);
      this.changed();
      this.toast.show('ADO settings saved. Existing observations need review again.');
    });
  }
  /** Requests a fresh outgoing preview across the complete selected scope. */
  protected async exportPreview(): Promise<void> {
    await this.run(async () => {
      this.preview.set(await this.answer(this.api.exportPreview(this.projectId, this.outbound)));
      this.dirty.set(false);
    });
  }
  /** Reserves the exact reviewed files and their pending identities. */
  protected async prepare(): Promise<void> {
    const preview = this.preview();
    if (!preview) return;
    this.outbound.previewDigest = preview.digest;
    this.outbound.idempotencyKey ??= crypto.randomUUID();
    await this.run(async () => {
      this.preview.set(await this.answer(this.api.prepare(this.projectId, this.outbound)));
    });
  }
  /**
   * Reads strict UTF-8 without replacement decoding; upload bytes are bounded before reading.
   * @param event File input change.
   */
  protected async file(event: Event): Promise<void> {
    if (this.busy()) return;
    const input = event.target as HTMLInputElement,
      file = input.files?.[0];
    if (!file) return;
    this.changed();
    this.incomingRows.set([]);
    this.preview.set(null);
    this.inbound = {
      csv: '',
      mode: this.inbound.mode,
      selectedRows: null,
      destinationAcknowledged: false,
      manualLinks: {},
      confirmedNew: [],
      omittedParents: [],
      choices: {},
      types: {},
      createLabels: [],
      idempotencyKey: crypto.randomUUID(),
    };
    this.filename = '';
    await this.run(async () => {
      if (file.size > 10 * 1024 * 1024)
        throw new Error('CSV exceeds 10 MiB. Split the query before uploading.');
      this.inbound.csv = new TextDecoder('utf-8', { fatal: true }).decode(
        await this.answer(file.arrayBuffer()),
      );
      this.filename = file.name;
    });
    input.value = '';
  }
  /** Previews incoming selected rows; changed choices get a new durable retry key. */
  protected async importPreview(): Promise<void> {
    await this.run(async () => {
      const preview = await this.answer(this.api.importPreview(this.projectId, this.inbound));
      this.preview.set(preview);
      this.dirty.set(false);
      const rows = new Map(this.incomingRows().map((r) => [r.index, r]));
      preview.rows.forEach((r) => rows.set(r.index, r));
      this.incomingRows.set([...rows.values()].sort((a, b) => a.index - b.index));
    });
  }
  /** Applies only the persisted reviewed batch and refreshes ordinary item state. */
  protected async apply(): Promise<void> {
    const preview = this.preview();
    if (!preview?.batchId || preview.errors.length) return;
    await this.run(async () => {
      this.preview.set(await this.answer(this.api.apply(this.projectId, preview)));
      await this.ctx.refresh();
      this.toast.show('Selected transfer rows applied.');
    });
  }
  /**
   * Changes a single explicit incoming/outgoing resolution, never local data.
   * @param row Reviewed row.
   * @param field Transfer field.
   * @param choice Local/incoming/skip resolution.
   */
  protected choose(row: AdoPreviewRow, field: AdoField, choice: AdoChoice): void {
    const target = this.tab() === 'export' ? this.outbound : this.inbound;
    const id = this.tab() === 'export' ? row.itemId! : row.remoteId!;
    target.choices[id] = { ...target.choices[id], [field]: choice };
    this.changed();
  }
  /**
   * Selects exact incoming row indices without implicitly importing a parent.
   * @param index Zero-based row index.
   * @param checked Whether selected.
   */
  protected selectRow(index: number, checked: boolean): void {
    const selected = new Set(this.inbound.selectedRows ?? this.incomingRows().map((r) => r.index));
    if (checked) selected.add(index);
    else selected.delete(index);
    this.inbound.selectedRows = [...selected];
    this.changed();
  }
  /**
   * Records an explicit confirmation or hierarchy-loss choice.
   * @param field Incoming set.
   * @param id Remote identity.
   * @param checked Whether confirmed.
   */
  protected confirm(field: 'confirmedNew' | 'omittedParents', id: string, checked: boolean): void {
    this.inbound[field] = checked
      ? [...new Set([...this.inbound[field], id])]
      : this.inbound[field].filter((i) => i !== id);
    this.changed();
  }
  /**
   * Downloads reserved outbound content and releases the browser object URL.
   * @param batch Optional known recovery identity.
   */
  protected async download(batch = this.preview()?.batchId): Promise<void> {
    if (!batch) return;
    await this.run(async () => {
      const blob = await this.answer(this.api.download(this.projectId, batch));
      const url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = `ado-${batch}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  /**
   * Loads the next PM-only history page.
   * @param more Append instead of replacing.
   */
  protected async loadHistory(more = false): Promise<void> {
    await this.run(async () => {
      const page = await this.answer(
        this.api.history(this.projectId, more ? (this.nextCursor ?? undefined) : undefined),
      );
      this.history = more ? [...this.history, ...page.items] : page.items;
      this.nextCursor = page.nextCursor;
    });
  }
  /**
   * Recovers a persisted PM review.
   * @param batch Scoped batch identity.
   */
  protected async recover(batch: string): Promise<void> {
    await this.run(async () => {
      this.preview.set(await this.answer(this.api.recover(this.projectId, batch)));
      this.dirty.set(false);
    });
  }
  /**
   * Explicitly cancels pending identities after explaining duplicate risk.
   * @param batch Scoped batch identity.
   */
  protected async cancel(batch: string): Promise<void> {
    if (
      !(await this.dialogs.confirm({
        title: 'Cancel pending creates?',
        message:
          'This cannot undo anything imported in ADO. Issuing another create file can create remote duplicates. Reconcile returned IDs whenever possible.',
        confirm: 'Cancel pending creates',
        danger: true,
      }))
    )
      return;
    await this.run(async () => {
      this.preview.set(await this.answer(this.api.cancel(this.projectId, batch)));
    });
  }

  private editDestination(d: AdoDestinationDto): void {
    this.organization = d.organization;
    this.remoteProject = d.remoteProject;
    this.profile = structuredClone(d.profile);
    this.reverse = Object.entries(d.profile.reverseTypes).map(([remote, local]) => ({
      remote,
      local,
    }));
    this.states = Object.entries(d.profile.incomingStates).map(([key, value]) => ({
      type: key.split('\n')[0],
      state: key.split('\n')[1] ?? '',
      ...value,
    }));
    this.identities = Object.entries(d.profile.incomingIdentities).map(([alias, userId]) => ({
      alias,
      userId: userId ?? '',
    }));
    this.tags = Object.entries(d.profile.tags).map(([tag, labelId]) => ({
      tag,
      labelId: labelId ?? '',
    }));
    this.iterations = Object.entries(d.profile.iterations).map(([path, sprintId]) => ({
      path,
      sprintId: sprintId ?? '',
    }));
  }
  private async run(work: () => Promise<void>): Promise<void> {
    const project = this.projectId;
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await work();
    } catch (e) {
      if (e instanceof StaleTransfer || project !== this.projectId) return;
      this.error.set(
        e instanceof Error && !(e as { status?: unknown }).status ? e.message : errorMessage(e),
      );
    } finally {
      if (project === this.projectId) this.busy.set(false);
    }
  }

  private async answer<T>(response: Promise<T>): Promise<T> {
    const project = this.projectId,
      epoch = this.epoch;
    const value = await response;
    if (project !== this.projectId || epoch !== this.epoch) throw new StaleTransfer();
    return value;
  }
}

class StaleTransfer extends Error {}

function initialProfile(process: AdoProcess): AdoProfile {
  const types: AdoProfile['types'] = {
    EPIC: process === 'Basic' ? null : 'Epic',
    FEATURE: process === 'Basic' ? 'Epic' : 'Feature',
    STORY:
      process === 'Basic'
        ? 'Issue'
        : process === 'Scrum'
          ? 'Product Backlog Item'
          : process === 'CMMI'
            ? 'Requirement'
            : 'User Story',
    TASK: 'Task',
    BUG: process === 'Basic' ? 'Issue' : 'Bug',
  };
  if (process === 'Custom') for (const key of Object.keys(types) as ItemType[]) types[key] = null;
  return {
    process,
    types,
    reverseTypes: {},
    states: Object.fromEntries(
      Object.values(Types).map((t) => [
        t,
        Object.fromEntries(Object.values(ItemStatus).map((s) => [s, null])),
      ]),
    ) as AdoProfile['states'],
    incomingStates: {},
    dateTypes: {},
    fields: {
      priority: 'Priority',
      labelIds: 'Tags',
      sprintId: 'Iteration Path',
      area: 'Area Path',
    },
    identities: {},
    incomingIdentities: {},
    tags: {},
    iterations: {},
    area: '',
    iterationRoot: '',
    constants: [],
  };
}
