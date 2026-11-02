import { NO_HOLIDAYS, workCalendar, WorkloadLevel } from '@kloister/shared';
import {
  burndown,
  loadLevel,
  type SprintItem,
  sprintAt,
  sprintChanges,
  sprintWorkingDays,
  spreadWorkload,
  startsBeforePredecessor,
  workloadCell,
  workloadWeeks,
} from './report-logic.js';

/** Dates for a test item. */
const span = (
  startDate: string | null,
  dueDate: string | null,
  startSecondHalf = false,
  dueFirstHalf = false,
) => ({ startDate, dueDate, startSecondHalf, dueFirstHalf });

// 2026-11-02 is a Monday.
describe('workload (M13)', () => {
  it('counts each week’s working days with holidays', () => {
    const cal = workCalendar([{ startDate: '2026-11-11', endDate: '2026-11-11' }]);
    const weeks = workloadWeeks('2026-11-02', 3, cal);
    expect(weeks.map((w) => [w.start, w.end, w.available])).toEqual([
      ['2026-11-02', '2026-11-08', 5],
      ['2026-11-09', '2026-11-15', 4],
      ['2026-11-16', '2026-11-22', 5],
    ]);
  });

  it('spreads items over weeks by share, with unassigned work last', () => {
    const weeks = workloadWeeks('2026-11-02', 2, NO_HOLIDAYS);
    const lines = spreadWorkload(
      [
        // Thursday to next Tuesday: 2 + 2 days.
        {
          id: 'a',
          ...span('2026-11-05', '2026-11-10'),
          assignees: [
            { userId: 'ann', share: 100 },
            { userId: 'bo', share: 25 },
          ],
        },
        { id: 'b', ...span('2026-11-02', '2026-11-02', false, true), assignees: [] },
      ],
      weeks,
      NO_HOLIDAYS,
    );
    expect(lines.map((l) => l.userId)).toEqual(['ann', 'bo', null]);
    const bo = lines[1];
    expect(bo.weeks[0]).toEqual([{ itemId: 'a', days: 2, share: 25 }]);
    const cell = workloadCell(bo.weeks[0], 5, (p) => ({
      item: { id: p.itemId } as never,
      days: p.days,
      share: p.share,
    }));
    expect(cell.planned).toBe(0.5);
    expect(cell.level).toBe(WorkloadLevel.OK);
    expect(lines[2].weeks[0]).toEqual([{ itemId: 'b', days: 0.5, share: 100 }]);
    expect(lines[2].weeks[1]).toEqual([]);
  });

  it('marks amber from 80% and red above 100%', () => {
    expect(loadLevel(3.5, 5)).toEqual({ load: 0.7, level: WorkloadLevel.OK });
    expect(loadLevel(4, 5)).toEqual({ load: 0.8, level: WorkloadLevel.HIGH });
    expect(loadLevel(5, 5)).toEqual({ load: 1, level: WorkloadLevel.HIGH });
    expect(loadLevel(5.5, 5)).toEqual({ load: 1.1, level: WorkloadLevel.OVER });
    expect(loadLevel(0, 5)).toEqual({ load: 0, level: WorkloadLevel.NONE });
    expect(loadLevel(0, 0)).toEqual({ load: null, level: WorkloadLevel.NONE });
  });
});

describe('sprint history (M13)', () => {
  const started = new Date('2026-11-02T09:00:00Z');
  const item = (over: Partial<SprintItem>): SprintItem => ({
    id: 'i',
    ...span('2026-11-02', '2026-11-03'),
    sprintId: 's1',
    createdAt: new Date('2026-10-20T00:00:00Z'),
    completedAt: null,
    moves: [],
    ...over,
  });

  it('works the sprint back from history', () => {
    const moved = item({
      moves: [{ at: new Date('2026-11-04T10:00:00Z'), from: null, to: 's1' }],
    });
    expect(sprintAt(moved, new Date('2026-11-03T00:00:00Z'))).toBeNull();
    expect(sprintAt(moved, new Date('2026-11-05T00:00:00Z'))).toBe('s1');
  });

  it('counts additions by when the item joined, not when it was created', () => {
    const joined = item({
      moves: [{ at: new Date('2026-11-04T10:00:00Z'), from: 's0', to: 's1' }],
    });
    expect(sprintChanges(joined, 's1', started).added).toEqual(new Date('2026-11-04T10:00:00Z'));
    // Planned before the start: not an addition.
    const planned = item({
      moves: [{ at: new Date('2026-11-01T10:00:00Z'), from: null, to: 's1' }],
    });
    expect(sprintChanges(planned, 's1', started)).toEqual({ added: null, removed: null });
    // Created in the sprint after the start: an addition.
    const fresh = item({ createdAt: new Date('2026-11-03T08:00:00Z') });
    expect(sprintChanges(fresh, 's1', started).added).toEqual(fresh.createdAt);
    const left = item({
      sprintId: null,
      moves: [{ at: new Date('2026-11-05T10:00:00Z'), from: 's1', to: null }],
    });
    expect(sprintChanges(left, 's1', started).removed).toEqual(new Date('2026-11-05T10:00:00Z'));
  });

  it('burns down remaining working days per sprint day', () => {
    const days = sprintWorkingDays('2026-11-02', '2026-11-06', NO_HOLIDAYS);
    expect(days).toHaveLength(5);
    const items = [
      item({ id: 'a', completedAt: new Date('2026-11-03T12:00:00Z') }), // 2 days
      item({ id: 'b', ...span('2026-11-04', '2026-11-06') }), // 3 days
      item({
        id: 'c',
        ...span('2026-11-05', '2026-11-05'),
        sprintId: 's1',
        moves: [{ at: new Date('2026-11-04T12:00:00Z'), from: null, to: 's1' }],
      }),
    ];
    const points = burndown(items, 's1', days, '2026-11-04', NO_HOLIDAYS);
    expect(points.map((p) => p.remaining)).toEqual([5, 3, 4, null, null]);
    expect(points[0].ideal).toBe(5);
    expect(points[4].ideal).toBe(0);
  });

  it('leaves holidays out of the sprint days', () => {
    const cal = workCalendar([{ startDate: '2026-11-04', endDate: '2026-11-04' }]);
    expect(sprintWorkingDays('2026-11-02', '2026-11-08', cal)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-05',
      '2026-11-06',
    ]);
  });
});

describe('plan health (M13)', () => {
  it('flags an item that starts before its predecessor finishes', () => {
    const pred = span('2026-11-02', '2026-11-04');
    expect(startsBeforePredecessor(span('2026-11-04', '2026-11-05'), pred, NO_HOLIDAYS)).toBe(true);
    expect(startsBeforePredecessor(span('2026-11-05', '2026-11-06'), pred, NO_HOLIDAYS)).toBe(
      false,
    );
    expect(startsBeforePredecessor(span(null, null), pred, NO_HOLIDAYS)).toBe(false);
  });
});
