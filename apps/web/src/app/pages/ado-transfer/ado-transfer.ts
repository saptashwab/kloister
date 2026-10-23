import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import {
  type AdoChoice,
  type AdoDestinationDto,
  type AdoDifference,
  type AdoExportRequest,
  type AdoField,
  type AdoImportRequest,
  type AdoPreview,
  type AdoPreviewRow,
  type AdoProcess,
  type AdoReview,
  type AdoSampleResult,
  adoPreset,
  adoSuggestStatus,
  type ItemStatus as Status,
  type ItemType,
  ItemType as Types,
  ItemStatus,
  ProjectPermission,
} from '@kloister/shared';
import { AdoApiService } from '../../core/ado-api.service';
import { errorMessage } from '../../core/api';
import { LABEL_PALETTE } from '../../core/colour';
import { PRIORITY_LABELS, STATUS_LABELS, TYPE_LABELS } from '../../core/labels';
import { ProjectContext } from '../../core/project-context';
import { Dialogs } from '../../ui/dialogs';
import { ToastService } from '../../ui/toast.service';

/** Workflows on the transfer page. */
type Tab = 'export' | 'import' | 'settings' | 'recovery';

/** Readable names for transfer fields. */
const FIELD_LABELS: Record<AdoField, string> = {
  title: 'Title',
  type: 'Type',
  description: 'Description',
  status: 'Status',
  priority: 'Priority',
  assigneeIds: 'Assignee',
  labelIds: 'Labels',
  sprintId: 'Sprint',
  startDate: 'Start date',
  dueDate: 'Due date',
  parentId: 'Parent',
  bucketId: 'Bucket',
};

/** Readable names for review row kinds. */
const KIND_LABELS: Record<AdoPreviewRow['kind'], string> = {
  create: 'New in ADO',
  update: 'Update',
  link: 'Link returned ID',
  observe: 'Record ADO values',
  unchanged: 'No change',
  pending: 'Awaiting returned ID',
  context: 'Existing parent (context)',
  omitted: 'Left out',
};

/** Separate lazy offline transfer workflow; snapshots retain their existing Export control. */
@Component({
  selector: 'app-ado-transfer',
  imports: [
    FormsModule,
    RouterLink,
    MatButtonModule,
    MatButtonToggleModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTabsModule,
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
  protected readonly tab = signal<Tab>('export');
  /** Last server preview, invalidated on every review change. */
  protected readonly preview = signal<AdoPreview | null>(null);
  /** Retains row choices while incoming previews narrow selection. */
  protected readonly incomingRows = signal<AdoPreviewRow[]>([]);
  /** Saved destination, used separately from editable settings. */
  protected readonly destination = signal<AdoDestinationDto | null>(null);
  /** Quick resolves one-sided changes; Detailed asks about every difference. */
  protected readonly review = signal<AdoReview>('quick');
  /** A PM made Detailed review mandatory for this project. */
  protected readonly detailedRequired = computed(
    () => this.destination()?.requireDetailedReview ?? false,
  );
  /** Serialized actions disable repeated clicks. */
  protected readonly busy = signal(false);
  /** Inline failure, also announced. */
  protected readonly error = signal('');
  /** Config draft fields. */
  protected organization = '';
  /** Remote project identity. */
  protected remoteProject = '';
  /** Editable reviewed profile. */
  protected profile = adoPreset('Agile');
  /** Available process choices. */
  protected readonly processes: AdoProcess[] = ['Basic', 'Agile', 'Scrum', 'CMMI', 'Custom'];
  /** Local type choices. */
  protected readonly types = Object.values(Types);
  /** Local status choices. */
  protected readonly statuses = Object.values(ItemStatus);
  /** Readable type names. */
  protected readonly typeLabels = TYPE_LABELS;
  /** Readable status names. */
  protected readonly statusLabels = STATUS_LABELS;
  /** Readable field names. */
  protected readonly fieldLabels = FIELD_LABELS;
  /** Readable row kinds. */
  protected readonly kindLabels = KIND_LABELS;
  /** Colours offered for labels created by an import. */
  protected readonly palette = LABEL_PALETTE;
  /** Enabled optional field editor rows. */
  protected readonly fields = [
    'priority',
    'labelIds',
    'sprintId',
    'startDate',
    'dueDate',
    'area',
  ] as const;
  /** Readable names of optional fields. */
  protected readonly optionalLabels: Record<(typeof this.fields)[number], string> = {
    priority: 'Priority',
    labelIds: 'Tags',
    sprintId: 'Iteration Path',
    startDate: 'Start date',
    dueDate: 'Due date',
    area: 'Area Path',
  };
  /** Outbound selection; all matching rows are read on the server. */
  protected outbound: AdoExportRequest = emptyOutbound();
  /** Incoming defaults are link-only so creation defaults never silently overwrite local intent. */
  protected inbound: AdoImportRequest = emptyInbound('reconcile');
  /** Filename for operator confidence, never used as identity. */
  protected filename = '';
  /** Editable reverse map rows. */
  protected reverse: { remote: string; local: ItemType }[] = [];
  /** Reviewed incoming state/bucket rows. */
  protected states: { type: string; state: string; status: Status; bucketId: string }[] = [];
  /** Explicit incoming identity aliases. */
  protected identities: { alias: string; userId: string }[] = [];
  /** Explicit tag maps. Empty label means omit. */
  protected tags: { tag: string; labelId: string }[] = [];
  /** Explicit iteration maps. Empty sprint means no sprint. */
  protected iterations: { path: string; sprintId: string }[] = [];
  /** What the last sample file contained, shown while reviewing its suggestions. */
  protected sampled: AdoSampleResult | null = null;
  /** Recoverable workflow list. */
  protected history: {
    id: string;
    mode: string;
    review?: string;
    state: string;
    createdAt: string;
  }[] = [];
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
      this.review.set('quick');
      this.inbound = emptyInbound('reconcile');
      this.outbound = emptyOutbound();
      this.history = [];
      this.nextCursor = null;
      this.filename = '';
      this.organization = '';
      this.remoteProject = '';
      this.profile = adoPreset('Agile');
      this.reverse = [];
      this.states = [];
      this.identities = [];
      this.tags = [];
      this.iterations = [];
      this.sampled = null;
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
        if (destination) {
          this.editDestination(destination);
          if (destination.requireDetailedReview) this.setReview('detailed');
        } else if (this.canImport()) this.tab.set('settings');
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
  protected switchTab(tab: Tab): void {
    this.epoch++;
    this.tab.set(tab);
    this.preview.set(null);
    if (tab === 'recovery') void this.loadHistory();
  }
  /**
   * Chooses Quick or Detailed review for both directions.
   * @param mode Review mode.
   */
  protected setReview(mode: AdoReview): void {
    this.review.set(mode);
    this.outbound.review = mode;
    this.inbound.review = mode;
    this.changed();
  }
  /**
   * Loads a preset whose types and states are suggestions that still require review.
   * @param process Selected process.
   */
  protected preset(process: AdoProcess): void {
    this.profile = adoPreset(process);
    this.reverse = [];
    this.states = [];
    this.identities = [];
    this.tags = [];
    this.iterations = [];
    this.changed();
  }
  /**
   * Reads one ADO export to suggest mappings. Nothing is saved until the PM saves the settings.
   * @param event File input change.
   */
  protected async sample(event: Event): Promise<void> {
    if (this.busy()) return;
    const input = event.target as HTMLInputElement,
      file = input.files?.[0];
    if (!file) return;
    await this.run(async () => {
      if (file.size > 10 * 1024 * 1024)
        throw new Error('CSV exceeds 10 MiB. Export fewer rows for the sample.');
      const csv = new TextDecoder('utf-8', { fatal: true }).decode(
        await this.answer(file.arrayBuffer()),
      );
      this.applySample(await this.answer(this.api.sample(this.projectId, csv)));
    });
    input.value = '';
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
      profile.identities = Object.fromEntries(
        Object.entries(profile.identities).filter(([, v]) => v.trim() !== ''),
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
      this.toast.show('ADO settings saved.');
    });
  }
  /**
   * Makes Detailed review mandatory, or optional again, for every transfer in the project.
   * @param required New policy.
   */
  protected async requireDetailed(required: boolean): Promise<void> {
    await this.run(async () => {
      const destination = await this.answer(this.api.reviewPolicy(this.projectId, required));
      this.destination.set(destination);
      if (required) this.setReview('detailed');
      this.toast.show(
        required ? 'Detailed review is now required.' : 'Quick review is available again.',
      );
    });
  }
  /** Requests a fresh outgoing preview across the complete selected scope. */
  protected async exportPreview(): Promise<void> {
    await this.run(async () => {
      this.outbound.review = this.review();
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
    this.inbound = emptyInbound(this.inbound.mode, this.review());
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
      this.inbound.review = this.review();
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
   * After linking returned IDs, opens an export of exactly those items so their state and
   * assignee can follow in the update pass.
   */
  protected followUp(): void {
    const ids = (this.preview()?.rows ?? []).flatMap((r) => (r.itemId ? [r.itemId] : []));
    this.switchTab('export');
    this.outbound = emptyOutbound(this.review());
    this.outbound.selection.scope = 'manual';
    this.outbound.selection.itemIds = ids;
    this.outbound.selection.ancestors = false;
    this.changed();
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
   * The choice shown for a difference: the explicit one, else the one Quick review made.
   * @param row Reviewed row.
   * @param d Difference.
   * @returns Current choice, if any.
   */
  protected choiceOf(row: AdoPreviewRow, d: AdoDifference): AdoChoice | undefined {
    const explicit =
      this.tab() === 'export'
        ? this.outbound.choices[row.itemId ?? '']
        : this.inbound.choices[row.remoteId ?? ''];
    return explicit?.[d.field] ?? d.choice;
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
  /** Confirms every uploaded row that matched no local item as new, in one step. */
  protected confirmAllNew(): void {
    this.inbound.confirmedNew = this.incomingRows()
      .filter((r) => !r.itemId && r.remoteId)
      .map((r) => r.remoteId!);
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
  /**
   * Item key for a local item, such as KLO-7.
   * @param itemId Local item.
   * @returns Key, or empty when unknown.
   */
  protected keyOf(itemId: string | null): string {
    return itemId ? (this.ctx.itemsById().get(itemId)?.key ?? '') : '';
  }
  /**
   * Shows a transfer value with names instead of internal identifiers.
   * @param field Transfer field.
   * @param value Normalized value.
   * @returns Readable text.
   */
  protected show(field: AdoField, value: unknown): string {
    if (value === null || value === undefined || value === '') return '—';
    if (Array.isArray(value) && value.length === 0) return '—';
    const ids = (Array.isArray(value) ? value : [value]).map(String);
    switch (field) {
      case 'status':
        return STATUS_LABELS[value as Status] ?? scalar(value);
      case 'type':
        return TYPE_LABELS[value as ItemType] ?? scalar(value);
      case 'priority':
        return PRIORITY_LABELS[Number(value)] ?? scalar(value);
      case 'assigneeIds':
        return ids.map((id) => this.ctx.membersById().get(id)?.displayName ?? 'Unknown').join(', ');
      case 'labelIds':
        return ids
          .map((id) =>
            id.startsWith('label:')
              ? `${id.slice(6)} (new)`
              : (this.ctx.labelsById().get(id)?.name ?? 'Unknown'),
          )
          .join(', ');
      case 'sprintId':
        return this.ctx.sprintsById().get(scalar(value))?.name ?? 'Unknown sprint';
      case 'bucketId':
        return this.ctx.bucketsById().get(scalar(value))?.name ?? 'Unknown bucket';
      case 'parentId': {
        const id = scalar(value);
        if (id.startsWith('remote:')) return `ADO ${id.slice(7)}`;
        const parent = this.ctx.itemsById().get(id);
        return parent ? `${parent.key} ${parent.title}` : 'Unknown item';
      }
      case 'description':
        return plain(scalar(value)) || '—';
      default:
        return scalar(value);
    }
  }
  /**
   * Local date and time of a stored timestamp.
   * @param iso ISO timestamp.
   * @returns Readable date and time.
   */
  protected when(iso: string): string {
    return new Date(iso).toLocaleString();
  }
  /**
   * Readable transfer kind.
   * @param mode Stored batch mode.
   * @returns Label.
   */
  protected modeLabel(mode: string): string {
    return (
      {
        export: 'Export to ADO',
        import: 'Import from ADO',
        reconcile: 'Link returned IDs',
        observe: 'Record ADO values',
      }[mode] ?? mode
    );
  }
  /**
   * Readable workflow state.
   * @param state Stored batch state.
   * @returns Label.
   */
  protected stateLabel(state: string): string {
    return (
      {
        PREVIEW: 'Not applied yet',
        PREPARED: 'Files ready',
        PENDING: 'Waiting for returned IDs',
        APPLIED: 'Applied',
        CONFIRMED: 'Confirmed',
        CANCELLED: 'Cancelled',
      }[state] ?? state
    );
  }
  /**
   * Counts with the right noun form.
   * @param count Number.
   * @param noun Singular noun.
   * @returns Phrase such as "1 row" or "3 rows".
   */
  protected plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
  }
  /**
   * Summary entries for display.
   * @param p Preview.
   * @returns Kind and field counts.
   */
  protected summary(p: AdoPreview): { kinds: string[]; fields: string[] } {
    return {
      kinds: Object.entries(p.summary?.kinds ?? {}).map(
        ([kind, n]) => `${KIND_LABELS[kind as AdoPreviewRow['kind']] ?? kind}: ${n}`,
      ),
      fields: Object.entries(p.summary?.fields ?? {}).map(
        ([field, n]) => `${FIELD_LABELS[field as AdoField] ?? field} ×${n}`,
      ),
    };
  }

  private applySample(result: AdoSampleResult): void {
    this.sampled = result;
    if (result.process && result.process !== this.profile.process) this.preset(result.process);
    const p = this.profile;
    for (const remote of result.types) {
      if (this.reverse.some((r) => r.remote === remote)) continue;
      const local = this.types.find((t) => p.types[t] === remote);
      if (local) this.reverse.push({ remote, local });
    }
    const settings = this.ctx.project()?.settings.statusToBucket ?? {};
    for (const { type, state } of result.states) {
      if (this.states.some((s) => s.type === type && s.state === state)) continue;
      const status = adoSuggestStatus(p, type, state) ?? ItemStatus.NOT_STARTED;
      const byName = this.ctx
        .buckets()
        .find((b) => b.name.trim().toLowerCase() === state.trim().toLowerCase());
      this.states.push({ type, state, status, bucketId: settings[status] ?? byName?.id ?? '' });
    }
    for (const tag of result.tags) {
      if (this.tags.some((t) => t.tag === tag)) continue;
      const label = this.ctx.labels().find((l) => l.name.toLowerCase() === tag.toLowerCase());
      this.tags.push({ tag, labelId: label?.id ?? '' });
    }
    for (const path of result.iterations) {
      if (this.iterations.some((i) => i.path === path)) continue;
      const sprint = this.ctx
        .sprints()
        .find((s) => s.adoIterationPath === path || path.endsWith(`\\${s.name}`));
      this.iterations.push({ path, sprintId: sprint?.id ?? '' });
    }
    if (result.dateOrder) p.dateOrder = result.dateOrder;
    for (const [field, header] of [
      ['startDate', 'Start Date'],
      ['dueDate', 'Target Date'],
    ] as const)
      if (result.dateHeaders.includes(header) && !p.fields[field]) p.fields[field] = header;
    this.changed();
    this.toast.show(
      `Read ${this.plural(result.rows, 'row')}. Check the suggested mappings below, then save.`,
    );
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

function emptyOutbound(review: AdoReview = 'quick'): AdoExportRequest {
  return {
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
    review,
  };
}

function emptyInbound(
  mode: AdoImportRequest['mode'],
  review: AdoReview = 'quick',
): AdoImportRequest {
  return {
    csv: '',
    mode,
    review,
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
}

function scalar(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : JSON.stringify(value);
}

function plain(html: string): string {
  return (new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
}
