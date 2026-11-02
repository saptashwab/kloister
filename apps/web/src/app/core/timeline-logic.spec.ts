import { makeItem as item } from '../../testing/fixtures';
import { buildTree } from './board-logic';
import {
  allowedTypes,
  percentComplete,
  barBox,
  childTypeOf,
  conflicts,
  dueText,
  durationText,
  indentTarget,
  outdentTarget,
  parseDuration,
  parseHalfDay,
  parsePasted,
  parsePredecessors,
  planSpan,
  rebaseDescendants,
  scaleTicks,
  shortDay,
  startText,
  timelineRows,
  timelineScale,
} from './timeline-logic';

const TODAY = '2026-11-02';

describe('timeline text (M9)', () => {
  it('shows halves only when they differ from the default', () => {
    const dates = {
      startDate: '2026-11-05',
      startSecondHalf: true,
      dueDate: '2026-11-11',
      dueFirstHalf: true,
    };
    expect(startText(dates, TODAY)).toBe('5 Nov, 2nd half');
    expect(dueText(dates, TODAY)).toBe('11 Nov, 1st half');
    expect(startText({ ...dates, startSecondHalf: false }, TODAY)).toBe('5 Nov');
    expect(shortDay('2027-01-04', TODAY)).toBe('4 Jan 2027');
  });

  it('reads typed dates with optional halves', () => {
    expect(parseHalfDay('5 Nov', TODAY)).toEqual({ date: '2026-11-05', half: null });
    expect(parseHalfDay('5 Nov, 2nd half', TODAY)).toEqual({ date: '2026-11-05', half: 2 });
    expect(parseHalfDay('05/11/2026 1st', TODAY)).toEqual({ date: '2026-11-05', half: 1 });
    expect(parseHalfDay('2026-11-05 h2', TODAY)).toEqual({ date: '2026-11-05', half: 2 });
    expect(parseHalfDay('next week', TODAY)).toBeNull();
  });

  it('reads and writes durations in halves', () => {
    expect(parseDuration('2.5')).toBe(2.5);
    expect(parseDuration('2,5 d')).toBe(2.5);
    expect(parseDuration('0')).toBeNull();
    expect(parseDuration('1.3')).toBeNull();
    expect(durationText(4)).toBe('4');
    expect(durationText(2.5)).toBe('2.5');
  });
});

describe('timeline rows and totals (M9)', () => {
  const epic = item(1, { type: 'EPIC', bucketId: null });
  const a = item(2, {
    parentId: 'i1',
    ancestors: [{ id: 'i1', number: 1, key: 'KLO-1', type: 'EPIC', title: 'Item 1' }],
    type: 'FEATURE',
    startDate: '2026-11-02',
    dueDate: '2026-11-03',
  });
  const b = item(3, {
    parentId: 'i1',
    ancestors: a.ancestors,
    type: 'FEATURE',
    startDate: '2026-11-04',
    dueDate: '2026-11-05',
    dueFirstHalf: true,
  });

  it('gives parents the span of their dated descendants', () => {
    const rows = timelineRows(buildTree([epic, a, b]), new Set());
    expect(rows.map((r) => [r.node.id, r.depth])).toEqual([
      ['i1', 0],
      ['i2', 1],
      ['i3', 1],
    ]);
    expect(rows[0]?.summary).toMatchObject({ duration: 3.5, work: 3.5 });
    expect(rows[1]?.summary).toBeNull();
    expect(planSpan([epic, a, b])?.duration).toBe(3.5);
  });

  it('finds successors that start before a predecessor finishes', () => {
    const late = item(4, { startDate: '2026-11-05', dueDate: '2026-11-06' });
    const ok = item(5, { startDate: '2026-11-05', startSecondHalf: true, dueDate: '2026-11-06' });
    const found = conflicts(
      [b, late, ok],
      [
        { blockingItemId: 'i3', blockedItemId: 'i4' },
        { blockingItemId: 'i3', blockedItemId: 'i5' },
      ],
    );
    expect([...found.entries()]).toEqual([['i4', ['i3']]]);
  });

  it('indents under the previous sibling and outdents to the grandparent', () => {
    const rows = timelineRows(buildTree([epic, a, b]), new Set());
    expect(indentTarget(rows, 2)).toEqual({ error: 'A Feature cannot sit under a Feature' });
    expect(indentTarget(rows, 0)).toEqual({
      error: 'There is no row above at the same level to indent under',
    });
    expect(outdentTarget(rows, 1)).toEqual({ parentId: null });
    const task = item(6, { parentId: 'i2', ancestors: [...a.ancestors, { ...a, number: 2 }] });
    const deep = timelineRows(buildTree([epic, a, task]), new Set());
    expect(outdentTarget(deep, 2)).toEqual({ error: 'A Task cannot sit under a Epic' });
    expect(childTypeOf('EPIC', 'TASK')).toBe('FEATURE');
    expect(childTypeOf(null, 'TASK')).toBe('TASK');
  });
});

describe('timeline scale (M9)', () => {
  const dates = {
    startDate: '2026-11-05',
    startSecondHalf: true,
    dueDate: '2026-11-11',
    dueFirstHalf: true,
  };

  it('starts on a Monday before the plan and places half-day bars', () => {
    const scale = timelineScale([dates], TODAY, 'week');
    expect(new Date(scale.origin * 86_400_000).getUTCDay()).toBe(1);
    const box = barBox(scale, dates);
    // 5 Nov 2nd half to the middle of 11 Nov: 6 days.
    expect(box?.width).toBe(6 * scale.dayWidth);
    expect(barBox(scale, { ...dates, startDate: null })?.marker).toBe('due');
  });

  it('labels weeks over days, months over weeks and years over months', () => {
    const week = scaleTicks(timelineScale([dates], TODAY, 'week'), 'week');
    expect(
      week.lower
        .slice(0, 7)
        .map((t) => t.label)
        .join(''),
    ).toBe('MTWTFSS');
    const month = scaleTicks(timelineScale([dates], TODAY, 'month'), 'month');
    expect(month.upper.some((t) => t.label === 'Nov 2026')).toBe(true);
    const quarter = scaleTicks(timelineScale([dates], TODAY, 'quarter'), 'quarter');
    expect(quarter.upper[0]?.label).toMatch(/^20\d\d$/);
  });
});

describe('pasted rows and predecessors (M9)', () => {
  it('turns lines into titles with indent levels', () => {
    expect(parsePasted('  Plan\n    Draft\tignored\n\n    Review\r\n  Launch', 255)).toEqual([
      { title: 'Plan', level: 0 },
      { title: 'Draft', level: 1 },
      { title: 'Review', level: 1 },
      { title: 'Launch', level: 0 },
    ]);
  });

  it('reads numbers and keys and reports unknown parts', () => {
    const byNumber = new Map([
      [12, item(12)],
      [15, item(15)],
    ]);
    expect(parsePredecessors('12, KLO-15 99', byNumber)).toEqual({
      ids: ['i12', 'i15'],
      unknown: ['99'],
    });
  });
});

describe('rebaseDescendants (M9)', () => {
  it('gives descendants the moved item’s new chain', () => {
    const epic = { id: 'i1', number: 1, key: 'KLO-1', type: 'EPIC' as const, title: 'E' };
    const moved = item(2, { type: 'FEATURE', parentId: 'i1', ancestors: [epic] });
    const child = item(3, {
      parentId: 'i2',
      ancestors: [{ id: 'i2', number: 2, key: 'KLO-2', type: 'FEATURE', title: 'Old' }],
    });
    const [, rebased] = rebaseDescendants([moved, child], moved);
    expect(rebased?.ancestors.map((a) => a.id)).toEqual(['i1', 'i2']);
  });
});

describe('allowedTypes (M9)', () => {
  it('offers only types that fit the parent, the children and the board', () => {
    const story = { id: 's', number: 3, key: 'KLO-3', type: 'STORY' as const, title: 'S' };
    const task = item(4, { ancestors: [story], parentId: 's' });
    expect(allowedTypes(task, [])).toEqual(['TASK', 'BUG']);
    const feature = item(2, { type: 'FEATURE', bucketId: null });
    expect(allowedTypes(feature, ['STORY'])).toEqual(['FEATURE']);
    expect(allowedTypes(item(5), [])).toEqual(['EPIC', 'FEATURE', 'STORY', 'TASK', 'BUG']);
  });
});

describe('percentComplete (M9)', () => {
  it('weights children by working days and reads checklists', () => {
    const epic = item(1, { type: 'EPIC' });
    const ref = { id: 'i1', number: 1, key: 'KLO-1', type: 'EPIC' as const, title: 'E' };
    // 4 days done, 1 day with half its checklist ticked: (4*100 + 1*50) / 5 = 90.
    const done = item(2, {
      parentId: 'i1',
      ancestors: [ref],
      status: 'DONE',
      startDate: '2026-11-02',
      dueDate: '2026-11-05',
    });
    const half = item(3, {
      parentId: 'i1',
      ancestors: [ref],
      checklist: { done: 1, total: 2 },
      startDate: '2026-11-06',
      dueDate: '2026-11-06',
    });
    const [root] = buildTree([epic, done, half]);
    expect(percentComplete(root)).toBe(90);
    expect(percentComplete(root.children[1])).toBe(50);
  });
});
