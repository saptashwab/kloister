import type { ItemRefDto } from '@kloister/shared';
import {
  mergeHolidays,
  type MsProjectInput,
  type MsProjectItem,
  msProjectXml,
} from './msproject.js';

/** A test item; dates default to none. */
function item(over: Partial<MsProjectItem> & { id: string; number: number }): MsProjectItem {
  return {
    outlinePosition: null,
    key: `WEB-${over.number}`,
    title: `Item ${over.number}`,
    type: 'TASK',
    status: 'NOT_STARTED',
    ancestors: [],
    description: '',
    checklist: { done: 0, total: 0 },
    pin: null,
    assignees: [],
    startDate: null,
    startSecondHalf: false,
    dueDate: null,
    dueFirstHalf: false,
    ...over,
  };
}

/** A reference to an item, as in `ancestors`. */
function ref(i: MsProjectItem): ItemRefDto {
  return { id: i.id, number: i.number, key: i.key, type: i.type, title: i.title };
}

/** Builds a file from items and links. */
function build(items: MsProjectItem[], over: Partial<MsProjectInput> = {}): string {
  return msProjectXml({
    projectName: 'Website',
    items,
    edges: [],
    holidays: [],
    today: '2026-11-02',
    now: new Date('2026-11-03T10:00:00Z'),
    ...over,
  });
}

/** The tasks in the file, as tag-to-text maps (first value per tag). */
function tasks(xml: string): Map<string, string>[] {
  return [...xml.matchAll(/<Task>(.*?)<\/Task>/gs)].map(
    ([, body]) =>
      new Map([...body.matchAll(/<(\w+)>([^<]*)<\/\1>/g)].reverse().map(([, k, v]) => [k, v])),
  );
}

/** Element order of a Task in mspdi_pj12.xsd, for the elements the file uses. */
const TASK_ORDER = [
  'UID',
  'ID',
  'Name',
  'Type',
  'IsNull',
  'WBS',
  'OutlineNumber',
  'OutlineLevel',
  'Start',
  'Finish',
  'Duration',
  'DurationFormat',
  'Estimated',
  'Milestone',
  'Summary',
  'PercentComplete',
  'ConstraintType',
  'ConstraintDate',
  'Notes',
  'PredecessorLink',
];

const epic = item({ id: 'e', number: 1, type: 'EPIC', title: 'Relaunch' });
const feature = item({ id: 'f', number: 2, type: 'FEATURE', ancestors: [ref(epic)] });
const draft = item({
  id: 'd',
  number: 3,
  ancestors: [ref(epic), ref(feature)],
  startDate: '2026-11-05',
  startSecondHalf: true,
  dueDate: '2026-11-11',
  dueFirstHalf: true,
  checklist: { done: 1, total: 4 },
  assignees: [{ userId: 'u1', name: 'Ann', email: 'ann@example.org', share: 50 }],
});
const review = item({
  id: 'r',
  number: 4,
  ancestors: [ref(epic), ref(feature)],
  startDate: '2026-11-12',
  dueDate: '2026-11-12',
  status: 'DONE',
});

describe('Microsoft Project XML (v1.3.2)', () => {
  it('writes the outline with summaries, half days, durations and progress', () => {
    const xml = build([review, epic, draft, feature], {
      edges: [{ blockingItemId: 'd', blockedItemId: 'r' }],
    });
    const [project, e, f, d, r] = tasks(xml);
    expect(project?.get('UID')).toBe('0');
    expect(
      [e, f, d, r].map((t) => [t?.get('WBS'), t?.get('OutlineNumber'), t?.get('Summary')]),
    ).toEqual([
      ['WEB-1', '1', '1'],
      ['WEB-2', '1.1', '1'],
      ['WEB-3', '1.1.1', '0'],
      ['WEB-4', '1.1.2', '0'],
    ]);
    // 2nd half of Thu 5 Nov to the 1st half of Wed 11 Nov: 4 working days.
    expect(d?.get('Start')).toBe('2026-11-05T13:00:00');
    expect(d?.get('Finish')).toBe('2026-11-11T12:00:00');
    expect(d?.get('Duration')).toBe('PT32H0M0S');
    // Kept where Kloister has it while Project schedules.
    expect(d?.get('ConstraintType')).toBe('4');
    expect(d?.get('ConstraintDate')).toBe('2026-11-05T13:00:00');
    expect(d?.get('PercentComplete')).toBe('25');
    expect(r?.get('PercentComplete')).toBe('100');
    // Summaries span their rows and weigh progress by working days.
    expect(f?.get('Start')).toBe('2026-11-05T13:00:00');
    expect(f?.get('Finish')).toBe('2026-11-12T17:00:00');
    expect(f?.get('PercentComplete')).toBe('40');
    expect(f?.get('ConstraintType')).toBe('0');
    expect(xml).toContain(
      '<PredecessorLink><PredecessorUID>3</PredecessorUID><Type>1</Type><CrossProject>0</CrossProject><LinkLag>0</LinkLag><LagFormat>7</LagFormat></PredecessorLink>',
    );
    // Ann at 50 %: half of 32 hours.
    expect(xml).toContain(
      '<Resource><UID>1</UID><ID>1</ID><Name>Ann</Name><Type>1</Type><IsNull>0</IsNull><EmailAddress>ann@example.org</EmailAddress><MaxUnits>1.00</MaxUnits></Resource>',
    );
    expect(xml).toContain(
      '<Assignment><UID>1</UID><TaskUID>3</TaskUID><ResourceUID>1</ResourceUID><Finish>2026-11-11T12:00:00</Finish><Start>2026-11-05T13:00:00</Start><Units>0.50</Units><Work>PT16H0M0S</Work></Assignment>',
    );
  });

  it('keeps the schema order of every task element', () => {
    const xml = build([epic, feature, draft, review, item({ id: 'u', number: 5 })]);
    for (const [, body] of xml.matchAll(/<Task>(.*?)<\/Task>/gs)) {
      const names = [...body.matchAll(/<(\w+)>/g)]
        .map(([, name]) => name)
        .filter((name) => TASK_ORDER.includes(name));
      const positions = names.map((name) => TASK_ORDER.indexOf(name));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
    // Project, then calendars, tasks, resources and assignments.
    const sections = ['<SaveVersion>', '<Calendars>', '<Tasks>', '<Resources>', '<Assignments>'];
    const at = sections.map((s) => xml.indexOf(s));
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('skips holidays, merging overlaps into one calendar exception', () => {
    const holidays = [
      { name: 'Founders day', startDate: '2026-11-09', endDate: '2026-11-09' },
      { name: 'Team day', startDate: '2026-11-09', endDate: '2026-11-10' },
    ];
    expect(mergeHolidays(holidays)).toEqual([
      { name: 'Founders day / Team day', startDate: '2026-11-09', endDate: '2026-11-10' },
    ]);
    const xml = build([draft], { holidays });
    expect(xml.match(/<Exception>/g)).toHaveLength(1);
    // Also as an exception day in WeekDays, the older form other tools read.
    expect(xml).toContain(
      '<WeekDay><DayType>0</DayType><DayWorking>0</DayWorking><TimePeriod><FromDate>2026-11-09T00:00:00</FromDate><ToDate>2026-11-10T23:59:00</ToDate></TimePeriod></WeekDay>',
    );
    expect(xml).toContain(
      '<TimePeriod><FromDate>2026-11-09T00:00:00</FromDate><ToDate>2026-11-10T23:59:00</ToDate></TimePeriod>',
    );
    // Two holidays inside the span: 2 working days left.
    expect(tasks(xml)[1]?.get('Duration')).toBe('PT16H0M0S');
  });

  it('estimates undated items and shows hidden ancestors as titles only', () => {
    const hidden = { id: 'h', number: 9, key: 'WEB-9', type: 'FEATURE' as const, title: 'Secret' };
    const undated = item({ id: 'u', number: 5, ancestors: [hidden] });
    const [, h, u] = tasks(build([undated]));
    expect(h?.get('Name')).toBe('Secret');
    expect(h?.get('Notes')).toBe('WEB-9: not visible to you in Kloister (title only).');
    expect(u?.get('Estimated')).toBe('1');
    expect(u?.get('DurationFormat')).toBe('39');
    expect(u?.get('Start')).toBe('2026-11-02T08:00:00');
    expect(u?.get('ConstraintType')).toBe('0');
    expect(u?.get('Notes')).toContain('No dates in Kloister yet.');
  });

  it('leaves links with an own parent or child row to the notes', () => {
    const xml = build([epic, feature, draft, review], {
      edges: [{ blockingItemId: 'd', blockedItemId: 'f' }],
    });
    expect(xml).not.toContain('<PredecessorLink>');
    expect(tasks(xml)[2]?.get('Notes')).toContain('Waits for WEB-3 in Kloister');
  });

  it('starts undated tasks on a working day', () => {
    // Saturday 7 Nov: the estimated day goes to Monday 9 Nov.
    const [, u] = tasks(build([item({ id: 'u', number: 5 })], { today: '2026-11-07' }));
    expect(u?.get('Start')).toBe('2026-11-09T08:00:00');
  });

  it('escapes text and drops characters XML cannot hold', () => {
    const xml = build([
      item({ id: 'x', number: 6, title: 'A & B <c> "d"\u0007', description: 'Line\u0000 one' }),
    ]);
    expect(xml).toContain('<Name>A &amp; B &lt;c&gt; &quot;d&quot;</Name>');
    expect(xml).toContain('Line one');
    const controls = [...xml].filter(
      (c) => c.charCodeAt(0) < 0x20 && ![0x09, 0x0a, 0x0d].includes(c.charCodeAt(0)),
    );
    expect(controls).toEqual([]);
  });
});
