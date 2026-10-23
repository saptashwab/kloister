import {
  type AdoDestinationDto,
  type AdoExportRequest,
  type AdoField,
  type AdoPreviewRow,
  type AdoReview,
  type ItemType,
} from '@kloister/shared';
import { invalidField } from '../common/api-exception.js';
import { sanitizeRichText } from '../common/sanitize-html.js';
import type { AdoItemLink } from '../generated/prisma/client.js';
import { writeCsv } from './csv.js';
import { selectItems } from './selection.js';
import {
  adoParent,
  differences,
  localValues,
  FIELD_NAMES,
  normalizeRow,
  tagLabel,
  type TransferItem,
  type TransferMember,
  type Values,
  validateChoices,
} from './transfer.js';
import { adoDate, sameValue } from './values.js';

const STATUS_NAMES: Record<string, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  BLOCKED: 'Blocked',
  DONE: 'Done',
};

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
  /** Fields an update file sends. */
  sent?: AdoField[];
}

/** Fields an update file can change, in column order. */
const UPDATE_FIELDS: AdoField[] = [
  'title',
  'description',
  'assigneeIds',
  'status',
  'priority',
  'labelIds',
  'sprintId',
  'startDate',
  'dueDate',
];

/**
 * Builds separate create and update files without changing local data or accepting incoming CSV.
 * Update files carry a field only when the local value is the one to send, so values Kloister
 * cannot represent (unmapped people, omitted tags, several remote states behind one status, Area
 * Path, embedded images) are never written back over ADO.
 * @param destination Scoped reviewed profile.
 * @param request Selection and file-only choices.
 * @param all Complete scoped project items.
 * @param links Scoped mappings with PM-reviewed observations.
 * @param metadata Existing project labels and sprints for reviewed outbound resolutions.
 * @param metadata.labels Existing project labels.
 * @param metadata.sprints Existing project sprints.
 * @param members Project members, used to read observed identities by email.
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
  members: TransferMember[] = [],
): {
  rows: AdoPreviewRow[];
  files: ExportFile[];
  intents: ExportIntent[];
  warnings: string[];
  errors: string[];
} {
  validateChoices(request.choices);
  const review: AdoReview = request.review ?? 'quick';
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
  const allById = new Map(all.map((i) => [i.id, i]));
  const linked = new Map(links.map((l) => [l.itemId, l]));
  const omitted = new Set(selection.items.filter((i) => p.types[i.type] === null).map((i) => i.id));
  const effectiveParent = (i: TransferItem): string | null => {
    let parent = byId.get(i.parentId ?? '');
    while (parent && omitted.has(parent.id)) parent = byId.get(parent.parentId ?? '');
    return parent?.id ?? null;
  };
  const usable = selection.items.filter((i) => !omitted.has(i.id));
  const newItems = usable.filter((i) => !linked.get(i.id)?.remoteId);
  // ADO files carry the calendar date only (SPEC §7.3); due times stay in Kloister.
  if (p.fields.dueDate && usable.some((i) => i.dueTime !== null))
    warnings.push('Due times are not exported; ADO receives the due date only.');
  const values = new Map<string, Values>();
  const updates: { item: TransferItem; fields: AdoField[]; raw: Record<string, string> }[] = [];
  const raws = (link: AdoItemLink | undefined): Record<string, string> =>
    (link?.observation as { raw?: Record<string, string> } | undefined)?.raw ?? {};
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
        `${item.title}: link the returned ID (or cancel its pending create in Transfer history) before issuing another create.`,
      );
    const current = localValues(item);
    const chosen = request.assignees[item.id];
    const assignees = item.assignees.map((a) => a.userId);
    if (chosen === undefined && assignees.length > 1)
      errors.push(`${item.title}: explicitly choose one remote assignee or unassigned.`);
    if (chosen !== undefined && chosen !== null && !assignees.includes(chosen))
      errors.push(`${item.title}: chosen assignee is not assigned locally.`);
    const person = chosen === undefined ? (assignees[0] ?? null) : chosen;
    current.assigneeIds = person === null ? [] : [person];
    if (assignees.length > 1)
      row.warnings.push(
        'Additional assignees rendered as text; returning CSV preserves native extra assignments.',
      );
    values.set(item.id, current);
    // Preview tokens carry no linking authority. Random issued references are reserved at prepare.
    const reference = link?.reference ?? `preview-${item.id}`;
    const suffix = footer(item, reference, request.selection.notes);
    if (!link?.remoteId) {
      intents.push({ itemId: item.id, values: current, suffix, reference, create: true });
      continue;
    }
    if (!selection.selected.has(item.id)) continue;
    if (!link.observedAt) {
      errors.push(
        `${item.title}: a PM must bring back a fresh ADO export of this item (Import, "Review remote observations") before it can be updated.`,
      );
      continue;
    }
    row.warnings.push(
      `Remote observed ${link.observedAt.toISOString()}; later remote edits cannot be detected.`,
    );
    const raw = raws(link);
    let remote: Values;
    try {
      remote = normalizeRow(raw, p, {
        current: item,
        link,
        lenient: true,
        members,
        warnings: row.warnings,
      });
    } catch (error) {
      errors.push(
        `${item.title}: ${error instanceof Error ? error.message : 'Invalid observation'}`,
      );
      continue;
    }
    delete remote.type;
    delete remote.bucketId;
    const observedParent = (link.observation as { values?: Values }).values?.parentId;
    // A promoted item (Basic) shows its nearest exported ancestor as parent in ADO.
    if (
      observedParent !== undefined &&
      observedParent !== item.parentId &&
      observedParent !== adoParent(item.parentId, allById, p)
    )
      row.warnings.push(
        'The parent differs from ADO. Update files do not move items; change the parent in ADO.',
      );
    row.differences = differences(current, remote, link, request.choices[item.id] ?? {}, review);
    // A column missing from the returned export hides any local change to that field.
    const columns: [AdoField, string | undefined][] = [
      ['description', 'Description'],
      ['status', 'State'],
      ['assigneeIds', 'Assigned To'],
      ['priority', p.fields.priority],
      ['labelIds', p.fields.labelIds],
      ['sprintId', p.fields.sprintId],
      ['startDate', p.fields.startDate],
      ['dueDate', p.fields.dueDate],
    ];
    const baseline = { ...(link.intent as Values), ...(link.localBaseline as Values) };
    for (const [field, header] of columns)
      if (
        header &&
        raw[header] === undefined &&
        field in baseline &&
        !sameValue(field, current[field], baseline[field])
      )
        row.warnings.push(
          `${FIELD_NAMES[field]} changed here, but the ADO export had no ${header} column; bring back an export with it to send this change.`,
        );
    const fields: AdoField[] = [];
    for (const d of row.differences) {
      const name = FIELD_NAMES[d.field];
      const images = d.field === 'description' && /<img\b/iu.test(raw['Description'] ?? '');
      if (d.choice === undefined || (images && d.auto && d.choice === 'local')) {
        errors.push(
          `${item.title}: choose what to send for ${name}${
            d.conflict
              ? ' (changed on both sides)'
              : images
                ? ' (sending it replaces the ADO description and its embedded images)'
                : ''
          }.`,
        );
        continue;
      }
      if (d.choice !== 'local') continue;
      const type = item.type;
      if (d.field === 'status' && p.states[type][item.status] === null) {
        row.warnings.push(
          `${STATUS_NAMES[item.status]} has no ADO state for this type; the ADO state is kept.`,
        );
        continue;
      }
      if (
        (d.field === 'startDate' || d.field === 'dueDate') &&
        (!p.fields[d.field] || !p.dateTypes[d.field]?.includes(type))
      ) {
        row.warnings.push(`${name} is not confirmed for this type and is not sent.`);
        continue;
      }
      if (
        (d.field === 'priority' || d.field === 'labelIds' || d.field === 'sprintId') &&
        !p.fields[d.field]
      )
        continue;
      if (images)
        row.warnings.push(
          'Sending the description replaces the ADO description, including its embedded images.',
        );
      fields.push(d.field);
    }
    row.changes = fields;
    if (fields.length === 0) {
      row.kind = 'unchanged';
      continue;
    }
    updates.push({ item, fields, raw });
    intents.push({
      itemId: item.id,
      values: current,
      suffix,
      reference,
      create: false,
      sent: fields,
    });
  }
  const suffixOf = (id: string): string => intents.find((i) => i.itemId === id)?.suffix ?? '';
  const identity = (item: TransferItem, person: string | undefined): string => {
    if (!person) return '';
    if (p.identities[person]) return p.identities[person];
    const user = item.assignees.find((a) => a.userId === person)?.projectMember.user;
    if (!user) throw invalidField('Assigned To', 'Chosen assignee is not on this item');
    return `${user.displayName} <${user.email}>`;
  };
  const labelNames = (ids: string[]): string[] =>
    ids.map((id) => {
      const name = metadata.labels.find((l) => l.id === id)?.name;
      if (!name || name.includes(';'))
        throw invalidField('Tags', 'Label cannot be represented as a semicolon-delimited tag');
      return name;
    });
  const iteration = (item: TransferItem, sprintId: unknown): string => {
    const sprint = metadata.sprints.find((s) => s.id === sprintId);
    if (sprintId && !sprint) throw invalidField('sprintId', 'Chosen sprint is unavailable');
    if (sprint && !sprint.adoIterationPath && !p.iterationRoot)
      warnings.push(
        `${item.title}: iteration path is missing and will use the destination default.`,
      );
    return sprint
      ? (sprint.adoIterationPath ?? (p.iterationRoot ? `${p.iterationRoot}\\${sprint.name}` : ''))
      : '';
  };
  const createValue = (item: TransferItem, field: string, value: Values): string => {
    switch (field) {
      case 'priority':
        return String(value.priority ?? item.priority);
      case 'labelIds':
        return labelNames((value.labelIds as string[]) ?? []).join('; ');
      case 'sprintId':
        return iteration(item, value.sprintId);
      case 'area':
        return p.area;
      case 'startDate':
      case 'dueDate':
        return adoDate(value[field] as string | null);
      default:
        return '';
    }
  };
  const files: ExportFile[] = [];
  const emitted = new Set<string>();
  const enabled = Object.entries(p.fields);
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
      const contextRows = group.some((i) => linked.get(i.id)?.remoteId);
      const dated = (field: string, i: TransferItem): boolean =>
        p.dateTypes[field as 'startDate' | 'dueDate']?.includes(i.type) ?? false;
      // A blank cell on a new row sets nothing, so undated types simply leave it empty. Existing
      // context rows would need their ADO value, so mixed files keep the stricter rule.
      const createEnabled = enabled.filter(
        ([field]) =>
          !['startDate', 'dueDate'].includes(field) ||
          (contextRows ? group.every((i) => dated(field, i)) : group.some((i) => dated(field, i))),
      );
      if (createEnabled.length !== enabled.length)
        warnings.push(
          'Optional dates omitted from this create file because an existing parent in it has no confirmed date support.',
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
        const raw = raws(link);
        const get = (header: string, local: string): string => {
          if (!context) return local;
          if (!link?.observedAt || !request.freshnessAcknowledged)
            throw invalidField(
              'context',
              'Existing parent context needs a fresh reviewed ADO export and freshness acknowledgement',
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
        const row = rows.find((r) => r.itemId === item.id);
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
          if (row && !row.selected) row.kind = 'context';
          row?.warnings.push(
            'ID-bearing ancestor context preserves reviewed remote values; this row never recreates the parent.',
          );
        } else {
          const parent = byId.get(effectiveParent(item) ?? '');
          if (parent && !backlogParent(p.process, parent.type, item.type))
            row?.warnings.push(
              `ADO backlogs do not normally nest a ${p.types[item.type]} under a ${p.types[parent.type]}; the link is kept but the item may not show under its parent on ADO boards.`,
            );
        }
        return [
          ...(mixed ? [link?.remoteId ?? ''] : []),
          get('Work Item Type', p.types[item.type]!),
          ...Array.from({ length: max }, (_, i) =>
            i + 1 === depth(item) ? (context ? remoteTitle! : String(value.title)) : '',
          ),
          get('Description', sanitizeRichText(String(value.description ?? '')) + suffixOf(item.id)),
          ...createEnabled.map(([f, h]) =>
            get(
              h,
              ['startDate', 'dueDate'].includes(f) && !dated(f, item)
                ? ''
                : createValue(item, f, value),
            ),
          ),
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
  if (updates.length && !request.freshnessAcknowledged)
    errors.push('Acknowledge observation freshness before preparing linked updates.');
  // One file per set of changed columns, so no row has to repeat or blank a column it does not change.
  const signatures = new Map<string, typeof updates>();
  for (const update of updates) {
    const key = UPDATE_FIELDS.filter((f) => update.fields.includes(f)).join(',');
    signatures.set(key, [...(signatures.get(key) ?? []), update]);
  }
  for (const [key, group] of signatures) {
    const fields = key.split(',') as AdoField[];
    const header = (field: AdoField): string =>
      field === 'title'
        ? 'Title'
        : field === 'description'
          ? 'Description'
          : field === 'assigneeIds'
            ? 'Assigned To'
            : field === 'status'
              ? 'State'
              : p.fields[field as 'priority' | 'labelIds' | 'sprintId' | 'startDate' | 'dueDate']!;
    for (let offset = 0; offset < group.length; offset += 1000) {
      try {
        const chunk = group.slice(offset, offset + 1000);
        const headers = [
          'ID',
          'Work Item Type',
          'Title',
          ...fields.filter((f) => f !== 'title').map(header),
        ];
        const data = chunk.map(({ item, raw }) => {
          emitted.add(item.id);
          const value = values.get(item.id)!;
          const type = raw['Work Item Type'];
          const remoteTitle = Object.entries(raw).find(
            ([h, v]) => /^Title(?: \d+)?$/u.test(h) && v,
          )?.[1];
          if (!type || !remoteTitle)
            throw invalidField(
              'observation',
              `${item.title}: the ADO export must include Work Item Type and Title`,
            );
          const cell = (field: AdoField): string => {
            switch (field) {
              case 'description':
                return sanitizeRichText(String(value.description ?? '')) + suffixOf(item.id);
              case 'assigneeIds':
                return identity(item, (value.assigneeIds as string[])[0]);
              case 'status':
                return p.states[item.type][item.status] ?? '';
              case 'priority':
                return String(value.priority);
              case 'labelIds': {
                // Keep every ADO tag that still means something here, in ADO's own spelling:
                // tags without a label, and tags whose label stays on the item.
                const wanted = new Set(value.labelIds as string[]);
                const covered = new Set<string>();
                const kept = (raw[p.fields.labelIds!] ?? '')
                  .split(';')
                  .map((t) => t.trim())
                  .filter((tag) => {
                    if (!tag) return false;
                    const mapped = tagLabel(p, tag);
                    if (!mapped) return true;
                    if (!wanted.has(mapped)) return false;
                    covered.add(mapped);
                    return true;
                  });
                const lower = new Set(kept.map((t) => t.toLowerCase()));
                const added = labelNames([...wanted].filter((id) => !covered.has(id))).filter(
                  (name) => !lower.has(name.toLowerCase()),
                );
                return [...kept, ...added].join('; ');
              }
              case 'sprintId':
                return iteration(item, value.sprintId);
              case 'startDate':
              case 'dueDate':
                return adoDate(value[field] as string | null);
              default:
                return '';
            }
          };
          return [
            linked.get(item.id)!.remoteId!,
            type,
            fields.includes('title') ? String(value.title) : remoteTitle,
            ...fields.filter((f) => f !== 'title').map(cell),
          ];
        });
        files.push({
          name: `update-${files.length + 1}.csv`,
          csv: writeCsv(headers, data),
          rows: data.length,
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'Cannot create update CSV');
      }
    }
  }
  if (
    files.some((f) => f.csv.split('\r\n').some((line) => /(?:^|,)"[\s\uFEFF]*[+\-@]/u.test(line)))
  )
    warnings.push(
      'Some cells start with +, - or @. ADO imports them as text; do not open transfer files in a spreadsheet, which may treat them as formulas.',
    );
  if (errors.length === 0)
    for (const row of rows)
      if (!row.selected && row.itemId && !emitted.has(row.itemId) && row.kind !== 'omitted') {
        row.kind = 'omitted';
        row.warnings.push('This local ancestor is not emitted after the reviewed parent choices.');
      }
  return { rows, files, intents, warnings, errors: [...new Set(errors)] };
}

/**
 * Whether ADO's default backlogs show this child under this parent. Kloister also allows a
 * Task directly under a Feature, which ADO links but does not show on its backlogs.
 * @param process Destination process.
 * @param parent Local parent type.
 * @param child Local child type.
 * @returns True for relations the default backlogs display.
 */
function backlogParent(process: string, parent: ItemType, child: ItemType): boolean {
  if (child === 'TASK' && parent === 'FEATURE') return false;
  // Basic maps Story and Bug to Issue, so an Issue under an Issue is not a backlog relation.
  if (process === 'Basic' && parent === 'STORY') return child === 'TASK';
  return true;
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
