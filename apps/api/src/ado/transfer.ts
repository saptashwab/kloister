import { createHash } from 'node:crypto';
import {
  type AdoChoice,
  type AdoDestinationDto,
  type AdoDifference,
  type AdoField,
  type AdoImportRequest,
  type AdoPreviewRow,
  type AdoProfile,
  ItemType,
  ItemStatus,
} from '@kloister/shared';
import { isUUID } from 'class-validator';
import { invalidField } from '../common/api-exception.js';
import { sanitizeRichText } from '../common/sanitize-html.js';
import type { AdoItemLink, Prisma } from '../generated/prisma/client.js';
import { readCsv, remoteId, type CsvTable } from './csv.js';
import { object } from './profiles.js';

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
 * Builds honest three-way differences, requiring an explicit choice for every unequal value.
 * @param local Present local fields.
 * @param incoming Present remote fields; absent keys are preserved.
 * @param link Previous confirmed snapshots.
 * @param choices Reviewed direction-dependent choices.
 * @returns Visible differences.
 */
export function differences(
  local: Values,
  incoming: Values,
  link: AdoItemLink | undefined,
  choices: Partial<Record<AdoField, AdoChoice>>,
): AdoDifference[] {
  const lb = (link?.localBaseline ?? {}) as Values,
    rb = (link?.remoteBaseline ?? {}) as Values;
  return (Object.keys(incoming) as AdoField[])
    .filter((field) => digest(local[field] ?? null) !== digest(incoming[field]))
    .map((field) => ({
      field,
      local: local[field] ?? null,
      incoming: incoming[field],
      baselineLocal: lb[field] ?? null,
      baselineRemote: rb[field] ?? null,
      conflict:
        lb[field] === undefined ||
        rb[field] === undefined ||
        (digest(local[field]) !== digest(lb[field]) &&
          digest(incoming[field]) !== digest(rb[field])),
      ...(choices[field] === undefined ? {} : { choice: choices[field] }),
    }));
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

/**
 * Builds a PM-only incoming plan. It never writes, infers identities from titles or imports unselected rows.
 * @param destination Scoped reviewed destination.
 * @param request Incoming review instructions.
 * @param items Fully readable current items.
 * @param links Scoped durable identities, including tombstones.
 * @param parsed Previously validated normalized table for persisted preview recovery.
 * @returns Preview rows, operations and blocking errors.
 */
export function incomingPlan(
  destination: AdoDestinationDto,
  request: AdoImportRequest,
  items: TransferItem[],
  links: AdoItemLink[],
  parsed?: CsvTable,
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
    p = destination.profile;
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
      const incoming = normalize(raw, p, request, id, current, link, row.warnings);
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
      row.differences = differences(current ? localValues(current) : {}, incoming, link, choices);
      const changes: Values = {};
      if (request.mode === 'import')
        for (const d of row.differences) {
          if (d.choice === undefined)
            errors.push(
              `Row ${index + 1}: review ${d.field} (${d.conflict ? 'conflict' : 'difference'}).`,
            );
          if (d.choice === 'incoming') changes[d.field] = incoming[d.field];
        }
      if (
        !current &&
        request.mode === 'import' &&
        (!changes.title || !changes.type || !changes.status || !changes.bucketId)
      )
        errors.push(
          `Row ${index + 1}: new items require reviewed title, reverse type, status and existing bucket.`,
        );
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

function normalize(
  raw: Record<string, string>,
  p: AdoProfile,
  request: AdoImportRequest,
  id: string,
  current: TransferItem | undefined,
  link: AdoItemLink | undefined,
  warnings: string[],
): Values {
  const remoteType = raw['Work Item Type'] ?? '';
  const type =
    request.types[id] ??
    (current && p.types[current.type] === remoteType ? current.type : p.reverseTypes[remoteType]);
  if (!Object.values(ItemType).includes(type))
    throw invalidField('Work Item Type', 'Choose a reverse type for this row');
  const result: Values = { type: type };
  if (request.types[id] !== undefined) {
    if (!Object.values(ItemType).includes(request.types[id]))
      throw invalidField('types', 'Invalid reverse type');
    result.type = request.types[id]!;
  }
  const title = Object.entries(raw).find(
    ([k, v]) => /^Title(?: [1-9]\d*)?$/u.test(k) && v !== '',
  )?.[1];
  if (title !== undefined) result.title = title;
  if (raw['Description'] !== undefined) {
    let html = raw['Description'];
    const refs = references(html);
    if (link && refs.includes(link.reference)) {
      if (link.generatedSuffix && html.endsWith(link.generatedSuffix))
        html = html.slice(0, -link.generatedSuffix.length);
      else if (link.generatedSuffix) {
        // Compare sanitized suffixes so harmless tag/attribute and trailing-space normalization does not accumulate generated content.
        const clean = sanitizeRichText(html).trimEnd(),
          suffix = sanitizeRichText(link.generatedSuffix).trimEnd();
        if (clean.endsWith(suffix)) html = clean.slice(0, -suffix.length);
        else
          throw invalidField(
            'Description',
            'Generated transfer details changed. Restore the issued footer or remove generated details and use explicit manual matching.',
          );
      } else html = html.replace(`Kloister reference: ${link.reference}`, '');
    }
    result.description = sanitizeRichText(html);
    if (result.description !== html)
      warnings.push('Unsafe markup and all embedded images removed; resources are never fetched.');
  }
  const state = raw['State'];
  if (state !== undefined || current === undefined) {
    const mapped = p.incomingStates[`${raw['Work Item Type']}\n${state ?? ''}`];
    if (!mapped)
      throw invalidField(
        'State',
        'Review a status and existing bucket mapping for this type/state (blank state for new rows without State)',
      );
    result.status = mapped.status;
    result.bucketId = mapped.bucketId;
  }
  if (raw['Assigned To'] !== undefined) {
    const alias = raw['Assigned To'];
    if (alias === '') result.assigneeIds = [];
    else if (!Object.hasOwn(p.incomingIdentities, alias))
      throw invalidField(
        'Assigned To',
        'Map unknown identity to a member or explicitly unassigned',
      );
    else {
      const user = p.incomingIdentities[alias];
      result.assigneeIds = user ? [user] : [];
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
        if (!/^[1-4]$/u.test(value)) throw invalidField(header, 'Priority must be 1–4');
        result.priority = Number(value);
        break;
      case 'startDate':
      case 'dueDate':
        if (p.dateTypes[field]?.includes(type)) result[field] = value === '' ? null : value;
        else warnings.push(`${header} omitted: date support is not confirmed for this type.`);
        break;
      case 'sprintId':
        if (value === '') result.sprintId = null;
        else if (Object.hasOwn(p.iterations, value)) result.sprintId = p.iterations[value] ?? null;
        else
          throw invalidField(header, 'Map iteration to an existing sprint or explicitly no sprint');
        break;
      case 'labelIds':
        result.labelIds = [
          ...new Set(
            value
              .split(';')
              .map((v) => v.trim())
              .filter(Boolean)
              .flatMap((tag) => {
                const create = request.createLabels.find((l) => l.tag === tag);
                if (create) return [`label:${tag}`];
                if (!Object.hasOwn(p.tags, tag))
                  throw invalidField(header, 'Review unknown tag mapping or explicit omission');
                return p.tags[tag] ? [p.tags[tag]] : [];
              }),
          ),
        ].sort();
        break;
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
