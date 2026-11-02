import {
  addDays,
  isValidShare,
  mondayOf,
  moveFinishTo,
  workCalendar,
  workingDaysIn,
  workingDaysWithin,
  workingDuration,
} from './index.js';

/** Dates for a test item. */
const span = (
  startDate: string | null,
  dueDate: string | null,
  startSecondHalf = false,
  dueFirstHalf = false,
) => ({ startDate, dueDate, startSecondHalf, dueFirstHalf });

// 2026-11-02 is a Monday.
describe('workload arithmetic (M13)', () => {
  it('counts the working days of a week, holidays excluded', () => {
    expect(workingDaysIn('2026-11-02', '2026-11-08')).toBe(5);
    const cal = workCalendar([{ startDate: '2026-11-04', endDate: '2026-11-04' }]);
    expect(workingDaysIn('2026-11-02', '2026-11-08', cal)).toBe(4);
    const all = workCalendar([{ startDate: '2026-11-02', endDate: '2026-11-08' }]);
    expect(workingDaysIn('2026-11-02', '2026-11-08', all)).toBe(0);
  });

  it('splits an item over the weeks it spans, counting halves', () => {
    // Thursday 2nd half to next Tuesday 1st half: 1.5 + 1.5.
    const item = span('2026-11-05', '2026-11-10', true, true);
    expect(workingDaysWithin(item, '2026-11-02', '2026-11-08')).toBe(1.5);
    expect(workingDaysWithin(item, '2026-11-09', '2026-11-15')).toBe(1.5);
    expect(workingDaysWithin(item, '2026-11-16', '2026-11-22')).toBe(0);
    expect(workingDuration(item)).toBe(3);
  });

  it('leaves holidays out of an item and ignores items without both dates', () => {
    const cal = workCalendar([{ startDate: '2026-11-03', endDate: '2026-11-03' }]);
    expect(
      workingDaysWithin(span('2026-11-02', '2026-11-04'), '2026-11-02', '2026-11-08', cal),
    ).toBe(2);
    expect(workingDaysWithin(span(null, '2026-11-04'), '2026-11-02', '2026-11-08')).toBe(0);
  });

  it('finds the Monday of a week and adds days', () => {
    expect(mondayOf('2026-11-08')).toBe('2026-11-02');
    expect(mondayOf('2026-11-02')).toBe('2026-11-02');
    expect(addDays('2026-11-30', 2)).toBe('2026-12-02');
    expect(addDays('2026-11-02', -1)).toBe('2026-11-01');
  });

  it('accepts shares from 5 to 100 in steps of 5', () => {
    expect([5, 25, 50, 100].every(isValidShare)).toBe(true);
    expect([0, 3, 33, 105, 50.5].some(isValidShare)).toBe(false);
  });
});

describe('calendar moves (M13)', () => {
  it('moves the finish and keeps the working duration', () => {
    // Mon–Wed (3 days) to finish on next Monday: Thu–Mon.
    const moved = moveFinishTo(span('2026-11-02', '2026-11-04'), '2026-11-09');
    expect(moved).toEqual(span('2026-11-05', '2026-11-09'));
    expect(workingDuration(moved)).toBe(3);
  });

  it('keeps halves and skips holidays', () => {
    const cal = workCalendar([{ startDate: '2026-11-05', endDate: '2026-11-05' }]);
    // 1.5 days ending Friday 1st half: all of Wednesday, since Thursday is a holiday.
    const moved = moveFinishTo(span('2026-11-02', '2026-11-03', false, true), '2026-11-06', cal);
    expect(moved).toEqual(span('2026-11-04', '2026-11-06', false, true));
  });

  it('snaps a weekend finish back to Friday', () => {
    const moved = moveFinishTo(span('2026-11-02', '2026-11-02'), '2026-11-07');
    expect(moved).toEqual(span('2026-11-06', '2026-11-06'));
  });

  it('moves the one date of a single-date item', () => {
    expect(moveFinishTo(span(null, '2026-11-02'), '2026-11-07')).toEqual(span(null, '2026-11-07'));
    expect(moveFinishTo(span('2026-11-02', null), '2026-11-04')).toEqual(span('2026-11-04', null));
    expect(moveFinishTo(span(null, null), '2026-11-04')).toEqual(span(null, null));
  });
});
