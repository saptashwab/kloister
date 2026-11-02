import {
  agenda,
  type CalendarEntry,
  entrySpan,
  holidayOn,
  layoutWeek,
  monthWeeks,
  shiftDates,
  weekBands,
} from './calendar-logic';

/** A calendar entry with dates. */
function entry(
  id: string,
  startDate: string | null,
  dueDate: string | null,
  halves: { startSecondHalf?: boolean; dueFirstHalf?: boolean } = {},
): CalendarEntry {
  return {
    id,
    key: `KLO-${id}`,
    title: id,
    type: 'TASK',
    status: 'NOT_STARTED',
    adHoc: false,
    link: [],
    canMove: true,
    presence: null,
    project: null,
    startDate,
    dueDate,
    startSecondHalf: halves.startSecondHalf ?? false,
    dueFirstHalf: halves.dueFirstHalf ?? false,
  };
}

// 2026-11-02 is a Monday.
describe('calendar layout (M13)', () => {
  it('shows the weeks of a month from Monday', () => {
    expect(monthWeeks('2026-11-17')).toEqual([
      '2026-10-26',
      '2026-11-02',
      '2026-11-09',
      '2026-11-16',
      '2026-11-23',
      '2026-11-30',
    ]);
    expect(monthWeeks('2027-02-01')).toHaveLength(4);
  });

  it('places spans, single dates and half days in a week', () => {
    const week = layoutWeek(
      [
        entry('a', '2026-11-03', '2026-11-05', { startSecondHalf: true, dueFirstHalf: true }),
        entry('b', null, '2026-11-04'),
        entry('c', '2026-10-28', '2026-11-10'),
        entry('d', null, null),
      ],
      '2026-11-02',
    );
    const byId = new Map(week.map((s) => [s.entry.id, s]));
    expect(byId.get('a')).toMatchObject({ start: 1, end: 3, startHalf: true, endHalf: true });
    expect(byId.get('b')).toMatchObject({ start: 2, end: 2, startHalf: false });
    expect(byId.get('c')).toMatchObject({ start: 0, end: 6, before: true, after: true });
    expect(byId.has('d')).toBe(false);
  });

  it('puts overlapping pieces in separate lanes and reuses free lanes', () => {
    const week = layoutWeek(
      [
        entry('a', '2026-11-02', '2026-11-04'),
        entry('b', '2026-11-03', '2026-11-03'),
        entry('c', '2026-11-05', '2026-11-06'),
      ],
      '2026-11-02',
    );
    const lanes = Object.fromEntries(week.map((s) => [s.entry.id, s.lane]));
    expect(lanes).toEqual({ a: 0, b: 1, c: 0 });
  });

  it('bands sprints and names holidays', () => {
    const ranges = [{ name: 'Sprint 4', startDate: '2026-11-05', endDate: '2026-11-18' }];
    expect(weekBands(ranges, '2026-11-02')).toEqual([{ name: 'Sprint 4', start: 3, end: 6 }]);
    expect(weekBands(ranges, '2026-11-16')).toEqual([{ name: 'Sprint 4', start: 0, end: 2 }]);
    expect(holidayOn(ranges, '2026-11-10')).toBe('Sprint 4');
    expect(holidayOn(ranges, '2026-11-20')).toBeNull();
  });

  it('lists the phone agenda by day', () => {
    const days = agenda(
      [entry('a', '2026-11-02', '2026-11-03'), entry('b', null, '2026-11-03')],
      '2026-11-01',
      '2026-11-04',
    );
    expect(days.map((d) => [d.day, d.entries.map((e) => e.id)])).toEqual([
      ['2026-11-02', ['a']],
      ['2026-11-03', ['a', 'b']],
    ]);
  });

  it('shifts dates for a move preview', () => {
    expect(shiftDates(entry('a', '2026-11-02', '2026-11-03'), 7)).toMatchObject({
      startDate: '2026-11-09',
      dueDate: '2026-11-10',
    });
    expect(entrySpan(entry('a', null, null))).toBeNull();
  });
});
