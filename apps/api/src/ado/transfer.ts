import { createHash } from 'node:crypto';
import {
  type AdoChoice,
  type AdoDestinationDto,
  type AdoDifference,
  type AdoField,
  type AdoImportRequest,
  type AdoPreviewRow,
  type AdoProfile,
  type AdoReview,
  ItemType,
  ItemStatus,
} from '@kloister/shared';
import { isUUID } from 'class-validator';
import { invalidField } from '../common/api-exception.js';
import { sanitizeRichText } from '../common/sanitize-html.js';
import type { AdoItemLink, Prisma } from '../generated/prisma/client.js';
import { readCsv, remoteId, type CsvTable } from './csv.js';
import { object } from './profiles.js';
import { identityEmail, parseAdoDate, sameValue, stripFooter } from './values.js';

/** Snapshot values normalized across the two systems. */
export type Values = Partial<Record<AdoField, string | number | string[] | null>>;

/** Relations used by the transfer reader, always behind ItemsService.scoped. */
export const TRANSFER_INCLUDE = {
  labels: { include: { label: true } },
  assignees: { include: { projectMember: { include: { user: true } } } },
  sprint: true,
  checklist: { orderBy: { position: 'asc' as const } },
  notes: {
    orderBy: { createdAt: 'asc' as const },
    include: { author: { select: { displayName: true } } },
  },
  attachments: { select: { id: true } },
} satisfies Prisma.WorkItemInclude;

/** Fully scoped item with transfer relations. */
export type TransferItem = Prisma.WorkItemGetPayload<{ include: typeof TRANSFER_INCLUDE }>;

/** Project member facts used to recognize ADO identities by email. */
export interface TransferMember {
  /** Local user ID. */
  userId: string;
  /** Account email. */
  email: string;
  /** Shown name. */
  displayName: string;
}

/** Normalized incoming row, used only after a persisted preview is revalidated. */
export interface IncomingOperation {
  /** Remote identity. */
  remoteId: string;
  /** Existing item, or null for an explicitly confirmed create. */
  itemId: string | null;
  /** Resolved pending link, if any. */
  linkId: string | null;
  /** Only reviewed incoming field changes. */
  changes: Values;
  /** Complete normalized remote observation (supplied columns only). */
  incoming: Values;
  /** Original cells retained as context, never executable markup. */
  raw: Record<string, string>;
  /** Original CSV index. */
  index: number;
  /** Parent remote identity; missing leaves existing hierarchy unchanged. */
  parentRemote?: string | null;
}

/** Key in a link's intent listing the fields an update file sent. */
export const SENT = '_sent';

/**
 * Fields an update file sent for a link, from its stored intent.
 * @param intent Stored intent JSON.
 * @returns Sent fields.
 */
export function sentFields(intent: unknown): AdoField[] {
  const value = (intent as Record<string, unknown> | null | undefined)?.[SENT];
  return Array.isArray(value) ? (value as AdoField[]) : [];
}

/** Readable field names for review messages. */
export const FIELD_NAMES: Record<AdoField, string> = {
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

/** Fields a create file carries; State and Assigned To are staged for the update pass. */
const CREATE_FIELDS = new Set<AdoField>([
  'title',
  'type',
  'description',
  'priority',
  'labelIds',
  'sprintId',
  'startDate',
  'dueDate',
  'parentId',
]);

/**
 * Stable digest for preview staleness and replay checks.
 * @param value JSON-safe input.
 * @returns SHA-256 hex digest.
 */
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Captures local transfer fields without changing native structured content.
 * @param item Fully readable item.
 * @returns Normalized local fields.
 */
export function localValues(item: TransferItem): Values {
  return {
    title: item.title,
    type: item.type,
    description: item.description,
    status: item.status,
    priority: item.priority,
    assigneeIds: item.assignees.map((a) => a.userId).sort(),
    labelIds: item.labels.map((l) => l.labelId).sort(),
    sprintId: item.sprintId,
    parentId: item.parentId,
    bucketId: item.bucketId,
    startDate: item.startDate?.toISOString().slice(0, 10) ?? null,
    dueDate: item.dueDate?.toISOString().slice(0, 10) ?? null,
  };
}

/**
 * A local parent id in ADO terms: the nearest ancestor whose type the profile exports.
 * Under Basic, an EPIC is omitted and its children are promoted, so their ADO parent differs
 * from their local parent without anything having changed. The walk passes only through known
 * omitted items; an unknown id is returned unchanged rather than treated as no parent.
 * @param parentId Local parent id, or null.
 * @param byId Readable local items by id.
 * @param profile Destination profile.
 * @returns The id ADO shows as parent, or null.
 */
export function adoParent(
  parentId: string | null,
  byId: Map<string, TransferItem>,
  profile: AdoProfile,
): string | null {
  let id = parentId;
  // The visited set guards against a corrupt parent cycle.
  const seen = new Set<string>();
  for (let parent = byId.get(id ?? ''); parent && profile.types[parent.type] === null;) {
    if (seen.has(parent.id)) break;
    seen.add(parent.id);
    id = parent.parentId;
    parent = byId.get(id ?? '');
  }
  return id;
}

/**
 * Expresses the parent in local values, baselines and intents in ADO terms, so a promoted parent
 * is compared with what ADO can show. Other fields are unchanged.
 * @param values Stored or current values.
 * @param byId Readable local items by id.
 * @param profile Destination profile.
 * @returns A copy with the parent projected, when present.
 */
function inAdoTerms<T extends Record<string, unknown>>(
  values: T,
  byId: Map<string, TransferItem>,
  profile: AdoProfile,
): T {
  if (!('parentId' in values)) return values;
  const parentId = values['parentId'];
  return {
    ...values,
    parentId: adoParent(typeof parentId === 'string' ? parentId : null, byId, profile),
  };
}

/**
 * Builds three-way differences. In Quick review a difference is resolved automatically when only
 * one side changed since the last confirmed sync; a field ADO never received (State, Assigned To
 * after a create) only holds ADO's defaults, so the local value wins there. Changes on both sides,
 * and fields with no known ADO baseline, stay unresolved. Detailed review resolves nothing
 * automatically.
 * @param local Present local fields.
 * @param incoming Present remote fields; absent keys are preserved.
 * @param link Previous confirmed snapshots and the create intent.
 * @param choices Explicit choices, which always win.
 * @param review Review mode.
 * @returns Visible differences.
 */
export function differences(
  local: Values,
  incoming: Values,
  link: AdoItemLink | undefined,
  choices: Partial<Record<AdoField, AdoChoice>>,
  review: AdoReview = 'detailed',
): AdoDifference[] {
  const lb = (link?.localBaseline ?? {}) as Values,
    rb = (link?.remoteBaseline ?? {}) as Values,
    intent = (link?.intent ?? {}) as Values,
    sent = new Set(sentFields(link?.intent));
  return (Object.keys(incoming) as AdoField[])
    .filter((field) => !sameValue(field, local[field], incoming[field]))
    .map((field) => {
      const hasLocalBase = field in lb || field in intent;
      const baseLocal = field in lb ? lb[field] : intent[field];
      // ADO's value is known only from a confirmed sync or from what a create file sent.
      // Sent by an update file but not yet confirmed by a returned export.
      const unconfirmed = sent.has(field) && !(field in rb) && field in intent;
      const hasRemoteBase =
        field in rb || ((CREATE_FIELDS.has(field) || unconfirmed) && field in intent);
      const baseRemote = field in rb ? rb[field] : intent[field];
      // A field a create never sends (State, Assigned To) holds only ADO's defaults afterwards.
      const defaultsOnly = !hasRemoteBase && !CREATE_FIELDS.has(field) && field in intent;
      const localChanged = !hasLocalBase || !sameValue(field, local[field], baseLocal);
      const remoteChanged = hasRemoteBase && !sameValue(field, incoming[field], baseRemote);
      // Without any ADO baseline a difference cannot be attributed to one side; a sent value that
      // ADO no longer shows may never have been imported, so it is asked about too.
      const conflict =
        (localChanged && remoteChanged) ||
        (!hasRemoteBase && !defaultsOnly) ||
        (unconfirmed && remoteChanged);
      const auto: AdoChoice | undefined =
        review !== 'quick' || conflict ? undefined : remoteChanged ? 'incoming' : 'local';
      const choice = choices[field] ?? auto;
      return {
        field,
        local: local[field] ?? null,
        incoming: incoming[field],
        baselineLocal: lb[field] ?? null,
        baselineRemote: rb[field] ?? null,
        conflict: review === 'quick' ? conflict : conflict || !(field in lb) || !(field in rb),
        ...(choice === undefined ? {} : { choice }),
        ...(choices[field] === undefined && auto !== undefined ? { auto: true } : {}),
      };
    });
}

/**
 * Validates arbitrary nested choice maps before indexing them.
 * @param value Submitted choices.
 */
export function validateChoices(value: unknown): void {
  const fields = new Set([
    'title',
    'type',
    'description',
    'status',
    'priority',
    'assigneeIds',
    'labelIds',
    'sprintId',
    'startDate',
    'dueDate',
    'parentId',
    'bucketId',
  ]);
  for (const map of Object.values(object(value)))
    for (const [f, c] of Object.entries(object(map)))
      if (!fields.has(f) || !['local', 'incoming', 'skip'].includes(String(c)))
        throw invalidField('choices', 'Unknown field or resolution');
}

/** Inputs for reading one ADO row into local terms. */
export interface NormalizeOptions {
  /** Linked local item, if any. */
  current?: TransferItem;
  /** Durable link, used to recognize the generated footer. */
  link?: AdoItemLink;
  /** Explicit reverse type for this row. */
  type?: ItemType;
  /** Reviewed tags that become new labels. */
  createLabels?: AdoImportRequest['createLabels'];
  /** Unmapped values become warnings and are left out instead of blocking. */
  lenient: boolean;
  /** Project members, for email-based identity matching. */
  members: TransferMember[];
  /** Collected row warnings. */
  warnings: string[];
}

/**
 * Builds a PM-only incoming plan. It never writes, infers identities from titles or imports unselected rows.
 * @param destination Scoped reviewed destination.
 * @param request Incoming review instructions.
 * @param items Fully readable current items.
 * @param links Scoped durable identities, including tombstones.
 * @param parsed Previously validated normalized table for persisted preview recovery.
 * @param members Project members, for identity matching by email.
 * @returns Preview rows, operations and blocking errors.
 */
export function incomingPlan(
  destination: AdoDestinationDto,
  request: AdoImportRequest,
  items: TransferItem[],
  links: AdoItemLink[],
  parsed?: CsvTable,
  members: TransferMember[] = [],
): {
  rows: AdoPreviewRow[];
  operations: IncomingOperation[];
  errors: string[];
  warnings: string[];
} {
  validateChoices(request.choices);
  object(request.manualLinks);
  object(request.types);
  const table = parsed ?? readCsv(request.csv),
    p = destination.profile,
    review: AdoReview = request.review ?? 'quick';
  const errors: string[] = [],
    warnings = [
      'CSV is an observation, not a live lock. Missing rows never delete work.',
      'File/image bytes, dependencies and historical authorship are not imported.',
    ];
  if (!table.headers.includes('ID'))
    throw invalidField('csv', 'Incoming files require assigned ID values');
  if (
    (!table.headers.includes('Team Project') ||
      !['Organization', 'Collection'].some((h) => table.headers.includes(h))) &&
    !request.destinationAcknowledged
  )
    errors.push(
      'Acknowledge the selected organization/collection and project: this CSV lacks complete destination provenance.',
    );
  const selected =
    request.selectedRows === null
      ? new Set(table.rows.map((_, i) => i))
      : new Set(request.selectedRows);
  if ([...selected].some((i) => !Number.isInteger(i) || i < 0 || i >= table.rows.length))
    throw invalidField('selectedRows', 'Unknown selected row');
  const ids = new Set<string>(),
    markers = new Set<string>(),
    rowIds = new Map<number, string>(),
    parents = new Map<string, string | null>();
  const stack: string[] = [];
  const titleHeaders = table.headers.filter((h) => /^Title(?: [1-9]\d*)?$/u.test(h));
  if (titleHeaders.includes('Title') && titleHeaders.length !== 1)
    throw invalidField('csv', 'Do not mix Title and hierarchy Title columns');
  const titles = new Map<string, string>();
  for (const [index, raw] of table.rows.entries()) {
    const id = remoteId(raw['ID'] ?? '');
    if (ids.has(id)) throw invalidField('ID', 'Duplicate remote ID');
    ids.add(id);
    rowIds.set(index, id);
    if (
      raw['Team Project'] !== undefined &&
      raw['Team Project'].trim().toLowerCase() !== destination.remoteProject.toLowerCase()
    )
      throw invalidField('Team Project', 'CSV belongs to a different project');
    for (const h of ['Organization', 'Collection'])
      if (raw[h] !== undefined && canonical(raw[h]) !== destination.organization)
        throw invalidField(h, 'CSV belongs to a different organization/collection');
    const filled = titleHeaders.filter((h) => raw[h] !== '');
    if (filled.length !== 1)
      throw invalidField('Title', 'Exactly one Title cell is required per row');
    const header = filled[0];
    titles.set(id, raw[header]);
    if (header !== 'Title') {
      const depth = Number(header.slice(6));
      if (depth > stack.length + 1 || depth > 10)
        throw invalidField('Title', 'Hierarchy skips a parent level');
      const parent = depth === 1 ? null : stack[depth - 2];
      parents.set(id, parent);
      stack.length = depth;
      stack[depth - 1] = id;
    }
    if (raw['Parent'] !== undefined) {
      const parent = raw['Parent'] === '' ? null : remoteId(raw['Parent']);
      if (parents.has(id) && parents.get(id) !== parent)
        throw invalidField('Parent', 'Parent and Title hierarchy disagree');
      parents.set(id, parent);
    }
    const found = references(raw['Description'] ?? '');
    if (found.length > 1 || found.some((ref) => markers.has(ref)))
      throw invalidField('Description', 'Duplicate or conflicting references');
    for (const ref of found) {
      markers.add(ref);
      if (!links.some((l) => l.reference === ref))
        throw invalidField('Description', 'Unknown or foreign issued reference');
    }
  }
  const operations: IncomingOperation[] = [],
    rows: AdoPreviewRow[] = [];
  const byItem = new Map(items.map((i) => [i.id, i]));
  const claimed = new Set<string>();
  for (const [index, raw] of table.rows.entries()) {
    if (!selected.has(index)) continue;
    const id = rowIds.get(index)!;
    const row: AdoPreviewRow = {
      index,
      itemId: null,
      remoteId: id,
      title: titles.get(id)!,
      kind: 'create',
      selected: true,
      differences: [],
      warnings: [],
    };
    rows.push(row);
    try {
      const marker = references(raw['Description'] ?? '')[0];
      const marked = marker === undefined ? undefined : links.find((l) => l.reference === marker);
      const existing = links.find((l) => l.remoteId === id);
      const manualId = request.manualLinks[id] || undefined;
      const manual =
        manualId === undefined
          ? undefined
          : links.find(
              (l) => l.itemId === manualId && l.remoteId === null && l.pendingBatchId !== null,
            );
      if (manualId !== undefined && !manual)
        throw invalidField('manualLinks', 'Manual matching requires a known pending item');
      const link = existing ?? marked ?? manual;
      if (
        (marked && existing && marked.id !== existing.id) ||
        (manual && link?.id !== manual.id) ||
        (link?.remoteId !== null && link?.remoteId !== undefined && link.remoteId !== id)
      )
        throw invalidField('ID', 'Reference and remote identity conflict');
      if (link && (link.tombstonedAt !== null || !byItem.has(link.itemId)))
        throw invalidField('ID', 'Deleted local item is a tombstone and cannot be recreated');
      if (link?.remoteId === null && link.pendingBatchId === null)
        throw invalidField('ID', 'Cancelled reference cannot be linked');
      if (link && claimed.has(link.itemId))
        throw invalidField('ID', 'Two rows map to one local item');
      if (link) claimed.add(link.itemId);
      if (!link && (request.mode !== 'import' || !request.confirmedNew.includes(id)))
        throw invalidField('ID', 'Explicit manual matching or confirmation as new is required');
      const current = link ? byItem.get(link.itemId) : undefined;
      row.itemId = current?.id ?? null;
      row.kind = current
        ? request.mode === 'reconcile'
          ? 'link'
          : request.mode === 'observe'
            ? 'observe'
            : 'update'
        : 'create';
      const incoming = normalizeRow(raw, p, {
        current,
        link,
        type: request.types[id],
        createLabels: request.createLabels,
        // Only a Detailed import of existing values blocks on unmapped values; new items always need them.
        lenient: request.mode !== 'import' || (review === 'quick' && current !== undefined),
        members,
        warnings: row.warnings,
      });
      const parentRemote = parents.get(id);
      if (parents.has(id)) {
        if (parentRemote === id) throw invalidField('Parent', 'An item cannot parent itself');
        const parentLink = links.find(
          (l) => l.remoteId === parentRemote && l.tombstonedAt === null && byItem.has(l.itemId),
        );
        const parentSelected = [...selected].some((i) => rowIds.get(i) === parentRemote);
        if (
          parentRemote !== null &&
          !parentLink &&
          !parentSelected &&
          !request.omittedParents.includes(id)
        )
          throw invalidField(
            'Parent',
            'Include the parent explicitly, map an existing parent, or explicitly omit it',
          );
        incoming.parentId =
          request.omittedParents.includes(id) || parentRemote === null
            ? null
            : (parentLink?.itemId ?? `remote:${parentRemote}`);
        if (request.omittedParents.includes(id))
          row.warnings.push('Parent intentionally omitted; hierarchy is lost for this row.');
      }
      const choices = request.choices[id] ?? {};
      // The parent is compared in ADO terms; incoming stays ADO's own view, as stored.
      const project = <T extends Record<string, unknown>>(v: T): T => inAdoTerms(v, byItem, p);
      row.differences = differences(
        current ? project(localValues(current)) : {},
        incoming,
        link && {
          ...link,
          localBaseline: project((link.localBaseline ?? {}) as Values),
          intent: project((link.intent ?? {}) as Values),
        },
        choices,
        review,
        // A new item takes every incoming value in Quick review.
      )
        .map((d) =>
          // Review screens show the real local parent, not its ADO projection.
          d.field === 'parentId' && current
            ? {
                ...d,
                local: current.parentId,
                baselineLocal: ((link?.localBaseline ?? {}) as Values).parentId ?? null,
              }
            : d,
        )
        // A new item has nothing to conflict with: Quick review takes ADO's values,
        // Detailed review asks for each one.
        .map((d) =>
          current
            ? d
            : review === 'quick' && choices[d.field] === undefined
              ? { ...d, choice: 'incoming' as const, auto: true, conflict: false, newItem: true }
              : // "Keep local" means nothing for a new item; it still needs a choice.
                {
                  ...d,
                  conflict: false,
                  newItem: true,
                  ...(d.choice === 'local' ? { choice: undefined } : {}),
                },
        );
      const changes: Values = {};
      if (request.mode === 'import')
        for (const d of row.differences) {
          if (d.choice === undefined)
            errors.push(
              `Row ${index + 1}: choose ${FIELD_NAMES[d.field]} (${d.newItem ? 'value for this new item' : d.conflict ? 'changed on both sides' : 'difference'}).`,
            );
          if (d.choice === 'incoming') changes[d.field] = incoming[d.field];
        }
      // Asked only once every value is chosen, so it never repeats the per-field requests.
      if (
        !current &&
        request.mode === 'import' &&
        row.differences.every((d) => d.choice !== undefined) &&
        (!changes.title || !changes.type || !changes.status || !changes.bucketId)
      )
        errors.push(
          `Row ${index + 1}: new items require reviewed title, reverse type, status and existing bucket.`,
        );
      row.changes = Object.keys(changes) as AdoField[];
      if (current && row.differences.length === 0) row.kind = 'unchanged';
      operations.push({
        remoteId: id,
        itemId: current?.id ?? null,
        linkId: link?.id ?? null,
        changes,
        incoming,
        raw,
        index,
        ...(parents.has(id) ? { parentRemote: parentRemote ?? null } : {}),
      });
    } catch (error) {
      errors.push(`Row ${index + 1}: ${error instanceof Error ? error.message : 'Invalid row'}`);
    }
  }
  // Topological order uses only selected operations; no implicit import of their parents.
  const sorted: IncomingOperation[] = [],
    visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (op: IncomingOperation): void => {
    if (done.has(op.remoteId)) return;
    if (visiting.has(op.remoteId)) {
      errors.push('Incoming hierarchy contains a cycle.');
      return;
    }
    visiting.add(op.remoteId);
    const parent = operations.find((o) => o.remoteId === op.parentRemote);
    if (parent) visit(parent);
    visiting.delete(op.remoteId);
    done.add(op.remoteId);
    sorted.push(op);
  };
  operations.forEach(visit);
  return { rows, operations: sorted, errors, warnings };
}

/**
 * Canonical identity comparison, never URL retrieval.
 * @param value Identity string.
 * @returns Trimmed lowercase identity without trailing slash.
 */
export function canonical(value: string): string {
  return value.trim().replace(/\/+$/u, '').toLowerCase();
}

/**
 * Extracts only opaque issued-reference syntax; malformed reference mentions fail closed.
 * @param html Description text.
 * @returns Candidate references, validated against scoped stored links by the caller.
 */
export function references(html: string): string[] {
  const plain = sanitizeRichText(html).replace(/<[^>]*>/gu, '');
  const refs = [...plain.matchAll(/Kloister reference: ([a-f0-9]{64})/gu)].map((m) => m[1]);
  if ((plain.match(/Kloister reference:/gu)?.length ?? 0) !== refs.length)
    throw invalidField('Description', 'Malformed reference');
  return refs;
}

/**
 * Reads one ADO row into local terms. Absent columns stay absent so they never change local data.
 * Lenient reading reports unmapped values as warnings and leaves those fields out.
 * @param raw Row cells by header.
 * @param p Destination profile.
 * @param options Row context.
 * @returns Normalized values for the supplied columns.
 */
export function normalizeRow(
  raw: Record<string, string>,
  p: AdoProfile,
  options: NormalizeOptions,
): Values {
  const { current, link, lenient, warnings } = options;
  const skip = (header: string, message: string): void => {
    if (!lenient) throw invalidField(header, message);
    warnings.push(`${message}; ${header} is left unchanged.`);
  };
  const remoteType = raw['Work Item Type'] ?? '';
  let type =
    options.type ??
    (current && p.types[current.type] === remoteType ? current.type : p.reverseTypes[remoteType]);
  if (!Object.values(ItemType).includes(type)) {
    if (!(lenient && current))
      throw invalidField('Work Item Type', 'Choose a reverse type for this row');
    type = current.type;
  }
  const result: Values = { type };
  const title = Object.entries(raw).find(
    ([k, v]) => /^Title(?: [1-9]\d*)?$/u.test(k) && v !== '',
  )?.[1];
  if (title !== undefined) result.title = title;
  if (raw['Description'] !== undefined) {
    const html = raw['Description'];
    result.description = link ? stripFooter(html, link.reference) : sanitizeRichText(html);
    if (/<img\b/iu.test(html))
      warnings.push(
        'Embedded images in the ADO description are not kept; resources are never fetched.',
      );
    else if (
      sanitizeRichText(html) !== html.trim() &&
      /<(?:script|iframe|object|style)\b/iu.test(html)
    )
      warnings.push('Unsafe markup removed; resources are never fetched.');
  }
  const state = raw['State'];
  if (state !== undefined || current === undefined) {
    const mapped = p.incomingStates[`${remoteType}\n${state ?? ''}`];
    if (mapped) {
      result.status = mapped.status;
      result.bucketId = mapped.bucketId;
    } else if (current === undefined)
      throw invalidField(
        'State',
        `Map "${remoteType}" state "${state ?? ''}" to a status and existing bucket`,
      );
    else skip('State', `State "${state}" of "${remoteType}" has no mapping`);
  }
  if (raw['Assigned To'] !== undefined) {
    const alias = raw['Assigned To'].trim();
    if (alias === '') result.assigneeIds = [];
    else {
      const user = resolveIdentity(alias, p, options.members);
      if (user === undefined) skip('Assigned To', `"${alias}" is not mapped to a project member`);
      else result.assigneeIds = user ? [user] : [];
    }
    if (alias === '' && current?.assignees.length)
      warnings.push(
        'Empty remote assignment preserves extra local assignees; ordinary assignment controls can clear them.',
      );
  }
  for (const [field, header] of Object.entries(p.fields)) {
    const value = raw[header];
    if (value === undefined) continue;
    switch (field) {
      case 'priority':
        if (value.trim() === '') break;
        if (!/^[1-4]$/u.test(value.trim())) throw invalidField(header, 'Priority must be 1–4');
        result.priority = Number(value.trim());
        break;
      case 'startDate':
      case 'dueDate':
        if (p.dateTypes[field]?.includes(type))
          try {
            result[field] = parseAdoDate(value, p.dateOrder, header);
          } catch (error) {
            skip(header, error instanceof Error ? error.message : `Unreadable ${header}`);
          }
        else if (value.trim() !== '')
          warnings.push(`${header} left out: date support is not confirmed for this type.`);
        break;
      case 'sprintId':
        if (value.trim() === '') result.sprintId = null;
        else if (Object.hasOwn(p.iterations, value)) result.sprintId = p.iterations[value] ?? null;
        else skip(header, `Iteration "${value}" is not mapped to a sprint`);
        break;
      case 'labelIds': {
        const labels: string[] = [];
        for (const tag of value
          .split(';')
          .map((v) => v.trim())
          .filter(Boolean)) {
          const mapped = tagLabel(p, tag);
          if (options.createLabels?.some((l) => l.tag.toLowerCase() === tag.toLowerCase()))
            labels.push(`label:${tag}`);
          else if (mapped === undefined) {
            if (!lenient)
              throw invalidField(header, `Map tag "${tag}" to a label or omit it explicitly`);
            warnings.push(`Tag "${tag}" is not mapped; it stays in ADO only.`);
          } else if (mapped) labels.push(mapped);
        }
        result.labelIds = [...new Set(labels)].sort();
        break;
      }
    }
  }
  for (const key of ['assigneeIds', 'labelIds'] as const)
    for (const value of (result[key] as string[]) ?? [])
      if (!isUUID(value) && !value.startsWith('label:'))
        throw invalidField(key, 'Invalid mapped identity');
  if (
    result.status !== undefined &&
    !Object.values(ItemStatus).includes(result.status as ItemStatus)
  )
    throw invalidField('State', 'Invalid status mapping');
  return result;
}

/**
 * Looks up a tag mapping the way ADO compares tags: ignoring case.
 * @param p Destination profile.
 * @param tag ADO tag.
 * @returns Label ID, null for an explicit omission, undefined when unmapped.
 */
export function tagLabel(p: AdoProfile, tag: string): string | null | undefined {
  if (Object.hasOwn(p.tags, tag)) return p.tags[tag];
  const key = Object.keys(p.tags).find((k) => k.toLowerCase() === tag.toLowerCase());
  return key === undefined ? undefined : p.tags[key];
}

/**
 * Resolves an exported identity to a member: an explicit alias first, then the email inside
 * `Display Name <email>` against aliases and member emails.
 * @param value Exported identity.
 * @param p Destination profile.
 * @param members Project members.
 * @returns Member ID, null for explicit unassigned, undefined when unknown.
 */
function resolveIdentity(
  value: string,
  p: AdoProfile,
  members: TransferMember[],
): string | null | undefined {
  if (Object.hasOwn(p.incomingIdentities, value)) return p.incomingIdentities[value];
  const email = identityEmail(value);
  if (!email) return undefined;
  for (const [alias, user] of Object.entries(p.incomingIdentities))
    if ((identityEmail(alias) ?? alias.toLowerCase()) === email) return user;
  return members.find((m) => m.email.toLowerCase() === email)?.userId;
}
