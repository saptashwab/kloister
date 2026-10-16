import { randomUUID } from 'node:crypto';
import {
  ADO_LIMITS,
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
import { incomingPlan, type TransferItem } from './transfer.js';

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
  it.each(['=1+1', ' +command', '\t@SUM(1)', '-1+2'])(
    'blocks formula-like output without silently changing data: %s',
    (text) => {
      expect(() => writeCsv(['Work Item Type', 'Title'], [['Task', text]])).toThrow(/Formula/);
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

describe('outgoing identity and hierarchy', () => {
  it('names remote-parent context added by a reviewed parent choice and identifies unused local ancestors', () => {
    const old = item('old', 'STORY'),
      remote = item('remote', 'STORY'),
      child = item('child', 'TASK', 'old');
    const links = [
      link('old', { remoteId: '41', reference: 'b'.repeat(64) }),
      link('remote', {
        remoteId: '42',
        reference: 'c'.repeat(64),
        observation: {
          raw: {
            'Work Item Type': 'User Story',
            Title: 'Remote parent',
            Description: '<p>parent</p>',
            'Assigned To': '',
          },
          values: { parentId: null },
        },
      }),
      link('child', {
        remoteId: '43',
        observation: {
          raw: {
            'Work Item Type': 'Task',
            Title: 'Child',
            Description: '<p>child</p>',
            'Assigned To': '',
          },
          values: { parentId: 'remote' },
        },
      }),
    ];
    const request = outgoing();
    request.selection.scope = 'manual';
    request.selection.itemIds = ['child'];
    request.choices['child'] = { parentId: 'incoming' };
    const result = exportPlan(destination(), request, [old, remote, child], links);
    expect(result.errors).toEqual([]);
    expect(result.rows.find((r) => r.itemId === 'remote')).toMatchObject({
      kind: 'context',
      selected: false,
      remoteId: '42',
    });
    expect(result.rows.find((r) => r.itemId === 'old')).toMatchObject({
      kind: 'omitted',
      selected: false,
    });
    expect(readCsv(result.files[0].csv).rows.map((r) => r['ID'])).toEqual(['42', '43']);
  });
  it('blocks selected updates when the PM observation omits an emitted field', () => {
    const local = item('1'),
      l = link('1');
    l.observation = {
      raw: { 'Work Item Type': 'Task', Title: 'Item 1', Parent: '' },
      values: { parentId: null },
    };
    const plan = exportPlan(destination(), outgoing(), [local], [l]);
    expect(plan.errors.join()).toMatch(/review the Description column/);
    expect(plan.files).toEqual([]);
  });
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
    ).toMatch(/recover or cancel/);
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
  it('keeps mapped states on separate files from intentionally unsupported states', () => {
    const d = destination();
    d.profile.states.TASK.IN_PROGRESS = 'Active';
    const a = item('1'),
      b = item('2');
    a.status = 'IN_PROGRESS';
    b.status = 'BLOCKED';
    const result = exportPlan(
      d,
      outgoing(),
      [a, b],
      [link('1'), link('2', { remoteId: '22', reference: 'b'.repeat(64) })],
    );
    expect(result.files).toHaveLength(2);
    const tables = result.files.map((f) => readCsv(f.csv));
    expect(tables.filter((t) => t.headers.includes('State'))).toHaveLength(1);
    expect(tables.find((t) => t.headers.includes('State'))!.rows[0]['State']).toBe('Active');
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
    const preview = incomingPlan(d, r, [], []);
    expect(preview.rows[0].differences.map((f) => f.field)).not.toContain('assigneeIds');
    expect(preview.errors.join()).toMatch(/review title/);
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
