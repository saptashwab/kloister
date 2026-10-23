import { dueNow, dueTimeToMinutes, isOverdueAt, minutesToDueTime } from './index.js';

describe('due times (M8.5)', () => {
  const now = { date: '2026-10-23', minutes: 10 * 60 };

  it('converts between wire times and minutes', () => {
    expect(dueTimeToMinutes('17:05')).toBe(1025);
    expect(minutesToDueTime(1025)).toBe('17:05');
    expect(minutesToDueTime(0)).toBe('00:00');
    expect(dueNow(new Date(2026, 9, 23, 9, 30))).toEqual({ date: '2026-10-23', minutes: 570 });
  });

  it('makes a timed item overdue once its time has passed, an untimed one the next day', () => {
    const open = 'NOT_STARTED' as const;
    expect(isOverdueAt({ dueDate: '2026-10-23', dueTime: '09:59', status: open }, now)).toBe(true);
    expect(isOverdueAt({ dueDate: '2026-10-23', dueTime: '10:00', status: open }, now)).toBe(false);
    expect(isOverdueAt({ dueDate: '2026-10-23', dueTime: null, status: open }, now)).toBe(false);
    expect(isOverdueAt({ dueDate: '2026-10-22', status: open }, now)).toBe(true);
    expect(isOverdueAt({ dueDate: '2026-10-22', status: 'DONE' }, now)).toBe(false);
    expect(isOverdueAt({ dueDate: null, status: open }, now)).toBe(false);
  });
});

describe('audit action groups (M8.5)', () => {
  it('list every action exactly once', async () => {
    const { AUDIT_ACTION_GROUPS, AuditAction } = await import('./index.js');
    const grouped = AUDIT_ACTION_GROUPS.flatMap((g) => g.actions);
    expect([...grouped].sort()).toEqual(Object.values(AuditAction).sort());
  });
});
