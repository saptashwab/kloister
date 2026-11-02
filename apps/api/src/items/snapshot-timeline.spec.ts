import {
  timelineSheet,
  TIMELINE_SHEET_MAX_WEEKS,
  type TimelineSheetItem,
} from './snapshot-timeline.js';

/** A test item; dates default to none. */
function item(
  over: Partial<TimelineSheetItem> & { id: string; number: number },
): TimelineSheetItem {
  return {
    parentId: null,
    key: `WEB-${over.number}`,
    title: `Item ${over.number}`,
    type: 'TASK',
    status: 'NOT_STARTED',
    assignees: '',
    sprint: '',
    startDate: null,
    startSecondHalf: false,
    dueDate: null,
    dueFirstHalf: false,
    pin: null,
    predecessors: [],
    ...over,
  };
}

describe('timelineSheet (M9)', () => {
  const epic = item({ id: 'e', number: 1, type: 'EPIC', title: 'Relaunch' });
  const a = item({
    id: 'a',
    number: 9,
    parentId: 'e',
    status: 'DONE',
    startDate: '2026-11-02',
    dueDate: '2026-11-03',
  });
  const b = item({
    id: 'b',
    number: 10,
    parentId: 'e',
    startDate: '2026-11-05',
    startSecondHalf: true,
    dueDate: '2026-11-11',
    dueFirstHalf: true,
    predecessors: ['WEB-9'],
    pin: { date: '2026-11-05', second: true },
    sprint: 'Sprint 4',
  });
  const sheet = timelineSheet(
    [b, a, epic],
    [{ name: 'Sprint 4', startDate: '2026-11-02', endDate: '2026-11-13' }],
    '2026-11-10',
  );

  it('orders by hierarchy with outline levels and a plan and sprint row first', () => {
    expect(sheet.rows.map((r) => r[0])).toEqual([
      'Plan',
      'Sprints',
      'Holidays',
      'WEB-1',
      'WEB-9',
      'WEB-10',
    ]);
    expect(sheet.layout.outlineLevels).toEqual([0, 0, 0, 0, 1, 1]);
    expect(sheet.rows[0]?.[1]).toBe('2026-11-02 – 2026-11-11 · 7.5 working days · 6 days of work');
    expect(sheet.layout.boldRows).toEqual([0, 3]);
  });

  it('gives parents their children span and work, and leaves their own values', () => {
    const [, , , parent, done, open] = sheet.rows;
    expect(parent?.slice(5, 9)).toEqual(['2026-11-02', '7.5', '2026-11-11', '6']);
    expect(done?.slice(5, 9)).toEqual(['2026-11-02', '2', '2026-11-03', '2']);
    expect(open?.slice(5, 13)).toEqual([
      '2026-11-05',
      '4',
      '2026-11-11',
      '4',
      'starts 2nd half, ends 1st half',
      '2026-11-05 (2nd half)',
      'WEB-9',
      'Sprint 4',
    ]);
  });

  it('draws one column per week, marks today and shows status as text', () => {
    expect(sheet.headers.slice(13)).toEqual(['2026-11-02', '2026-11-09 (today)']);
    expect(sheet.rows[1]?.slice(13)).toEqual(['Sprint 4', 'Sprint 4']);
    expect(sheet.rows[4]?.slice(13)).toEqual(['✓', '']);
    expect(sheet.rows[5]?.slice(13)).toEqual(['○', '']);
    expect(sheet.layout.fills?.[5]?.slice(13)).toEqual(['C8EBF3', 'C8EBF3']);
    expect(sheet.layout.fills?.[4]?.slice(13)).toEqual(['E3E6EC', null]);
    expect(sheet.note).toBeNull();
  });

  it('caps very long plans and says so', () => {
    const long = timelineSheet(
      [item({ id: 'x', number: 1, startDate: '2026-01-05', dueDate: '2030-01-04' })],
      [],
      '2026-01-05',
    );
    expect(long.headers.length).toBe(13 + TIMELINE_SHEET_MAX_WEEKS);
    expect(long.note).toMatch(/not drawn \(limit of 156 weeks\)/);
    expect(long.rows[0]?.[1]).toContain(long.note!);
  });

  it('handles a plan without dates', () => {
    const empty = timelineSheet([item({ id: 'x', number: 1 })], [], '2026-11-02');
    expect(empty.rows[0]?.[1]).toBe('No dated items');
    expect(empty.headers.length).toBe(13);
  });

  it('skips holidays in durations and lists them per week (M9.1)', () => {
    const task = item({ id: 'h', number: 1, startDate: '2026-11-02', dueDate: '2026-11-06' });
    const withHoliday = timelineSheet([task], [], '2026-11-02', [
      { name: 'Founders day', startDate: '2026-11-04', endDate: '2026-11-04' },
    ]);
    expect(withHoliday.rows[3]?.[6]).toBe('4');
    expect(withHoliday.rows[2]?.slice(13)).toEqual(['Founders day']);
  });
});
