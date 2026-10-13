import { makeBucket, makeItem, makeMember, makeSprint } from '../../testing/fixtures';
import {
  buildColumns,
  buildTree,
  dropRequest,
  EMPTY_FILTER,
  endOfWeek,
  flattenTree,
  isDueThisWeek,
  isOverdue,
  matchesFilter,
  NONE,
  pruneTree,
} from './board-logic';

const TODAY = '2026-10-14'; // a Wednesday

describe('board logic', () => {
  describe('due dates', () => {
    it('ends the week on Sunday', () => {
      expect(endOfWeek(TODAY)).toBe('2026-10-18');
      expect(endOfWeek('2026-10-18')).toBe('2026-10-18');
      expect(endOfWeek('2026-10-12')).toBe('2026-10-18');
    });

    it('treats unfinished items due before today as overdue', () => {
      expect(isOverdue(makeItem(1, { dueDate: '2026-10-13' }), TODAY)).toBe(true);
      expect(isOverdue(makeItem(1, { dueDate: '2026-10-13', status: 'DONE' }), TODAY)).toBe(false);
      expect(isOverdue(makeItem(1, { dueDate: TODAY }), TODAY)).toBe(false);
      expect(isOverdue(makeItem(1), TODAY)).toBe(false);
    });

    it('finds items due from today to Sunday', () => {
      expect(isDueThisWeek(makeItem(1, { dueDate: TODAY }), TODAY)).toBe(true);
      expect(isDueThisWeek(makeItem(1, { dueDate: '2026-10-18' }), TODAY)).toBe(true);
      expect(isDueThisWeek(makeItem(1, { dueDate: '2026-10-19' }), TODAY)).toBe(false);
      expect(isDueThisWeek(makeItem(1, { dueDate: '2026-10-13' }), TODAY)).toBe(false);
    });
  });

  describe('filters', () => {
    const item = makeItem(7, {
      title: 'Fix login',
      assigneeIds: ['u2'],
      labelIds: ['l1'],
      sprintId: 's1',
      type: 'BUG',
      dueDate: '2026-10-01',
    });

    it('passes everything with no filters', () => {
      expect(matchesFilter(item, EMPTY_FILTER, TODAY)).toBe(true);
    });

    it.each([
      [{ assigneeId: 'u2' }, true],
      [{ assigneeId: 'u3' }, false],
      [{ assigneeId: NONE }, false],
      [{ labelId: 'l1' }, true],
      [{ labelId: 'l2' }, false],
      [{ sprintId: 's1' }, true],
      [{ sprintId: NONE }, false],
      [{ type: 'BUG' }, true],
      [{ type: 'TASK' }, false],
      [{ due: 'overdue' }, true],
      [{ due: 'week' }, false],
      [{ text: 'LOGIN' }, true],
      [{ text: 'klo-7' }, true],
      [{ text: 'other' }, false],
    ] as const)('filter %o → %s', (change, expected) => {
      expect(matchesFilter(item, { ...EMPTY_FILTER, ...change }, TODAY)).toBe(expected);
    });

    it('matches unassigned and sprintless items with the "none" values', () => {
      const bare = makeItem(1);
      expect(matchesFilter(bare, { ...EMPTY_FILTER, assigneeId: NONE }, TODAY)).toBe(true);
      expect(matchesFilter(bare, { ...EMPTY_FILTER, sprintId: NONE }, TODAY)).toBe(true);
    });
  });

  describe('columns', () => {
    const buckets = [makeBucket('b1', 'To Do', 1), makeBucket('b2', 'Done', 2)];
    const members = [makeMember('u2', 'Zoe'), makeMember('u1', 'Ann')];
    const sprints = [
      makeSprint('s1', 'Sprint 1', 'CLOSED'),
      makeSprint('s2', 'Sprint 2', 'ACTIVE'),
    ];
    const lookups = { buckets, members, sprints };
    const items = [
      makeItem(1, { bucketId: 'b2', position: 1, status: 'DONE', assigneeIds: ['u1', 'u2'] }),
      makeItem(2, { bucketId: 'b1', position: 5, sprintId: 's2' }),
      makeItem(3, { bucketId: 'b1', position: 2 }),
      makeItem(4, { type: 'EPIC', bucketId: null }),
    ];

    it('shows buckets in order with cards by position and Epics off the board left out', () => {
      const columns = buildColumns(items, 'bucket', lookups);
      expect(columns.map((c) => [c.id, c.items.map((i) => i.number)])).toEqual([
        ['b1', [3, 2]],
        ['b2', [1]],
      ]);
    });

    it('groups by status', () => {
      const columns = buildColumns(items, 'status', lookups);
      expect(columns.map((c) => c.title)).toEqual([
        'Not started',
        'In progress',
        'Blocked',
        'Done',
      ]);
      expect(columns[0]?.items.map((i) => i.number)).toEqual([3, 2]);
      expect(columns[3]?.items.map((i) => i.number)).toEqual([1]);
    });

    it('groups by assignee, showing a card under each of its assignees', () => {
      const columns = buildColumns(items, 'assignee', lookups);
      expect(columns.map((c) => [c.title, c.items.map((i) => i.number)])).toEqual([
        ['Unassigned', [3, 2]],
        ['Ann', [1]],
        ['Zoe', [1]],
      ]);
    });

    it('groups by sprint and refuses drops into closed sprints that still hold cards', () => {
      const withClosed = [...items, makeItem(5, { sprintId: 's1' })];
      const columns = buildColumns(withClosed, 'sprint', lookups);
      expect(columns.map((c) => [c.title, c.accepts])).toEqual([
        ['No sprint', true],
        ['Sprint 1', false],
        ['Sprint 2', true],
      ]);
      expect(buildColumns(items, 'sprint', lookups).map((c) => c.title)).toEqual([
        'No sprint',
        'Sprint 2',
      ]);
    });
  });

  describe('drops', () => {
    const a = makeItem(1, { position: 1 });
    const b = makeItem(2, { position: 2 });
    const c = makeItem(3, { position: 3 });

    it('moves to another bucket after the card it now follows', () => {
      expect(dropRequest('bucket', c, 'b2', 'b1', [a, b], 1)).toEqual({
        kind: 'move',
        request: { bucketId: 'b1', afterId: 'i1' },
      });
      expect(dropRequest('bucket', c, 'b2', 'b1', [a, b], 0)).toEqual({
        kind: 'move',
        request: { bucketId: 'b1', afterId: null },
      });
    });

    it('reorders within a bucket without naming the bucket', () => {
      // c moves from the end to the first place.
      expect(dropRequest('bucket', c, 'b1', 'b1', [a, b, c], 0)).toEqual({
        kind: 'move',
        request: { afterId: null },
      });
      // a moves from the top to the end.
      expect(dropRequest('bucket', a, 'b1', 'b1', [a, b, c], 2)).toEqual({
        kind: 'move',
        request: { afterId: 'i3' },
      });
      expect(dropRequest('bucket', b, 'b1', 'b1', [a, b, c], 1)).toBeNull();
    });

    it('sets the status, sprint or assignees in the other views', () => {
      expect(dropRequest('status', a, 'NOT_STARTED', 'DONE', [], 0)).toEqual({
        kind: 'update',
        request: { status: 'DONE' },
      });
      expect(dropRequest('sprint', a, 's1', NONE, [], 0)).toEqual({
        kind: 'update',
        request: { sprintId: null },
      });
      const shared = makeItem(4, { assigneeIds: ['u1', 'u2'] });
      expect(dropRequest('assignee', shared, 'u1', 'u3', [], 0)).toEqual({
        kind: 'update',
        request: { assigneeIds: ['u2', 'u3'] },
      });
      expect(dropRequest('assignee', shared, 'u1', NONE, [], 0)).toEqual({
        kind: 'update',
        request: { assigneeIds: [] },
      });
      expect(dropRequest('status', a, 'DONE', 'DONE', [], 0)).toBeNull();
    });
  });

  describe('tree', () => {
    const epicRef = { id: 'i1', number: 1, key: 'KLO-1', type: 'EPIC' as const, title: 'Epic' };
    const featureRef = {
      id: 'i2',
      number: 2,
      key: 'KLO-2',
      type: 'FEATURE' as const,
      title: 'Feature',
    };
    const storyRef = { id: 'i3', number: 3, key: 'KLO-3', type: 'STORY' as const, title: 'Story' };

    it('nests items and shows hidden ancestors as read-only titles', () => {
      // The caller sees the Feature and a Task under a hidden Story, but not the Epic.
      const feature = makeItem(2, { type: 'FEATURE', parentId: 'i1', ancestors: [epicRef] });
      const task = makeItem(4, {
        parentId: 'i3',
        ancestors: [epicRef, featureRef, storyRef],
      });
      const loose = makeItem(5, { type: 'BUG' });
      const roots = buildTree([task, loose, feature]);
      const rows = flattenTree(roots, new Set());
      expect(rows.map((r) => [r.node.ref.key, r.depth, r.node.item === null])).toEqual([
        ['KLO-1', 0, true],
        ['KLO-2', 1, false],
        ['KLO-3', 2, true],
        ['KLO-4', 3, false],
        ['KLO-5', 0, false],
      ]);
      expect(flattenTree(roots, new Set(['i2'])).map((r) => r.node.ref.key)).toEqual([
        'KLO-1',
        'KLO-2',
        'KLO-5',
      ]);
    });

    it('keeps the path to filtered matches', () => {
      const feature = makeItem(2, { type: 'FEATURE', title: 'Feature' });
      const story = makeItem(3, {
        type: 'STORY',
        title: 'Login',
        parentId: 'i2',
        ancestors: [featureRef],
      });
      const other = makeItem(6, { title: 'Other' });
      const pruned = pruneTree(buildTree([feature, story, other]), (i) => i.title === 'Login');
      expect(flattenTree(pruned, new Set()).map((r) => r.node.ref.key)).toEqual(['KLO-2', 'KLO-3']);
    });
  });
});
