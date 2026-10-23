import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADO_LIMITS,
  adoPreset,
  adoSuggestStatus,
  type AdoDestinationDto,
  type AdoExportRequest,
  type AdoImportRequest,
  ItemType,
} from '@kloister/shared';
import type { AdoItemLink } from '../generated/prisma/client.js';
import { readCsv, remoteId, writeCsv } from './csv.js';
import { preset, validateProfile } from './profiles.js';
import { selectItems } from './selection.js';
import { exportPlan } from './export.js';
import { adoParent, incomingPlan, localValues, type TransferItem } from './transfer.js';
import { adoDate, parseAdoDate, stripFooter } from './values.js';

const bucket = '11111111-1111-4111-8111-111111111111';
function destination(): AdoDestinationDto {
  const profile = preset('Agile');
  profile.fields = {};
  profile.reverseTypes = { Task: 'TASK', Feature: 'FEATURE', 'User Story': 'STORY' };
  profile.incomingStates = {
    'Task\nNew': { status: 'NOT_STARTED', bucketId: bucket },
    'Task\n': { status: 'NOT_STARTED', bucketId: bucket },
    'Feature\nNew': { status: 'NOT_STARTED', bucketId: bucket },
  };
  return {
    id: randomUUID(),
    organization: 'collection',
    remoteProject: 'remote',
    profile,
    revision: 1,
    requireDetailedReview: false,
  };
}
function item(id: string, type: ItemType = 'TASK', parentId: string | null = null): TransferItem {
  return {
    id,
    projectId: 'project',
    number: Number(id) || 1,
    title: `Item ${id}`,
    type,
    status: 'NOT_STARTED',
    description: '<p>Hello Ω 😀</p>',
    parentId,
    bucketId: bucket,
    sprintId: null,
    teamId: null,
    startDate: null,
    dueDate: null,
    dueTime: null,
    priority: 2,
    assignees: [],
    labels: [],
    checklist: [],
    notes: [],
    attachments: [],
    sprint: null,
    createdById: 'pm',
    position: 1,
    completedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}
function outgoing(): AdoExportRequest {
  return {
    selection: {
      scope: 'project',
      ancestors: true,
      excludeDone: false,
      notes: false,
      labelIds: [],
      labelMode: 'any',
    },
    assignees: {},
    choices: {},
    freshnessAcknowledged: true,
  };
}
function incoming(csv: string): AdoImportRequest {
  return {
    csv,
    mode: 'import',
    selectedRows: null,
    destinationAcknowledged: true,
    manualLinks: {},
    confirmedNew: ['21', '22'],
    omittedParents: [],
    choices: {},
    types: {},
    createLabels: [],
    idempotencyKey: randomUUID(),
  };
}
function link(itemId: string, fields: Partial<AdoItemLink> = {}): AdoItemLink {
  return {
    id: randomUUID(),
    destinationId: 'destination',
    projectId: 'project',
    itemId,
    reference: 'a'.repeat(64),
    remoteId: '21',
    tombstonedAt: null,
    localBaseline: {},
    remoteBaseline: {},
    observation: {
      raw: {
        'Work Item Type': 'Task',
        Description: '<p>remote</p>',
        'Assigned To': '',
        State: 'New',
      },
      values: { parentId: null },
    },
    observedAt: new Date(0),
    observationRevision: 1,
    pendingBatchId: null,
    generatedSuffix: '',
    intent: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...fields,
  };
}

describe('documented independent CSV contracts', () => {
  it('reads a hand-authored Unicode multiline HTML fixture with CRLF/BOM and quoted commas', () => {
    const text =
      '\uFEFFID,Work Item Type,Title,Description\r\n21,Task,"Plan, Ω 😀","<p>First</p>\r\n<p>Say ""hello""</p>"\r\n';
    expect(readCsv(text).rows).toEqual([
      {
        ID: '21',
        'Work Item Type': 'Task',
        Title: 'Plan, Ω 😀',
        Description: '<p>First</p>\r\n<p>Say "hello"</p>',
      },
    ]);
  });
  it.each([
    'Work Item Type,Title,Title\nTask,A,B',
    'Work Item Type,title,Title\nTask,A,B',
    'Title\nA',
    'Work Item Type,Title\nTask,"unclosed',
    'Work Item Type,Title\nTask,"closed"junk',
    'Work Item Type,Title\nTask,wrong"quote',
    'Work Item Type,Title\nTask,A,extra',
    'Work Item Type,Title\nTask,\u0000',
    'Work Item Type,Title\nTask,\uD800',
  ])('rejects malformed input %j', (text) => {
    expect(() => readCsv(text)).toThrow();
  });
  it.each(['=1+1', ' =HYPERLINK("x")', '\t=SUM(1)'])(
    'blocks formula-like output without silently changing data: %s',
    (text) => {
      expect(() => writeCsv(['Work Item Type', 'Title'], [['Task', text]])).toThrow(/Formula/);
    },
  );
  it.each(['- fix login', '+1 for this', '@team review'])(
    'keeps ordinary text that ADO imports as text: %s',
    (text) => {
      expect(writeCsv(['Work Item Type', 'Title'], [['Task', text]])).toContain(text);
    },
  );
  it('writes the exact independent BOM/CRLF/RFC4180 expectation', () => {
    expect(writeCsv(['Work Item Type', 'Title'], [['Task', 'A, "B"']])).toBe(
      '\uFEFF"Work Item Type","Title"\r\n"Task","A, ""B"""\r\n',
    );
  });
  it('rejects row/cell/file excess without truncating', () => {
    expect(() => readCsv('Work Item Type,Title\n' + Array(1001).fill('Task,A').join('\n'))).toThrow(
      /1,000/,
    );
    expect(() =>
      readCsv('Work Item Type,Title\nTask,' + 'x'.repeat(ADO_LIMITS.cellBytes + 1)),
    ).toThrow(/1 MiB/);
    expect(() => readCsv('x'.repeat(ADO_LIMITS.uploadBytes + 1))).toThrow(/10 MiB/);
  });
  it('preserves remote IDs beyond safe integer range and rejects ambiguous forms', () => {
    expect(remoteId('9007199254740993')).toBe('9007199254740993');
    for (const id of ['0', '01', '-1', '1e3', ' 1', '1.5']) expect(() => remoteId(id)).toThrow();
  });
});

describe('reviewed profiles and complete selection', () => {
  it.each(['Basic', 'Agile', 'Scrum', 'CMMI', 'Custom'] as const)(
    'keeps %s explicit, reverse mappings and dates disabled',
    (process) => {
      const p = validateProfile(preset(process));
      expect(p.process).toBe(process);
      expect(p.reverseTypes).toEqual({});
      expect(p.dateTypes).toEqual({});
      expect(p.fields.dueDate).toBeUndefined();
    },
  );
  it('rejects reserved or duplicate constant columns including Description', () => {
    const p = preset('Agile');
    p.constants = [{ header: 'Description', value: 'bad' }];
    expect(() => validateProfile(p)).toThrow();
    p.constants = [{ header: 'Tags', value: 'bad' }];
    expect(() => validateProfile(p)).toThrow();
  });
  it('selects any/all labels, adds only ancestors, and only expands descendants in subtree mode', () => {
    const items = [
      item('1', 'FEATURE'),
      item('2', 'STORY', '1'),
      item('3', 'TASK', '2'),
      item('4', 'TASK', '2'),
    ];
    items[2].labels = [{ labelId: 'red' }, { labelId: 'blue' }] as TransferItem['labels'];
    items[3].labels = [{ labelId: 'red' }] as TransferItem['labels'];
    const s = outgoing().selection;
    s.scope = 'manual';
    s.itemIds = ['3'];
    expect(selectItems(items, s).items.map((i) => i.id)).toEqual(['1', '2', '3']);
    s.ancestors = false;
    expect(selectItems(items, s).items.map((i) => i.id)).toEqual(['3']);
    s.scope = 'project';
    s.labelIds = ['red', 'blue'];
    s.labelMode = 'all';
    expect(selectItems(items, s).items.map((i) => i.id)).toEqual(['3']);
    s.labelMode = 'any';
    expect(selectItems(items, s).items.map((i) => i.id)).toEqual(['3', '4']);
    s.scope = 'subtree';
    s.rootId = '2';
    s.labelIds = [];
    expect(selectItems(items, s).items.map((i) => i.id)).toEqual(['2', '3', '4']);
  });
});

const mia = '22222222-2222-4222-8222-222222222222';
const labelA = '33333333-3333-4333-8333-333333333333';
const labelB = '44444444-4444-4444-8444-444444444444';
const members = [{ userId: mia, email: 'member@example.org', displayName: 'Mia Member' }];
function assign(target: TransferItem, userId = mia): TransferItem {
  target.assignees = [
    {
      userId,
      projectMember: { user: { displayName: 'Mia Member', email: 'member@example.org' } },
    },
  ] as unknown as TransferItem['assignees'];
  return target;
}
/** A linked item whose last sync confirmed `synced` on both sides and whose ADO export is `raw`. */
function synced(
  target: TransferItem,
  raw: Record<string, string>,
  values: Record<string, unknown> = {},
): AdoItemLink {
  const baseline = {
    title: target.title,
    description: target.description,
    status: target.status,
    priority: target.priority,
    assigneeIds: target.assignees.map((a) => a.userId),
    labelIds: target.labels.map((l) => l.labelId),
    sprintId: target.sprintId,
    startDate: null,
    dueDate: null,
    ...values,
  };
  return link(target.id, {
    localBaseline: baseline,
    remoteBaseline: baseline,
    observation: {
      raw: { 'Work Item Type': 'Task', Title: target.title, ...raw },
      values: { parentId: target.parentId },
    },
  });
}

describe('outgoing creates and hierarchy', () => {
  it('emits true depth-first hierarchy independently of item creation/number order', () => {
    const plan = exportPlan(
      destination(),
      outgoing(),
      [
        item('1', 'FEATURE'),
        item('2', 'STORY', '1'),
        item('3', 'STORY', '1'),
        item('4', 'TASK', '2'),
      ],
      [],
    );
    expect(plan.errors).toEqual([]);
    const table = readCsv(plan.files[0].csv);
    expect(table.headers).not.toContain('ID');
    expect(table.headers).not.toContain('State');
    expect(table.headers).not.toContain('Assigned To');
    expect(table.rows.map((r) => [r['Title 1'], r['Title 2'], r['Title 3']])).toEqual([
      ['Item 1', '', ''],
      ['', 'Item 2', ''],
      ['', '', 'Item 4'],
      ['', 'Item 3', ''],
    ]);
  });
  it('blocks a single oversized tree and splits separate complete trees without losing rows', () => {
    const all = [
      item('1', 'FEATURE'),
      ...Array.from({ length: 1000 }, (_, i) => item(String(i + 2), 'STORY', '1')),
    ];
    expect(exportPlan(destination(), outgoing(), all, []).errors.join()).toMatch(
      /single create tree/,
    );
    const flat = Array.from({ length: 1001 }, (_, i) => item(String(i + 1)));
    expect(exportPlan(destination(), outgoing(), flat, []).files.map((f) => f.rows)).toEqual([
      1000, 1,
    ]);
  });
  it('never reissues pending creates and previews Basic flattening', () => {
    expect(
      exportPlan(
        destination(),
        outgoing(),
        [item('1')],
        [link('1', { remoteId: null, pendingBatchId: randomUUID() })],
      ).errors.join(),
    ).toMatch(/link the returned ID/);
    const d = destination();
    d.profile = preset('Basic');
    d.profile.fields = {};
    const plan = exportPlan(d, outgoing(), [item('1', 'EPIC'), item('2', 'FEATURE', '1')], []);
    expect(plan.rows[0].kind).toBe('omitted');
    expect(readCsv(plan.files[0].csv).rows[0]['Work Item Type']).toBe('Epic');
  });
  it('preserves fresh real-ID ancestor context and blocks missing context columns', () => {
    const parent = item('1', 'FEATURE'),
      child = item('2', 'STORY', '1');
    const l = link('1', {
      observation: {
        raw: { 'Work Item Type': 'Feature', Title: 'REMOTE PARENT', Description: '<p>remote</p>' },
        values: { parentId: null },
      },
    });
    const req = outgoing();
    req.selection.scope = 'manual';
    req.selection.itemIds = ['2'];
    let plan = exportPlan(destination(), req, [parent, child], [l]);
    expect(plan.errors).toEqual([]);
    expect(readCsv(plan.files[0].csv).rows.map((r) => r['ID'])).toEqual(['21', '']);
    expect(readCsv(plan.files[0].csv).rows[0]['Title 1']).toBe('REMOTE PARENT');
    l.observation = {
      raw: { Title: 'REMOTE PARENT', 'Work Item Type': 'Feature' },
      values: { parentId: null },
    };
    plan = exportPlan(destination(), req, [parent, child], [l]);
    expect(plan.errors.join()).toMatch(/Description/);
  });
  it('writes dates in the ISO form ADO imports under any locale', () => {
    const d = destination();
    d.profile.fields = { dueDate: 'Target Date' };
    d.profile.dateTypes = { dueDate: ['TASK'] };
    const task = item('1');
    task.dueDate = new Date('2026-12-24T00:00:00Z');
    const table = readCsv(exportPlan(d, outgoing(), [task], []).files[0].csv);
    expect(table.rows[0]['Target Date']).toBe('2026-12-24T12:00:00Z');
  });
  it('sends only the due date and warns that due times stay in Kloister', () => {
    const d = destination();
    d.profile.fields = { dueDate: 'Target Date' };
    d.profile.dateTypes = { dueDate: ['TASK'] };
    const task = item('1');
    task.dueDate = new Date('2026-12-24T00:00:00Z');
    task.dueTime = 17 * 60;
    const plan = exportPlan(d, outgoing(), [task], []);
    expect(plan.warnings.join()).toMatch(/Due times are not exported/);
    expect(readCsv(plan.files[0].csv).rows[0]['Target Date']).toBe('2026-12-24T12:00:00Z');
  });
  it('warns when a Task sits directly under a Feature, which ADO backlogs do not show', () => {
    const plan = exportPlan(
      destination(),
      outgoing(),
      [item('1', 'FEATURE'), item('2', 'TASK', '1')],
      [],
    );
    expect(plan.rows.find((r) => r.itemId === '2')!.warnings.join()).toMatch(
      /do not normally nest/,
    );
  });
});

describe('outgoing updates send only real local changes', () => {
  it('sends just the changed title, with flat ID/type/title columns', () => {
    const task = item('1');
    const l = synced(task, { Description: '<p>Hello Ω 😀 </p>', State: 'New' });
    task.title = 'Renamed locally';
    const plan = exportPlan(destination(), outgoing(), [task], [l], undefined, members);
    expect(plan.errors).toEqual([]);
    const table = readCsv(plan.files[0].csv);
    expect(table.headers).toEqual(['ID', 'Work Item Type', 'Title']);
    expect(table.rows).toEqual([{ ID: '21', 'Work Item Type': 'Task', Title: 'Renamed locally' }]);
    expect(plan.files[0].name).toMatch(/^update-/);
  });
  it('treats ADO HTML normalization as no change and leaves unchanged items out', () => {
    const task = item('1');
    const l = synced(task, { Description: '<p>Hello Ω 😀 </p>', 'Assigned To': '', State: 'New' });
    const plan = exportPlan(destination(), outgoing(), [task], [l], undefined, members);
    expect(plan.files).toEqual([]);
    expect(plan.rows[0].kind).toBe('unchanged');
  });
  it('never clears an ADO assignee that has no local member', () => {
    const task = item('1');
    const l = synced(task, { 'Assigned To': 'Outside Person <outside@example.org>' });
    const plan = exportPlan(destination(), outgoing(), [task], [l], undefined, members);
    expect(plan.files).toEqual([]);
    expect(plan.rows[0].warnings.join()).toMatch(/not mapped to a project member/);
  });
  it('keeps unmapped and omitted ADO tags when the local labels change', () => {
    const d = destination();
    d.profile.fields = { labelIds: 'Tags' };
    d.profile.tags = { Mapped: labelA, Ignored: null };
    const task = item('1');
    task.labels = [{ labelId: labelA }] as TransferItem['labels'];
    const l = synced(task, { Tags: 'Ignored; Mapped; Unknown' });
    task.labels = [{ labelId: labelA }, { labelId: labelB }] as TransferItem['labels'];
    const labels = [
      { id: labelA, name: 'Mapped' },
      { id: labelB, name: 'Second' },
    ];
    const plan = exportPlan(d, outgoing(), [task], [l], { labels, sprints: [] }, members);
    expect(plan.errors).toEqual([]);
    expect(readCsv(plan.files[0].csv).rows[0]['Tags']).toBe('Ignored; Mapped; Unknown; Second');
  });
  it('does not regress a remote state that maps to the same local status', () => {
    const d = destination();
    d.profile.states.TASK = {
      NOT_STARTED: 'New',
      IN_PROGRESS: 'Active',
      BLOCKED: null,
      DONE: 'Closed',
    };
    d.profile.incomingStates['Task\nResolved'] = { status: 'IN_PROGRESS', bucketId: bucket };
    const task = item('1');
    task.status = 'IN_PROGRESS';
    const l = synced(task, { State: 'Resolved' });
    expect(exportPlan(d, outgoing(), [task], [l], undefined, members).files).toEqual([]);
  });
  it('sends the intended state and assignee after link-only reconciliation', () => {
    const d = destination();
    d.profile.states.TASK.IN_PROGRESS = 'Active';
    const task = assign(item('1'));
    task.status = 'IN_PROGRESS';
    const l = link('1', {
      intent: {
        title: 'Item 1',
        description: task.description,
        status: 'IN_PROGRESS',
        assigneeIds: [mia],
      },
      observation: {
        raw: { 'Work Item Type': 'Task', Title: 'Item 1', State: 'New', 'Assigned To': '' },
        values: { parentId: null },
      },
    });
    const plan = exportPlan(d, outgoing(), [task], [l], undefined, members);
    expect(plan.errors).toEqual([]);
    expect(readCsv(plan.files[0].csv).rows[0]).toMatchObject({
      'Assigned To': 'Mia Member <member@example.org>',
      State: 'Active',
    });
  });
  it('asks only about fields changed on both sides in Quick review, and about all in Detailed', () => {
    const task = item('1');
    const l = synced(task, { Title: 'Remote rename' });
    task.title = 'Local rename';
    let plan = exportPlan(destination(), outgoing(), [task], [l], undefined, members);
    expect(plan.errors.join()).toMatch(/changed on both sides/);
    const request = outgoing();
    request.choices['1'] = { title: 'local' };
    plan = exportPlan(destination(), request, [task], [l], undefined, members);
    expect(readCsv(plan.files[0].csv).rows[0]['Title']).toBe('Local rename');
    const other = item('2');
    other.title = 'Only local';
    const detailed = outgoing();
    detailed.review = 'detailed';
    plan = exportPlan(
      destination(),
      detailed,
      [other],
      [synced(item('2'), { Title: 'Item 2' })],
      undefined,
      members,
    );
    expect(plan.errors.join()).toMatch(/choose what to send for Title/);
  });
  it('keeps a newer ADO value in Quick review when only ADO changed', () => {
    const task = item('1');
    const l = synced(task, { Title: 'Renamed in ADO' });
    const plan = exportPlan(destination(), outgoing(), [task], [l], undefined, members);
    expect(plan.errors).toEqual([]);
    expect(plan.files).toEqual([]);
    expect(plan.rows[0].differences[0]).toMatchObject({
      field: 'title',
      choice: 'incoming',
      auto: true,
    });
  });
  it('requires a returned observation and warns about local parent changes', () => {
    const task = item('1', 'TASK', 'p');
    expect(
      exportPlan(
        destination(),
        outgoing(),
        [item('p', 'STORY'), task],
        [link('1', { observedAt: null })],
      ).errors.join(),
    ).toMatch(/fresh ADO export/);
    const l = synced(task, {}, {});
    (l.observation as { values: Record<string, unknown> }).values['parentId'] = null;
    const plan = exportPlan(
      destination(),
      outgoing(),
      [item('p', 'STORY'), task],
      [l],
      undefined,
      members,
    );
    expect(plan.rows.find((r) => r.itemId === '1')!.warnings.join()).toMatch(
      /change the parent in ADO/,
    );
  });
});

describe('incoming explicit review, provenance and tombstones', () => {
  it('requires acknowledgement when a project name is present but collection provenance is absent', () => {
    const request = incoming('ID,Work Item Type,Title,Team Project\n21,Task,Example,remote');
    request.destinationAcknowledged = false;
    expect(incomingPlan(destination(), request, [], []).errors.join()).toMatch(
      /complete destination provenance/,
    );
  });
  const csv = 'ID,Work Item Type,Title,State,Description\n21,Task,Remote title,New,<p>remote</p>\n';
  it('requires explicit new confirmation and choices, preserving omitted fields', () => {
    const r = incoming(csv),
      d = destination();
    r.confirmedNew = [];
    expect(incomingPlan(d, r, [], []).errors.join()).toMatch(/confirmation as new/);
    r.confirmedNew = ['21'];
    r.review = 'detailed';
    const preview = incomingPlan(d, r, [], []);
    expect(preview.rows[0].differences.map((f) => f.field)).not.toContain('assigneeIds');
    expect(preview.errors.join()).toMatch(/require reviewed title/);
  });
  it('rejects duplicate IDs, foreign provenance and unknown markers before applying any row', () => {
    const d = destination();
    expect(() => incomingPlan(d, incoming(csv + '21,Task,Duplicate,New,\n'), [], [])).toThrow(
      /Duplicate/,
    );
    expect(() =>
      incomingPlan(d, incoming('ID,Work Item Type,Title,Team Project\n21,Task,A,foreign'), [], []),
    ).toThrow(/different project/);
    expect(() =>
      incomingPlan(
        d,
        incoming(
          `ID,Work Item Type,Title,Description\n21,Task,A,Kloister reference: ${'f'.repeat(64)}`,
        ),
        [],
        [],
      ),
    ).toThrow(/Unknown/);
  });
  it('requires destination acknowledgement without provenance and never resurrects tombstones', () => {
    const r = incoming(csv);
    r.destinationAcknowledged = false;
    expect(incomingPlan(destination(), r, [], []).errors.join()).toMatch(/Acknowledge/);
    r.destinationAcknowledged = true;
    expect(
      incomingPlan(
        destination(),
        r,
        [],
        [link('gone', { tombstonedAt: new Date() })],
      ).errors.join(),
    ).toMatch(/tombstone/);
  });
  it('does not import unselected parents and accepts explicit hierarchy omission', () => {
    const r = incoming(
      'ID,Work Item Type,Title 1,Title 2,State\n21,Feature,Parent,,New\n22,Task,,Child,New',
    );
    r.selectedRows = [1];
    expect(incomingPlan(destination(), r, [], []).errors.join()).toMatch(
      /Include the parent explicitly/,
    );
    r.omittedParents = ['22'];
    const plan = incomingPlan(destination(), r, [], []);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].incoming.parentId).toBeNull();
  });
  it('link-only records first-return defaults without producing local changes', () => {
    const d = destination(),
      local = item('1');
    local.status = 'BLOCKED';
    const l = link('1', { remoteId: null, pendingBatchId: randomUUID() });
    const r = incoming(
      `ID,Work Item Type,Title,State,Description\n21,Task,A,New,Kloister reference: ${l.reference}`,
    );
    r.mode = 'reconcile';
    const plan = incomingPlan(d, r, [local], [l]);
    expect(plan.errors).toEqual([]);
    expect(plan.operations[0].changes).toEqual({});
    expect(plan.operations[0].incoming.status).toBe('NOT_STARTED');
  });
  it('sanitizes malicious HTML without fetching resources', () => {
    const r = incoming(
      'ID,Work Item Type,Title,Description\n21,Task,A,<script>bad()</script><img src=https://invalid.test/x><p>safe</p>',
    );
    const plan = incomingPlan(destination(), r, [], []);
    expect(plan.operations[0].incoming.description).toBe('<p>safe</p>');
    expect(plan.rows[0].warnings.join()).toMatch(/resources are never fetched/);
  });
  it('removes normalized generated blocks only for a validated scoped reference', () => {
    const d = destination(),
      local = item('1'),
      l = link('1');
    l.generatedSuffix = `<hr /><p>Kloister transfer details (generated; not structured entities)</p><p>Kloister reference: ${l.reference}</p>`;
    const text = `<p>User content</p>${l.generatedSuffix}  `;
    const r = incoming(`ID,Work Item Type,Title,Description\n21,Task,A,${text}`);
    expect(incomingPlan(d, r, [local], [l]).operations[0].incoming.description).toBe(
      '<p>User content</p>',
    );
  });
});

describe('real ADO export formats', () => {
  const fixture = (name: string): string =>
    readFileSync(join(process.cwd(), 'test/fixtures/ado', name), 'utf8');
  function agile(): AdoDestinationDto {
    const d = destination();
    d.profile.fields = {
      priority: 'Priority',
      labelIds: 'Tags',
      startDate: 'Start Date',
      dueDate: 'Target Date',
    };
    d.profile.dateTypes = { startDate: ['EPIC'], dueDate: ['EPIC'] };
    d.profile.dateOrder = 'DMY';
    d.profile.reverseTypes = {
      Epic: 'EPIC',
      Feature: 'FEATURE',
      'User Story': 'STORY',
      Task: 'TASK',
      Bug: 'BUG',
    };
    for (const [type, states] of Object.entries({
      Epic: ['New'],
      Feature: ['Active'],
      'User Story': ['Resolved', 'Closed'],
      Task: ['Active'],
      Bug: ['New'],
    }))
      for (const state of states)
        d.profile.incomingStates[`${type}\n${state}`] = { status: 'NOT_STARTED', bucketId: bucket };
    d.profile.tags = { payments: null, q4: null, customer: null, frontend: null, backend: null };
    return d;
  }
  it('reads an Agile tree export: LF lines, locale dates with time, identities and hierarchy', () => {
    const r = incoming(fixture('agile-tree.csv'));
    r.confirmedNew = ['1', '2', '3', '4', '5', '6'];
    const plan = incomingPlan(agile(), r, [], [], undefined, members);
    expect(plan.errors).toEqual([]);
    const epic = plan.operations.find((o) => o.remoteId === '1')!;
    expect(epic.incoming).toMatchObject({
      startDate: '2026-11-02',
      dueDate: '2026-12-18',
      priority: 2,
    });
    expect(epic.changes.title).toBe('Checkout revamp');
    const feature = plan.operations.find((o) => o.remoteId === '2')!;
    expect(feature.incoming.assigneeIds).toEqual([mia]);
    expect(feature.parentRemote).toBe('1');
    expect(plan.operations.find((o) => o.remoteId === '4')!.incoming.title).toBe(
      'Remove a saved card, "quickly"',
    );
    expect(plan.rows.every((row) => row.differences.every((d) => d.choice === 'incoming'))).toBe(
      true,
    );
  });
  it('reads Scrum flat and Basic tree exports', () => {
    for (const name of ['scrum-flat.csv', 'basic-tree.csv']) {
      const r = incoming(fixture(name));
      r.mode = 'observe';
      expect(() => incomingPlan(agile(), r, [], [], undefined, members)).not.toThrow();
    }
  });
  it('parses export dates by locale and refuses ambiguous ones without a configured order', () => {
    expect(parseAdoDate('02/11/2026 05:30:00', 'DMY', 'Start Date')).toBe('2026-11-02');
    expect(parseAdoDate('11/02/2026 7:00 PM', 'MDY', 'Start Date')).toBe('2026-11-02');
    expect(parseAdoDate('18/12/2026 05:30:00', undefined, 'Target Date')).toBe('2026-12-18');
    expect(parseAdoDate('2026-12-24T12:00:00Z', undefined, 'Target Date')).toBe('2026-12-24');
    expect(parseAdoDate('', 'DMY', 'Target Date')).toBeNull();
    expect(() => parseAdoDate('02/11/2026', undefined, 'Start Date')).toThrow(/date order/);
    expect(() => parseAdoDate('31/02/2026', 'DMY', 'Start Date')).toThrow(/Unrecognized/);
    expect(() => parseAdoDate('18/12/2026', 'MDY', 'Start Date')).toThrow(/does not match/);
    expect(adoDate('2026-12-24')).toBe('2026-12-24T12:00:00Z');
  });
  it('treats a blank priority as no value', () => {
    const d = destination();
    d.profile.fields = { priority: 'Priority' };
    const r = incoming('ID,Work Item Type,Title,State,Priority\n21,Task,A,New,');
    expect(incomingPlan(d, r, [], []).operations[0].incoming.priority).toBeUndefined();
  });
});

describe('Quick and Detailed incoming review', () => {
  it('applies a change made only in ADO and asks when both sides changed', () => {
    const task = item('1');
    const l = synced(task, {});
    const csv = (title: string) =>
      `ID,Work Item Type,Title,Description\n21,Task,${title},Kloister reference: ${l.reference}`;
    let plan = incomingPlan(destination(), incoming(csv('Renamed in ADO')), [task], [l]);
    expect(plan.errors).toEqual([]);
    expect(plan.operations[0].changes).toEqual({ title: 'Renamed in ADO', description: '' });
    task.title = 'Renamed locally';
    plan = incomingPlan(destination(), incoming(csv('Renamed in ADO')), [task], [l]);
    expect(plan.errors.join()).toMatch(/changed on both sides/);
    const detailed = incoming(csv('Renamed locally'));
    detailed.review = 'detailed';
    task.title = 'Item 1';
    plan = incomingPlan(destination(), detailed, [task], [l]);
    expect(plan.errors.join()).toMatch(/choose Title/);
  });
  it('link-only returns never block on unmapped State, Assigned To, Tags or Iteration', () => {
    const d = destination();
    d.profile.fields = { labelIds: 'Tags', sprintId: 'Iteration Path' };
    const l = link('1', { remoteId: null, pendingBatchId: randomUUID() });
    const r = incoming(
      'ID,Work Item Type,Title,State,Assigned To,Tags,Iteration Path,Description\n' +
        `21,Task,A,Doing,Someone <someone@example.org>,mystery,Remote\\Sprint 9,Kloister reference: ${l.reference}`,
    );
    r.mode = 'reconcile';
    const plan = incomingPlan(d, r, [item('1')], [l], undefined, members);
    expect(plan.errors).toEqual([]);
    expect(plan.rows[0].warnings.join(' ')).toMatch(
      /State "Doing".*not mapped.*mystery.*Sprint 9/s,
    );
  });
  it('strips generated details from ADO-normalized HTML even after an unused prepared file', () => {
    const l = link('1');
    l.generatedSuffix =
      '<hr /><p>Kloister transfer details (generated; not structured entities)</p><p>Kloister reference: newer</p>';
    const text = `<p>User content </p><hr><p>Kloister transfer details (generated; not structured entities) </p><ul><li>[ ] step </li></ul><p>Kloister reference: ${l.reference} </p>`;
    const r = incoming(`ID,Work Item Type,Title,Description\n21,Task,A,"${text}"`);
    expect(
      incomingPlan(destination(), r, [item('1')], [l]).operations[0].incoming.description,
    ).toBe('<p>User content </p>');
    expect(() => stripFooter(`${text}<p>added below</p>`, l.reference)).toThrow(/added after/);
  });
});

describe('presets', () => {
  it('suggests default states per process and recognizes extra states', () => {
    const scrum = adoPreset('Scrum');
    expect(scrum.states.TASK).toMatchObject({ NOT_STARTED: 'To Do', DONE: 'Done', BLOCKED: null });
    expect(scrum.states.STORY.IN_PROGRESS).toBe('Committed');
    expect(adoPreset('Basic').states.BUG.IN_PROGRESS).toBe('Doing');
    expect(adoSuggestStatus(adoPreset('Agile'), 'User Story', 'Resolved')).toBe('IN_PROGRESS');
    expect(adoSuggestStatus(scrum, 'Product Backlog Item', 'approved')).toBe('NOT_STARTED');
    expect(adoSuggestStatus(adoPreset('Custom'), 'Task', 'New')).toBeNull();
  });
});

describe('review findings: no silent overwrites', () => {
  it('asks instead of guessing when ADO has no baseline for a field', () => {
    const d = destination();
    d.profile.fields = { priority: 'Priority' };
    const task = item('1');
    // Imported from ADO with a blank Priority: the baseline has no priority at all.
    const l = synced(task, { Priority: '1' });
    delete (l.remoteBaseline as Record<string, unknown>)['priority'];
    delete (l.localBaseline as Record<string, unknown>)['priority'];
    const plan = exportPlan(d, outgoing(), [task], [l], undefined, members);
    expect(plan.files).toEqual([]);
    expect(plan.errors.join()).toMatch(/choose what to send for Priority/);
  });
  it('needs an explicit choice before replacing an ADO description with images', () => {
    const task = item('1');
    const l = synced(task, { Description: '<p>Hello Ω 😀</p><img src="x.png">' });
    task.description = '<p>Edited here</p>';
    expect(
      exportPlan(destination(), outgoing(), [task], [l], undefined, members).errors.join(),
    ).toMatch(/embedded images/);
    const request = outgoing();
    request.choices['1'] = { description: 'local' };
    const plan = exportPlan(destination(), request, [task], [l], undefined, members);
    expect(plan.errors).toEqual([]);
    expect(readCsv(plan.files[0].csv).rows[0]['Description']).toContain('Edited here');
  });
  it('warns when the returned export lacks a column for a local change', () => {
    const d = destination();
    d.profile.fields = { labelIds: 'Tags' };
    const task = item('1');
    const l = synced(task, {});
    task.labels = [{ labelId: labelA }] as TransferItem['labels'];
    const plan = exportPlan(d, outgoing(), [task], [l], undefined, members);
    expect(plan.rows[0].warnings.join()).toMatch(/no Tags column/);
  });
  it('leaves required constant columns out of update files', () => {
    const d = destination();
    d.profile.constants = [{ header: 'Custom.Team', value: 'Payments' }];
    const task = item('1');
    const l = synced(task, {});
    task.title = 'Renamed';
    const plan = exportPlan(d, outgoing(), [task], [l], undefined, members);
    expect(readCsv(plan.files[0].csv).headers).toEqual(['ID', 'Work Item Type', 'Title']);
    expect(plan.rows[0].changes).toEqual(['title']);
  });
  it('keeps ADO tag spelling, matches tags ignoring case and drops only removed labels', () => {
    const d = destination();
    d.profile.fields = { labelIds: 'Tags' };
    d.profile.tags = { fe: labelA, BE: labelB };
    const task = item('1');
    task.labels = [{ labelId: labelA }, { labelId: labelB }] as TransferItem['labels'];
    const l = synced(task, { Tags: 'FE; be; Other' });
    task.labels = [{ labelId: labelA }] as TransferItem['labels'];
    const labels = [
      { id: labelA, name: 'Frontend' },
      { id: labelB, name: 'Backend' },
    ];
    const plan = exportPlan(d, outgoing(), [task], [l], { labels, sprints: [] }, members);
    expect(plan.errors).toEqual([]);
    expect(readCsv(plan.files[0].csv).rows[0]['Tags']).toBe('FE; Other');
  });
  it('does not block a link-only return on an ambiguous date', () => {
    const d = destination();
    d.profile.fields = { dueDate: 'Target Date' };
    d.profile.dateTypes = { dueDate: ['TASK'] };
    const l = link('1', { remoteId: null, pendingBatchId: randomUUID() });
    const r = incoming(
      `ID,Work Item Type,Title,Target Date,Description\n21,Task,A,02/11/2026 05:30:00,Kloister reference: ${l.reference}`,
    );
    r.mode = 'reconcile';
    const plan = incomingPlan(d, r, [item('1')], [l], undefined, members);
    expect(plan.errors).toEqual([]);
    expect(plan.rows[0].warnings.join()).toMatch(/date order/);
    expect(plan.rows[0].changes).toEqual([]);
  });
});

describe('fields sent by an update file', () => {
  it('asks when ADO later shows a different value for a field an update sent', () => {
    const d = destination();
    d.profile.states.TASK = {
      NOT_STARTED: 'New',
      IN_PROGRESS: 'Active',
      BLOCKED: null,
      DONE: 'Closed',
    };
    d.profile.incomingStates['Task\nClosed'] = { status: 'DONE', bucketId: bucket };
    const task = item('1');
    task.status = 'IN_PROGRESS';
    const l = link('1', {
      intent: { title: 'Item 1', status: 'IN_PROGRESS', _sent: ['status'] },
      observation: {
        raw: { 'Work Item Type': 'Task', Title: 'Item 1', State: 'Closed' },
        values: { parentId: null },
      },
    });
    const plan = exportPlan(d, outgoing(), [task], [l], undefined, members);
    expect(plan.files).toEqual([]);
    expect(plan.errors.join()).toMatch(/choose what to send for Status/);
  });
  it('leaves a date cell blank only for types without that date in a create file', () => {
    const d = destination();
    d.profile.fields = { dueDate: 'Target Date' };
    d.profile.dateTypes = { dueDate: ['FEATURE'] };
    const feature = item('1', 'FEATURE');
    feature.dueDate = new Date('2026-12-24T00:00:00Z');
    const task = item('2', 'TASK', '1');
    task.dueDate = new Date('2026-12-25T00:00:00Z');
    const rows = readCsv(exportPlan(d, outgoing(), [feature, task], []).files[0].csv).rows;
    expect(rows.map((r) => r['Target Date'])).toEqual(['2026-12-24T12:00:00Z', '']);
  });
});

describe('Basic flattening keeps the local hierarchy', () => {
  /** Basic profile with explicit reverse types for the promoted levels. */
  function basic(): AdoDestinationDto {
    const d = destination();
    d.profile = preset('Basic');
    d.profile.fields = {};
    d.profile.reverseTypes = { Epic: 'FEATURE', Issue: 'STORY' };
    return d;
  }
  const tree = (): TransferItem[] => [
    item('e', 'EPIC'),
    item('f', 'FEATURE', 'e'),
    item('s', 'STORY', 'f'),
  ];
  const created = (target: TransferItem, reference: string): AdoItemLink =>
    link(target.id, {
      reference,
      remoteId: null,
      pendingBatchId: randomUUID(),
      observation: null,
      observedAt: null,
      intent: { ...localValues(target) },
    });
  const returned =
    'ID,Work Item Type,Title 1,Title 2,Description\n' +
    `20,Epic,Item f,,Kloister reference: ${'b'.repeat(64)}\n` +
    `21,Issue,,Item s,Kloister reference: ${'c'.repeat(64)}`;

  it('does not clear the parent of a promoted item in any mode or review', () => {
    const items = tree();
    const links = [created(items[1], 'b'.repeat(64)), created(items[2], 'c'.repeat(64))];
    for (const mode of ['reconcile', 'observe', 'import'] as const)
      for (const review of ['quick', 'detailed'] as const) {
        const request = incoming(returned);
        request.mode = mode;
        request.review = review;
        const plan = incomingPlan(basic(), request, items, links);
        const promoted = plan.rows.find((r) => r.itemId === 'f')!;
        expect(promoted.differences.map((d) => d.field)).not.toContain('parentId');
        const op = plan.operations.find((o) => o.itemId === 'f')!;
        expect(op.changes).not.toHaveProperty('parentId');
        // The stored observation keeps ADO's own view of the hierarchy.
        expect(op.incoming.parentId).toBeNull();
      }
    const quick = incomingPlan(basic(), incoming(returned), items, links);
    expect(quick.errors).toEqual([]);
    // The child's parent is the row above, resolved to the same local item when applied.
    expect(quick.operations.find((o) => o.itemId === 's')!.changes.parentId).toBe('remote:20');
  });

  it('still applies a parent change made in ADO to a promoted item', () => {
    const items = [...tree(), item('g', 'FEATURE')];
    const l = link('s', {
      reference: 'c'.repeat(64),
      remoteId: '21',
      intent: { ...localValues(items[2]) },
    });
    const other = link('g', { reference: 'd'.repeat(64), remoteId: '30' });
    const plan = incomingPlan(
      basic(),
      incoming(
        'ID,Work Item Type,Title,Parent,Description\n' +
          `21,Issue,Item s,30,Kloister reference: ${'c'.repeat(64)}`,
      ),
      items,
      [l, other],
    );
    expect(plan.errors).toEqual([]);
    expect(plan.operations[0].changes.parentId).toBe('g');
    // A shown parent difference names the real local parent, not its ADO projection.
    const feature = link('f', {
      reference: 'b'.repeat(64),
      remoteId: '20',
      intent: { ...localValues(items[1]) },
    });
    const detailed = incoming(
      'ID,Work Item Type,Title,Parent,Description\n' +
        `20,Epic,Item f,30,Kloister reference: ${'b'.repeat(64)}`,
    );
    detailed.review = 'detailed';
    const shown = incomingPlan(basic(), detailed, items, [feature, other]).rows[0].differences;
    expect(shown.find((d) => d.field === 'parentId')).toMatchObject({ local: 'e', incoming: 'g' });
  });

  it('applies a parent removed in ADO even when the local parent is not in the list', () => {
    const task = item('1', 'TASK', 'hidden');
    const l = link('1', { remoteId: '21', intent: { ...localValues(task) } });
    const plan = incomingPlan(
      destination(),
      incoming(
        `ID,Work Item Type,Title,Parent,Description\n21,Task,Item 1,,Kloister reference: ${l.reference}`,
      ),
      [task],
      [l],
    );
    expect(plan.errors).toEqual([]);
    expect(plan.operations[0].changes.parentId).toBeNull();
  });

  it('skips every omitted level and keeps unknown parents', () => {
    const items = tree();
    const byId = new Map(items.map((i) => [i.id, i]));
    const profile = basic().profile;
    expect(adoParent('e', byId, profile)).toBeNull();
    expect(adoParent('f', byId, profile)).toBe('f');
    profile.types.FEATURE = null;
    expect(adoParent('f', byId, profile)).toBeNull();
    expect(adoParent('unknown', byId, profile)).toBe('unknown');
    items[0].parentId = 'unknown';
    expect(adoParent('f', byId, profile)).toBe('unknown');
  });

  it('does not warn about promoted parents and keeps context rows after a returned export', () => {
    const items = tree();
    const [, feature, story] = items;
    feature.title = 'Renamed locally';
    const f = synced(feature, { 'Work Item Type': 'Epic', Title: 'Item f' }, { title: 'Item f' });
    const s = synced(story, { 'Work Item Type': 'Issue' });
    s.reference = 'c'.repeat(64);
    s.remoteId = '22';
    // ADO's view (no parent) as stored now, and the local parent as a hand-made observation.
    for (const observed of [null, 'e']) {
      (f.observation as { values: Record<string, unknown> }).values['parentId'] = observed;
      const plan = exportPlan(basic(), outgoing(), items, [f, s], undefined, members);
      expect(plan.errors).toEqual([]);
      for (const row of plan.rows) expect(row.warnings.join()).not.toMatch(/parent differs/);
      expect(readCsv(plan.files[0].csv).rows[0]['Title']).toBe('Renamed locally');
    }
    // A new child under the linked promoted Feature uses it as an ID-bearing context row.
    (f.observation as { values: Record<string, unknown> }).values['parentId'] = null;
    (f.observation as { raw: Record<string, string> }).raw['Description'] = '<p>remote</p>';
    feature.title = 'Item f';
    const child = item('n', 'STORY', 'f');
    const request = outgoing();
    request.selection.scope = 'manual';
    request.selection.itemIds = ['n'];
    const plan = exportPlan(basic(), request, [...items, child], [f, s], undefined, members);
    expect(plan.errors).toEqual([]);
    expect(readCsv(plan.files[0].csv).rows.map((r) => r['ID'])).toEqual(['21', '']);
  });
});
