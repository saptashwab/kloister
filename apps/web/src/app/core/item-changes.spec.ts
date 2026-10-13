import { makeItem } from '../../testing/fixtures';
import {
  daysBetween,
  dueState,
  dueText,
  revertFields,
  revertMove,
  shortDate,
  undoFields,
} from './item-changes';

describe('item changes', () => {
  const today = '2026-10-15';

  it('counts calendar days', () => {
    expect(daysBetween('2026-10-15', '2026-10-18')).toBe(3);
    expect(daysBetween('2026-10-15', '2026-10-13')).toBe(-2);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
  });

  it('formats short dates', () => {
    expect(shortDate('2026-10-17')).toBe('Sat 17 Oct');
  });

  it('classifies due dates (DESIGN §3.4)', () => {
    expect(dueState({ dueDate: null, status: 'NOT_STARTED' }, today)).toBeNull();
    expect(dueState({ dueDate: '2026-10-14', status: 'IN_PROGRESS' }, today)).toBe('overdue');
    expect(dueState({ dueDate: '2026-10-14', status: 'DONE' }, today)).toBe('later');
    expect(dueState({ dueDate: '2026-10-15', status: 'NOT_STARTED' }, today)).toBe('soon');
    expect(dueState({ dueDate: '2026-10-18', status: 'NOT_STARTED' }, today)).toBe('soon');
    expect(dueState({ dueDate: '2026-10-19', status: 'NOT_STARTED' }, today)).toBe('later');
  });

  it('words due dates', () => {
    const at = (dueDate: string): string => dueText({ dueDate, status: 'NOT_STARTED' }, today);
    expect(at('2026-10-13')).toBe('2 days overdue');
    expect(at('2026-10-14')).toBe('1 day overdue');
    expect(at('2026-10-15')).toBe('Due today');
    expect(at('2026-10-16')).toBe('Due tomorrow');
    expect(at('2026-10-18')).toBe('Due in 3 days');
    expect(at('2026-10-24')).toBe('Sat 24 Oct');
    expect(dueText({ dueDate: null, status: 'DONE' }, today)).toBe('');
  });

  it('builds the PATCH that reverts changed fields only', () => {
    const before = makeItem(1, {
      status: 'NOT_STARTED',
      assigneeIds: ['u1', 'u2'],
      sprintId: null,
    });
    const after = makeItem(1, { status: 'IN_PROGRESS', assigneeIds: ['u2', 'u1'], sprintId: 's1' });
    expect(revertFields(before, after)).toEqual({ status: 'NOT_STARTED', sprintId: null });
    expect(revertFields(before, before)).toBeNull();
  });

  it('undoes only what the change did, plus a status set by the move back', () => {
    const before = makeItem(1, { priority: 3, title: 'A' });
    const after = makeItem(1, { priority: 1, title: 'A' });
    // Someone renamed the item after the change: the rename stays.
    const current = makeItem(1, { priority: 1, title: 'B' });
    expect(undoFields(before, after, current)).toEqual({ priority: 3 });
    const moved = makeItem(1, { status: 'DONE' });
    expect(undoFields(before, before, moved)).toEqual({ status: 'NOT_STARTED' });
    expect(undoFields(before, before, before)).toBeNull();
  });

  it('builds the move that puts a card back', () => {
    const before = makeItem(1, { bucketId: 'b1' });
    const after = makeItem(1, { bucketId: 'b2' });
    expect(revertMove(before, after, 'i7')).toEqual({ bucketId: 'b1', afterId: 'i7' });
    expect(revertMove(before, after, null)).toEqual({ bucketId: 'b1', afterId: null });
    expect(revertMove(before, before, 'i3')).toEqual({ afterId: 'i3' });
    expect(revertMove(before, before, undefined)).toBeNull();
  });
});
