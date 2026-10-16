import {
  type AdoDestinationDto,
  type AdoExportRequest,
  type AdoPreviewRow,
  type ItemType,
} from '@kloister/shared';
import { invalidField } from '../common/api-exception.js';
import { sanitizeRichText } from '../common/sanitize-html.js';
import type { AdoItemLink } from '../generated/prisma/client.js';
import { writeCsv } from './csv.js';
import { selectItems } from './selection.js';
import {
  differences,
  localValues,
  type TransferItem,
  type Values,
  validateChoices,
} from './transfer.js';

/** Complete bounded file and explicit mode. */
export interface ExportFile {
  /** Mode and sequence filename, batch prefix added on download. */
  name: string;
  /** Actual CSV bytes represented as text. */
  csv: string;
  /** Data rows including ID-bearing ancestor context. */
  rows: number;
}

/** Reserved create intent to persist atomically before permitting a download. */
export interface ExportIntent {
  /** Local identity. */
  itemId: string;
  /** Exact outgoing normalized values. */
  values: Values;
  /** Exact generated footer, not stored in ordinary descriptions. */
  suffix: string;
  /** Placeholder replaced with a new random token only during prepare. */
  reference: string;
  /** Whether this reserves a new create rather than an ID update. */
  create: boolean;
}

/**
 * Builds conservative separate create/update files without changing local data or accepting incoming CSV.
 * @param destination Scoped reviewed profile.
 * @param request Selection and file-only choices.
 * @param all Complete scoped project items.
 * @param links Scoped mappings with PM-reviewed observations.
 * @param metadata Existing project labels and sprints for reviewed outbound resolutions.
 * @param metadata.labels Existing project labels.
 * @param metadata.sprints Existing project sprints.
 * @returns Explicit preview and complete files, with blocking errors.
 */
export function exportPlan(
  destination: AdoDestinationDto,
  request: AdoExportRequest,
  all: TransferItem[],
  links: AdoItemLink[],
  metadata: {
    labels: { id: string; name: string }[];
    sprints: { id: string; name: string; adoIterationPath: string | null }[];
  } = {
    labels: all.flatMap((i) => i.labels.map((l) => l.label)),
    sprints: all.flatMap((i) => (i.sprint ? [i.sprint] : [])),
  },
): {
  rows: AdoPreviewRow[];
  files: ExportFile[];
  intents: ExportIntent[];
  warnings: string[];
  errors: string[];
} {
  validateChoices(request.choices);
  const selection = selectItems(all, request.selection),
    p = destination.profile;
  const rows: AdoPreviewRow[] = [],
    errors: string[] = [],
    intents: ExportIntent[] = [];
  const warnings = [
    'Create files omit State and Assigned To. Return assigned IDs, then prepare an ID-based update.',
    'Files, inline images and dependency links are omitted. Checklists and optional notes are labelled description text.',
    'Manual replay of a create CSV in ADO can create duplicates; downloads never confirm import.',
  ];
  if (!request.selection.ancestors)
    warnings.push('Ancestors excluded: hierarchy outside this selection will be lost.');
  const byId = new Map(selection.items.map((i) => [i.id, i]));
  const linked = new Map(links.map((l) => [l.itemId, l]));
  const omitted = new Set(selection.items.filter((i) => p.types[i.type] === null).map((i) => i.id));
  const effectiveParent = (i: TransferItem): string | null => {
    let parent = byId.get(i.parentId ?? '');
    while (parent && omitted.has(parent.id)) parent = byId.get(parent.parentId ?? '');
    return parent?.id ?? null;
  };
  const usable = selection.items.filter((i) => !omitted.has(i.id));
  const newItems = usable.filter((i) => !linked.get(i.id)?.remoteId);
  const values = new Map<string, Values>();
  const references = new Map<string, string>();
  for (const [index, item] of selection.items.entries()) {
    const link = linked.get(item.id);
    const row: AdoPreviewRow = {
      index,
      itemId: item.id,
      remoteId: link?.remoteId ?? null,
      title: item.title,
      kind: omitted.has(item.id)
        ? 'omitted'
        : link?.pendingBatchId
          ? 'pending'
          : link?.remoteId
            ? 'update'
            : 'create',
      selected: selection.selected.has(item.id),
      differences: [],
      warnings: [],
    };
    rows.push(row);
    if (omitted.has(item.id)) {
      row.warnings.push(`${item.type} explicitly omitted by ${p.process}; children promoted.`);
      continue;
    }
    if (link?.tombstonedAt) {
      errors.push(`${item.title}: deleted identity cannot transfer.`);
      continue;
    }
    if (link?.pendingBatchId)
      errors.push(
        `${item.title}: recover or cancel pending batch ${link.pendingBatchId} before issuing another create.`,
      );
    const current = localValues(item);
    const chosen = request.assignees[item.id];
    const assignees = item.assignees.map((a) => a.userId);
    if (chosen === undefined && assignees.length > 1)
      errors.push(`${item.title}: explicitly choose one remote assignee or unassigned.`);
    if (chosen !== undefined && chosen !== null && !assignees.includes(chosen))
      errors.push(`${item.title}: chosen assignee is not assigned locally.`);
    const person = chosen === undefined ? (assignees[0] ?? null) : chosen;
    if (person !== null && !p.identities[person])
      errors.push(`${item.title}: configure the chosen remote identity.`);
    current.assigneeIds = person === null ? [] : [person];
    if (assignees.length > 1)
      row.warnings.push(
        'Additional assignees rendered as text; returning CSV preserves native extra assignments.',
      );
    if (p.states[item.type][item.status] === null)
      row.warnings.push(
        `${item.status} is explicitly omitted for this type; remote state will be preserved.`,
      );
    if (link?.remoteId) {
      if (!link.observedAt || link.observationRevision !== destination.revision)
        errors.push(
          `${item.title}: a PM must review a fresh CSV observation for this profile revision.`,
        );
      if (!request.freshnessAcknowledged)
        errors.push('Acknowledge observation freshness before preparing linked updates.');
      row.warnings.push(
        `Remote observed ${link.observedAt?.toISOString() ?? 'never'}; later remote edits cannot be detected.`,
      );
      const observation = link.observation as { values?: Values };
      const remote = { ...observation.values };
      delete remote.bucketId;
      row.differences = differences(current, remote, link, request.choices[item.id] ?? {});
      for (const d of row.differences) {
        if (d.choice === undefined)
          errors.push(`${item.title}: choose file content for ${d.field}.`);
        if (d.choice === 'incoming' || d.choice === 'skip')
          current[d.field] = observation.values?.[d.field];
      }
    }
    values.set(item.id, current);
    // Preview tokens carry no linking authority. Random issued references are reserved at prepare.
    const reference = link?.reference ?? `preview-${item.id}`;
    references.set(item.id, reference);
    const suffix = footer(item, reference, request.selection.notes);
    if (!link?.remoteId || selection.selected.has(item.id))
      intents.push({
        itemId: item.id,
        values: current,
        suffix,
        reference,
        create: !link?.remoteId,
      });
  }
  const files: ExportFile[] = [];
  const emitted = new Set<string>();
  const enabled = Object.entries(p.fields);
  const rawValue = (item: TransferItem, field: string, value: Values): string => {
    switch (field) {
      case 'priority':
        return String(value.priority ?? item.priority);
      case 'labelIds':
        return ((value.labelIds as string[]) ?? [])
          .map((id) => {
            const name = metadata.labels.find((l) => l.id === id)?.name;
            if (!name || name.includes(';'))
              throw invalidField(
                'Tags',
                'Label cannot be represented as a semicolon-delimited tag',
              );
            return name;
          })
          .join('; ');
      case 'sprintId': {
        const sprint = metadata.sprints.find((s) => s.id === value.sprintId);
        if (value.sprintId && !sprint)
          throw invalidField('sprintId', 'Chosen sprint is unavailable');
        if (sprint && !sprint.adoIterationPath && !p.iterationRoot)
          warnings.push(
            `${item.title}: iteration path is missing and will use the destination default.`,
          );
        return sprint
          ? (sprint.adoIterationPath ??
              (p.iterationRoot ? `${p.iterationRoot}\\${sprint.name}` : ''))
          : '';
      }
      case 'area':
        return p.area;
      case 'startDate':
      case 'dueDate':
        return String(value[field] ?? '');
      default:
        return '';
    }
  };
  const createTrees = new Map<string, TransferItem[]>();
  for (const item of newItems) {
    let root = item;
    for (
      let parent = byId.get(effectiveParent(root) ?? '');
      parent;
      parent = byId.get(effectiveParent(parent) ?? '')
    )
      root = parent;
    const tree = createTrees.get(root.id) ?? [];
    const add = (i: TransferItem): void => {
      const parent = byId.get(effectiveParent(i) ?? '');
      if (parent) add(parent);
      if (!tree.some((t) => t.id === i.id)) tree.push(i);
    };
    add(item);
    createTrees.set(root.id, tree);
  }
  const groups: TransferItem[][] = [];
  for (const tree of createTrees.values()) {
    if (tree.length > 1000) {
      errors.push(
        'A single create tree exceeds 1,000 rows. Reduce or explicitly flatten the selection.',
      );
      continue;
    }
    const last = groups.at(-1);
    if (last && last.length + tree.length <= 1000) last.push(...tree);
    else groups.push([...tree]);
  }
  for (const [fileIndex, unsorted] of groups.entries()) {
    try {
      const group = depthFirst(unsorted, effectiveParent);
      const createEnabled = enabled.filter(
        ([field]) =>
          !['startDate', 'dueDate'].includes(field) ||
          group.every((i) => p.dateTypes[field as 'startDate' | 'dueDate']?.includes(i.type)),
      );
      if (createEnabled.length !== enabled.length)
        warnings.push(
          'Optional dates omitted from this complete create tree because support is not confirmed for every context/create type.',
        );
      const groupIds = new Set(group.map((i) => i.id));
      const depth = (i: TransferItem): number => {
        const parent = byId.get(effectiveParent(i) ?? '');
        return parent && groupIds.has(parent.id) ? depth(parent) + 1 : 1;
      };
      const max = Math.max(1, ...group.map(depth));
      const mixed = group.some((i) => linked.get(i.id)?.remoteId);
      const headers = [
        ...(mixed ? ['ID'] : []),
        'Work Item Type',
        ...Array.from({ length: max }, (_, i) => `Title ${i + 1}`),
        'Description',
        ...createEnabled.map(([, h]) => h),
        ...p.constants.map((c) => c.header),
      ];
      const data = group.map((item) => {
        emitted.add(item.id);
        const link = linked.get(item.id),
          context = Boolean(link?.remoteId),
          value = values.get(item.id) ?? localValues(item);
        const raw = (link?.observation as { raw?: Record<string, string> } | undefined)?.raw ?? {};
        const get = (header: string, local: string): string => {
          if (!context) return local;
          if (
            !link?.observedAt ||
            link.observationRevision !== destination.revision ||
            !request.freshnessAcknowledged
          )
            throw invalidField(
              'context',
              'Existing parent context needs fresh reviewed observations and freshness acknowledgement',
            );
          const remote = raw[header];
          if (remote === undefined || (header === 'Work Item Type' && remote === ''))
            throw invalidField(
              'context',
              `Existing parent context requires a reviewed ${header} column; reduce the profile or ask a PM to refresh it`,
            );
          return remote;
        };
        const remoteTitle = Object.entries(raw).find(
          ([h, v]) => /^Title(?: \d+)?$/u.test(h) && v,
        )?.[1];
        if (context && !remoteTitle)
          throw invalidField('context', 'Existing parent requires a reviewed remote title');
        if (context) {
          const remote = link?.observation as { values?: Values };
          if (
            remote.values?.parentId === undefined ||
            remote.values.parentId !== effectiveParent(item)
          )
            throw invalidField(
              'context',
              'Existing ancestor hierarchy must match a reviewed remote Parent/hierarchy observation before it is emitted as context',
            );
          const row = rows.find((r) => r.itemId === item.id);
          row?.warnings.push(
            'ID-bearing ancestor context preserves reviewed remote values; this row never recreates the parent.',
          );
        }
        return [
          ...(mixed ? [link?.remoteId ?? ''] : []),
          get('Work Item Type', p.types[item.type]!),
          ...Array.from({ length: max }, (_, i) =>
            i + 1 === depth(item) ? (context ? remoteTitle! : String(value.title)) : '',
          ),
          get(
            'Description',
            sanitizeRichText(String(value.description ?? '')) +
              (intents.find((i) => i.itemId === item.id)?.suffix ?? ''),
          ),
          ...createEnabled.map(([f, h]) => get(h, rawValue(item, f, value))),
          ...p.constants.map((c) => get(c.header, c.value)),
        ];
      });
      files.push({
        name: `create-${fileIndex + 1}.csv`,
        csv: writeCsv(headers, data),
        rows: data.length,
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Cannot create CSV');
    }
  }
  const updates = usable.filter((i) => linked.get(i.id)?.remoteId && selection.selected.has(i.id));
  const capabilities = (i: TransferItem): string => {
    const v = values.get(i.id)!;
    const type = v.type as ItemType,
      state = p.states[type][v.status as keyof (typeof p.states)[typeof type]];
    return JSON.stringify({
      state: state !== null,
      fields: enabled
        .filter(
          ([f]) =>
            !['startDate', 'dueDate'].includes(f) ||
            p.dateTypes[f as 'startDate' | 'dueDate']?.includes(type),
        )
        .map(([f]) => f),
    });
  };
  // Partition by final reviewed capabilities, not the original local type/status.
  for (const signature of new Set(updates.map(capabilities))) {
    const typed = updates.filter((i) => capabilities(i) === signature);
    for (let offset = 0; offset < typed.length; offset += 990) {
      try {
        const chosen = typed.slice(offset, offset + 990),
          chosenIds = new Set(chosen.map((i) => i.id));
        const configuration = JSON.parse(signature) as { state: boolean; fields: string[] };
        const updateEnabled = enabled.filter(([f]) => configuration.fields.includes(f));
        const updateItems = new Map(chosen.map((i) => [i.id, i]));
        const parentOf = (i: TransferItem): string | null => {
          const chosenValue = values.get(i.id);
          const observed = (linked.get(i.id)?.observation as { values?: Values } | undefined)
            ?.values;
          if (request.selection.ancestors && observed?.parentId === undefined)
            throw invalidField(
              'context',
              'Refresh remote Parent/hierarchy columns before emitting an ID-based hierarchy update',
            );
          if (!chosenIds.has(i.id) && observed?.parentId === undefined)
            throw invalidField(
              'context',
              'Refresh remote Parent/hierarchy columns before emitting existing ancestor context',
            );
          let parent = chosenIds.has(i.id)
            ? (chosenValue?.parentId ?? null)
            : (observed?.parentId ?? null);
          if (!request.selection.ancestors) return null;
          while (typeof parent === 'string' && omitted.has(parent))
            parent = byId.get(parent)?.parentId ?? null;
          return typeof parent === 'string' ? parent : null;
        };
        for (const item of chosen) {
          const seen = new Set([item.id]);
          let parentId = parentOf(item);
          while (parentId) {
            if (seen.has(parentId))
              throw invalidField('parentId', 'Reviewed parent choices form a cycle');
            seen.add(parentId);
            const parent = all.find((i) => i.id === parentId);
            if (!parent || !linked.get(parentId)?.remoteId)
              throw invalidField(
                'parentId',
                'Reconcile every parent before updating this hierarchy',
              );
            updateItems.set(parentId, parent);
            parentId = parentOf(parent);
          }
        }
        const group = depthFirst([...updateItems.values()], parentOf);
        if (group.length > 1000)
          throw invalidField(
            'selection',
            'Updates plus ancestor context exceed 1,000 rows; reduce this selection',
          );
        const depth = (i: TransferItem): number => {
          const parent = updateItems.get(parentOf(i) ?? '');
          return parent ? depth(parent) + 1 : 1;
        };
        const maxDepth = Math.max(1, ...group.map(depth));
        const headers = [
          'ID',
          'Work Item Type',
          ...Array.from({ length: maxDepth }, (_, i) => `Title ${i + 1}`),
          'Description',
          'Assigned To',
          ...(configuration.state ? ['State'] : []),
          ...updateEnabled.map(([, h]) => h),
          ...p.constants.map((c) => c.header),
        ];
        const data = group.map((item) => {
          emitted.add(item.id);
          const link = linked.get(item.id)!,
            value = values.get(item.id) ?? localValues(item);
          const context = !chosenIds.has(item.id);
          if (context) {
            let previewRow = rows.find((r) => r.itemId === item.id);
            if (!previewRow) {
              previewRow = {
                index: rows.length,
                itemId: item.id,
                remoteId: link.remoteId,
                title: item.title,
                kind: 'context',
                selected: false,
                differences: [],
                warnings: [],
              };
              rows.push(previewRow);
            }
            previewRow.warnings.push(
              'Existing-ID hierarchy context preserves reviewed remote fields and counts toward this file limit.',
            );
            if (!previewRow.selected) previewRow.kind = 'context';
          }
          const raw = (link.observation as { raw?: Record<string, string> }).raw ?? {};
          const safe = (h: string, local: string): string => {
            if (!context) {
              if (raw[h] === undefined)
                throw invalidField(
                  'observation',
                  `A PM must review the ${h} column before it can be emitted in this update`,
                );
              return local;
            }
            if (
              !link.observedAt ||
              link.observationRevision !== destination.revision ||
              !request.freshnessAcknowledged ||
              raw[h] === undefined ||
              (['Work Item Type', 'State'].includes(h) && raw[h] === '')
            )
              throw invalidField(
                'context',
                `Existing update ancestor requires a fresh complete ${h} observation; reduce the profile or refresh it`,
              );
            return raw[h];
          };
          const remoteTitle = Object.entries(raw).find(
            ([h, v]) => /^Title(?: \d+)?$/u.test(h) && v,
          )?.[1];
          if (context && !remoteTitle)
            throw invalidField('context', 'Existing update ancestor title is missing');
          const single = (value.assigneeIds as string[] | undefined)?.[0];
          if (!context && single && !p.identities[single])
            throw invalidField(
              'Assigned To',
              'The final reviewed assignee needs an explicit outgoing identity mapping',
            );
          const finalType = value.type as ItemType;
          return [
            link.remoteId!,
            safe('Work Item Type', p.types[finalType]!),
            ...Array.from({ length: maxDepth }, (_, i) =>
              i + 1 === depth(item) ? (context ? remoteTitle! : String(value.title)) : '',
            ),
            safe(
              'Description',
              sanitizeRichText(String(value.description ?? '')) +
                (intents.find((i) => i.itemId === item.id)?.suffix ?? ''),
            ),
            safe('Assigned To', single ? (p.identities[single] ?? '') : ''),
            ...(configuration.state
              ? [
                  safe(
                    'State',
                    p.states[finalType][
                      value.status as keyof (typeof p.states)[typeof finalType]
                    ] ?? '',
                  ),
                ]
              : []),
            ...updateEnabled.map(([f, h]) => safe(h, rawValue(item, f, value))),
            ...p.constants.map((c) => safe(c.header, c.value)),
          ];
        });
        files.push({
          name: `update-${files.length + 1}.csv`,
          csv: writeCsv(headers, data),
          rows: data.length,
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'Cannot update CSV');
      }
    }
  }
  if (errors.length === 0)
    for (const row of rows)
      if (!row.selected && row.itemId && !emitted.has(row.itemId) && row.kind !== 'omitted') {
        row.kind = 'omitted';
        row.warnings.push('This local ancestor is not emitted after the reviewed parent choices.');
      }
  return { rows, files, intents, warnings, errors: [...new Set(errors)] };
}

function depthFirst(
  items: TransferItem[],
  parentOf: (item: TransferItem) => string | null,
): TransferItem[] {
  const byId = new Map(items.map((i) => [i.id, i])),
    children = new Map<string | null, TransferItem[]>();
  for (const i of items) {
    const parent = parentOf(i),
      key = parent && byId.has(parent) ? parent : null;
    const list = children.get(key) ?? [];
    list.push(i);
    children.set(key, list);
  }
  const result: TransferItem[] = [],
    seen = new Set<string>();
  const visit = (i: TransferItem): void => {
    if (seen.has(i.id)) throw invalidField('parentId', 'Hierarchy cycle');
    seen.add(i.id);
    result.push(i);
    for (const child of children.get(i.id) ?? []) visit(child);
  };
  for (const root of children.get(null) ?? []) visit(root);
  if (result.length !== items.length) throw invalidField('parentId', 'Hierarchy cycle');
  return result;
}

function footer(item: TransferItem, reference: string, notes: boolean): string {
  const escape = (s: string) =>
    s
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const details = [
    ...(item.checklist.length
      ? [
          `<p>Checklist (text only)</p><ul>${item.checklist.map((c) => `<li>${c.done ? '[x]' : '[ ]'} ${escape(c.text)}</li>`).join('')}</ul>`,
        ]
      : []),
    ...(item.assignees.length > 1
      ? [
          `<p>Local assignees (text only): ${item.assignees.map((a) => escape(a.projectMember.user.displayName)).join(', ')}</p>`,
        ]
      : []),
    ...(notes && item.notes.length
      ? [
          `<p>Notes (text only; original local authors)</p>${item.notes.map((n) => `<blockquote><p>${escape(n.author.displayName)}</p>${sanitizeRichText(n.body)}</blockquote>`).join('')}`,
        ]
      : []),
  ].join('');
  return `<hr /><p>Kloister transfer details (generated; not structured entities)</p>${details}<p>Kloister reference: ${reference}</p>`;
}
