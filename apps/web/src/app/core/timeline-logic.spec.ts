import { makeItem as item } from '../../testing/fixtures';
import { buildTree } from './board-logic';
import { workCalendar } from '@kloister/shared';
import {
  allowedTypes,
  applyOutlineMoves,
  keepDurations,
  percentComplete,
  barBox,
  childTypeOf,
  conflicts,
  dueText,
  dropTarget,
  durationText,
  indentTarget,
  outdentTarget,
  parseDuration,
  parseHalfDay,
  parsePasted,
  parsePredecessors,
  planSpan,
  previousSibling,
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

  it('finds where dragged rows land, fitting their types (v1.3.1, v1.3.2)', () => {
    const rows = timelineRows(buildTree([epic, a, b]), new Set());
    const without = (...ids: string[]) => rows.filter((r) => !ids.includes(r.node.id));
    // b dropped between the Epic and a: the Epic's first child.
    expect(dropTarget(without('i3'), 1, 0, [{ item: b, childTypes: [] }]).moves).toEqual([
      { item: b, move: { afterId: null } },
    ]);
    // a dropped after b one level deeper: under b, as a Story.
    const underB = dropTarget(without('i2'), 2, 2, [{ item: a, childTypes: [] }]);
    expect(underB.moves?.[0]?.move).toEqual({ afterId: null, parentId: 'i3', type: 'STORY' });
    expect(underB.parent?.id).toBe('i3');
    // ...but not when its own Stories could not stay under a Story.
    expect(dropTarget(without('i2'), 2, 2, [{ item: a, childTypes: ['STORY'] }]).moves).toBeNull();
    // a dropped after b at the top level: after the Epic, keeping its type.
    expect(dropTarget(without('i2'), 2, 0, [{ item: a, childTypes: [] }])).toEqual({
      moves: [{ item: a, move: { afterId: 'i1', parentId: null } }],
      parent: null,
      depth: 0,
      reason: '',
    });
    // Both Features at the top level: in their order, each after the one before.
    const both = [
      { item: a, childTypes: [] },
      { item: b, childTypes: [] },
    ];
    expect(dropTarget(without('i2', 'i3'), 1, 0, both).moves?.map((m) => m.move)).toEqual([
      { afterId: 'i1', parentId: null },
      { afterId: 'i2', parentId: null },
    ]);
    // A row that cannot go there is named.
    const story = item(4, { type: 'STORY', adHoc: true });
    expect(
      dropTarget(without('i2', 'i3'), 1, 1, [...both, { item: story, childTypes: [] }]).reason,
    ).toBe('KLO-4: An ad-hoc item has no parent');
  });

  it('shows placements at once, as the server will store them (v1.3.2)', () => {
    const c = item(4, {
      parentId: 'i2',
      ancestors: [
        ...a.ancestors,
        { id: 'i2', number: 2, key: 'KLO-2', type: 'FEATURE', title: 'Item 2' },
      ],
      type: 'TASK',
    });
    // b before a under the Epic: the unplaced siblings are numbered first.
    const first = applyOutlineMoves([epic, a, b, c], [{ id: 'i3', move: { afterId: null } }]);
    expect(first.map((i) => [i.id, i.outlinePosition])).toEqual([
      ['i2', 1024],
      ['i3', 0],
    ]);
    expect(previousSibling([epic, a, b, c], b)).toBe('i2');
    // A batch: each placement sees the ones before it.
    const both = applyOutlineMoves(
      [epic, a, b, c],
      [
        { id: 'i3', move: { afterId: null } },
        { id: 'i2', move: { afterId: 'i3' } },
      ],
    );
    const at = new Map(both.map((i) => [i.id, i.outlinePosition ?? NaN]));
    expect(at.get('i3')! < at.get('i2')!).toBe(true);
    // Neighbours too close together are numbered again first.
    const close = [
      { ...a, outlinePosition: 1 },
      { ...b, outlinePosition: 1 + 1e-7 },
    ];
    const roomy = applyOutlineMoves(
      [epic, ...close, c],
      [{ id: 'i4', move: { afterId: 'i2', parentId: 'i1' } }],
    );
    expect(roomy.map((i) => [i.id, i.outlinePosition])).toEqual(
      expect.arrayContaining([
        ['i2', 1024],
        ['i3', 2048],
        ['i4', 1536],
      ]),
    );
    // a under b as a Story: its own Task follows it under b.
    const moved = applyOutlineMoves(
      [epic, a, b, c],
      [{ id: 'i2', move: { afterId: null, parentId: 'i3', type: 'STORY' } }],
    );
    const byId = new Map(moved.map((i) => [i.id, i]));
    expect(byId.get('i2')).toMatchObject({ parentId: 'i3', type: 'STORY' });
    expect(byId.get('i4')?.ancestors.map((r) => [r.id, r.type])).toEqual([
      ['i1', 'EPIC'],
      ['i3', 'FEATURE'],
      ['i2', 'STORY'],
    ]);
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

  it('indents under the previous sibling and outdents to the grandparent, fixing the type', () => {
    const rows = timelineRows(buildTree([epic, a, b]), new Set());
    // A Feature indented under a Feature becomes a Story (v1.3.1)...
    expect(indentTarget(rows, 2)).toEqual({ parentId: a.id, type: 'STORY' });
    // ...unless its own children could not stay under a Story.
    expect(indentTarget(rows, 2, ['STORY'])).toEqual({
      error: 'It would become a User Story, which cannot hold its User Story items',
    });
    expect(indentTarget(rows, 0)).toEqual({
      error: 'There is no row above at the same level to indent under',
    });
    expect(outdentTarget(rows, 1)).toEqual({ parentId: null });
    const task = item(6, { parentId: 'i2', ancestors: [...a.ancestors, { ...a, number: 2 }] });
    const deep = timelineRows(buildTree([epic, a, task]), new Set());
    // A Task outdented to sit under an Epic becomes a Feature.
    expect(outdentTarget(deep, 2)).toEqual({ parentId: epic.id, type: 'FEATURE' });
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
  it('offers only types that fit the parent and the children', () => {
    const story = { id: 's', number: 3, key: 'KLO-3', type: 'STORY' as const, title: 'S' };
    const task = item(4, { ancestors: [story], parentId: 's' });
    expect(allowedTypes(task, [])).toEqual(['TASK', 'BUG']);
    const feature = item(2, { type: 'FEATURE', bucketId: null });
    expect(allowedTypes(feature, ['STORY'])).toEqual(['FEATURE']);
    // Off the board, a childless Feature may still become a Story, Task or Bug (v1.3.1).
    expect(allowedTypes(feature, [])).toEqual(['EPIC', 'FEATURE', 'STORY', 'TASK', 'BUG']);
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

describe('keepDurations (M9.1)', () => {
  it('keeps working days of Not started items over new holidays', () => {
    const range = { startDate: '2026-11-04', endDate: '2026-11-04' };
    const before = workCalendar([]);
    const after = workCalendar([range]);
    const touched = item(1, { startDate: '2026-11-02', dueDate: '2026-11-04' });
    const onHoliday = item(2, { startDate: '2026-11-04', dueDate: '2026-11-04' });
    const started = item(3, {
      startDate: '2026-11-02',
      dueDate: '2026-11-04',
      status: 'IN_PROGRESS',
    });
    const elsewhere = item(4, { startDate: '2026-11-09', dueDate: '2026-11-10' });
    expect(keepDurations([touched, onHoliday, started, elsewhere], [range], before, after)).toEqual(
      [
        {
          item: 'i1',
          startDate: '2026-11-02',
          startSecondHalf: false,
          dueDate: '2026-11-05',
          dueFirstHalf: false,
          pin: 'keep',
        },
        {
          item: 'i2',
          startDate: '2026-11-05',
          startSecondHalf: false,
          dueDate: '2026-11-05',
          dueFirstHalf: false,
          pin: 'keep',
        },
      ],
    );
  });
});
