import {
  endSlot,
  finishAfter,
  isHoliday,
  isValidDuration,
  isWorkingDay,
  KeptReason,
  PinAction,
  type PlanItem,
  planSchedule,
  scheduleSpan,
  slotHalfDay,
  startSlot,
  startsAfterFinish,
  workCalendar,
  workingDuration,
} from './index.js';

/** Dates for a test item. */
const span = (
  startDate: string | null,
  dueDate: string | null,
  startSecondHalf = false,
  dueFirstHalf = false,
) => ({ startDate, dueDate, startSecondHalf, dueFirstHalf });

/** A Not started, editable test item. */
const item = (
  id: string,
  dates: ReturnType<typeof span>,
  extra: Partial<PlanItem> = {},
): PlanItem => ({
  id,
  ...dates,
  status: 'NOT_STARTED',
  pin: null,
  editable: true,
  ...extra,
});

describe('working half days (M9)', () => {
  it('counts Monday to Friday only', () => {
    expect(isWorkingDay('2026-11-02')).toBe(true);
    expect(isWorkingDay('2026-11-06')).toBe(true);
    expect(isWorkingDay('2026-11-07')).toBe(false);
    expect(isWorkingDay('2026-11-08')).toBe(false);
  });

  it('round-trips slots and skips weekends', () => {
    const friday2 = endSlot('2026-11-06', false);
    expect(slotHalfDay(friday2)).toEqual({ date: '2026-11-06', second: true });
    expect(slotHalfDay(friday2 + 1)).toEqual({ date: '2026-11-09', second: false });
    expect(startSlot('2026-11-07', true)).toBe(friday2 + 1);
    expect(endSlot('2026-11-08', true)).toBe(friday2);
  });

  it('measures durations in halves, both ends included', () => {
    expect(workingDuration(span('2026-11-02', '2026-11-02', false, true))).toBe(0.5);
    expect(workingDuration(span('2026-11-02', '2026-11-03', true, true))).toBe(1);
    expect(workingDuration(span('2026-11-02', '2026-11-06'))).toBe(5);
    expect(workingDuration(span('2026-11-05', '2026-11-10'))).toBe(4);
    expect(workingDuration(span('2026-11-07', '2026-11-08'))).toBe(0);
    expect(workingDuration(span('2026-11-07', '2026-11-09'))).toBe(1);
    expect(workingDuration(span('2026-11-02', null))).toBe(0);
  });

  it('finds the finish of a duration', () => {
    expect(finishAfter({ date: '2026-11-05', second: true }, 4)).toEqual({
      dueDate: '2026-11-11',
      dueFirstHalf: true,
    });
    expect(finishAfter({ date: '2026-11-09', second: false }, 8)).toEqual({
      dueDate: '2026-11-18',
      dueFirstHalf: false,
    });
    expect(finishAfter({ date: '2026-11-07', second: true }, 0.5)).toEqual({
      dueDate: '2026-11-09',
      dueFirstHalf: true,
    });
  });

  it('validates durations and half-day order', () => {
    expect(isValidDuration(0.5)).toBe(true);
    expect(isValidDuration(2.5)).toBe(true);
    expect(isValidDuration(0)).toBe(false);
    expect(isValidDuration(1.25)).toBe(false);
    expect(startsAfterFinish(span('2026-11-02', '2026-11-02', true, true))).toBe(true);
    expect(startsAfterFinish(span('2026-11-02', '2026-11-02', true, false))).toBe(false);
    expect(startsAfterFinish(span('2026-11-03', '2026-11-02'))).toBe(true);
  });
});

describe('planSchedule (M9)', () => {
  // The mockup plan: WEB-10 precedes WEB-11 (Draft copy) and WEB-13 (pinned).
  const workshop = item('w', span('2026-11-04', '2026-11-05', false, true), { status: 'DONE' });
  const draft = item('d', span('2026-11-05', '2026-11-11', true, true));
  const templates = item('t', span('2026-11-09', '2026-11-18'), {
    pin: { date: '2026-11-09', second: false },
  });
  const review = item('r', span('2026-11-11', '2026-11-13', true));
  const edges = [
    { blockingItemId: 'w', blockedItemId: 'd' },
    { blockingItemId: 'w', blockedItemId: 't' },
    { blockingItemId: 'd', blockedItemId: 'r' },
  ];

  it('pulls dependent items earlier and keeps a pinned one', () => {
    const plan = planSchedule([workshop, draft, templates, review], edges, [
      { id: 'w', dates: span('2026-11-04', '2026-11-04') },
    ]);
    const to = Object.fromEntries(plan.changes.map((c) => [c.id, c.to]));
    expect(to['d']).toEqual(span('2026-11-05', '2026-11-10'));
    expect(to['r']).toEqual(span('2026-11-11', '2026-11-13', false, true));
    expect(to['t']).toBeUndefined();
    expect(plan.kept).toEqual([{ id: 't', reason: KeptReason.PINNED }]);
    expect(plan.changes.map((c) => c.requested)).toEqual([true, false, false]);
  });

  it('pushes items later, past a pin, and back to the pin when room returns', () => {
    const longer = planSchedule([workshop, draft, templates, review], edges, [
      { id: 'w', dates: span('2026-11-04', '2026-11-11') },
    ]);
    const to = Object.fromEntries(longer.changes.map((c) => [c.id, c.to]));
    expect(to['t']).toEqual(span('2026-11-12', '2026-11-23'));
    const pushed = { ...templates, ...to['t'] };
    const shorter = planSchedule(
      [{ ...workshop, ...span('2026-11-04', '2026-11-11') }, pushed],
      edges,
      [{ id: 'w', dates: span('2026-11-04', '2026-11-04') }],
    );
    expect(shorter.changes.find((c) => c.id === 't')?.to).toEqual(span('2026-11-09', '2026-11-18'));
  });

  it('keeps started and non-editable items and stops the chain there', () => {
    const started = { ...draft, status: 'IN_PROGRESS' as const };
    const plan = planSchedule([workshop, started, review], edges, [
      { id: 'w', dates: span('2026-11-04', '2026-11-09') },
    ]);
    expect(plan.kept).toEqual([{ id: 'd', reason: KeptReason.STARTED }]);
    expect(plan.changes.map((c) => c.id)).toEqual(['w']);

    const locked = { ...draft, editable: false };
    const second = planSchedule([workshop, locked, review], edges, [
      { id: 'w', dates: span('2026-11-04', '2026-11-04') },
    ]);
    expect(second.kept).toEqual([{ id: 'd', reason: KeptReason.NOT_EDITABLE }]);
    expect(second.changes.map((c) => c.id)).toEqual(['w']);
  });

  it('pins a deliberately later start and snaps an impossible earlier one', () => {
    const later = planSchedule([workshop, draft], edges, [
      { id: 'd', dates: span('2026-11-09', '2026-11-12', false, true) },
    ]);
    expect(later.changes[0]?.pinTo).toEqual({ date: '2026-11-09', second: false });
    expect(later.changes[0]?.snapped).toBe(false);

    const earlier = planSchedule([workshop, draft], edges, [
      { id: 'd', dates: span('2026-11-03', '2026-11-09', false, true) },
    ]);
    expect(earlier.changes[0]?.snapped).toBe(true);
    expect(earlier.changes[0]?.to).toEqual(span('2026-11-05', '2026-11-11', true));
    expect(earlier.changes[0]?.pinTo).toBeNull();
  });

  it('removes a pin and moves the item to its earliest start', () => {
    const plan = planSchedule([workshop, templates], edges, [{ id: 't', pin: PinAction.REMOVE }]);
    expect(plan.changes[0]?.to).toEqual(span('2026-11-05', '2026-11-17', true, true));
    expect(plan.changes[0]?.pinTo).toBeNull();
  });

  it('drops a pin whose start is cleared or whose last predecessor is gone', () => {
    const cleared = planSchedule([workshop, templates], edges, [
      { id: 't', dates: span(null, '2026-11-18') },
    ]);
    expect(cleared.changes[0]?.pinTo).toBeNull();
    expect(cleared.changes[0]?.to).toEqual(span(null, '2026-11-18'));

    // Rescheduled after its only link was removed: the dates stay, the pin goes.
    const unlinked = planSchedule([workshop, templates], [], [{ id: 't' }]);
    expect(unlinked.changes[0]?.pinTo).toBeNull();
    expect(unlinked.changes[0]?.to).toEqual(span('2026-11-09', '2026-11-18'));

    // Still linked: the pin holds, as before.
    const linked = planSchedule([workshop, templates], edges, [{ id: 't' }]);
    expect(linked.changes).toEqual([]);
    // An exact pin (Undo) is kept whatever the links.
    const undo = planSchedule([workshop, templates], [], [{ id: 't', pin: PinAction.KEEP }]);
    expect(undo.changes).toEqual([]);
  });

  it('ignores start-only predecessors and leaves items without predecessors alone', () => {
    const startOnly = item('s', span('2026-11-20', null));
    const plan = planSchedule(
      [startOnly, draft],
      [{ blockingItemId: 's', blockedItemId: 'd' }],
      [{ id: 's', dates: span('2026-11-23', null) }],
    );
    expect(plan.changes.map((c) => c.id)).toEqual(['s']);
  });

  it('places a due-only successor at its earliest half day', () => {
    const dueOnly = item('o', span(null, '2026-11-02'));
    const plan = planSchedule(
      [workshop, dueOnly],
      [{ blockingItemId: 'w', blockedItemId: 'o' }],
      [{ id: 'w', dates: span('2026-11-04', '2026-11-05', false, true) }, { id: 'o' }],
    );
    expect(plan.changes.find((c) => c.id === 'o')?.to).toEqual(span(null, '2026-11-05'));
  });

  it('only uses the links it is given, so hidden items never count', () => {
    const plan = planSchedule(
      [workshop, draft],
      [],
      [{ id: 'w', dates: span('2026-11-04', '2026-11-04') }],
    );
    expect(plan.changes.map((c) => c.id)).toEqual(['w']);
  });
});

describe('scheduleSpan (M9)', () => {
  it('spans first start to last finish and sums the work', () => {
    const result = scheduleSpan([
      span('2026-11-02', '2026-11-03'),
      span('2026-11-04', '2026-11-05', false, true),
      span(null, null),
      span('2026-11-10', '2026-11-12', false, true),
    ]);
    expect(result).toEqual({
      start: { date: '2026-11-02', second: false },
      finish: { dueDate: '2026-11-12', dueFirstHalf: true },
      duration: 8.5,
      work: 6,
    });
    expect(scheduleSpan([span(null, null)])).toBeNull();
  });
});

describe('holidays (M9.1)', () => {
  // Wednesday 4 Nov 2026 is a holiday; the weekend in the range is ignored.
  const cal = workCalendar([{ startDate: '2026-11-04', endDate: '2026-11-04' }]);
  const two = workCalendar([{ startDate: '2026-11-04', endDate: '2026-11-08' }]);

  it('skips holidays in durations, finishes and slots', () => {
    expect(isHoliday('2026-11-04', cal)).toBe(true);
    expect(isHoliday('2026-11-07', two)).toBe(false);
    expect(workingDuration(span('2026-11-02', '2026-11-06'), cal)).toBe(4);
    expect(finishAfter({ date: '2026-11-02', second: false }, 3, cal)).toEqual({
      dueDate: '2026-11-05',
      dueFirstHalf: false,
    });
    expect(finishAfter({ date: '2026-11-02', second: false }, 3, two)).toEqual({
      dueDate: '2026-11-09',
      dueFirstHalf: false,
    });
    // A start on a holiday counts from the next working day, a finish to the previous one.
    expect(slotHalfDay(startSlot('2026-11-04', true, cal), cal)).toEqual({
      date: '2026-11-05',
      second: false,
    });
    expect(slotHalfDay(endSlot('2026-11-04', true, cal), cal)).toEqual({
      date: '2026-11-03',
      second: true,
    });
    for (let slot = 7010; slot < 7040; slot++) {
      const half = slotHalfDay(slot, two);
      expect(startSlot(half.date, half.second, two)).toBe(slot);
    }
  });

  it('moves dependent items past holidays', () => {
    const pred = item('p', span('2026-11-02', '2026-11-03'));
    const succ = item('s', span('2026-11-04', '2026-11-05'));
    const plan = planSchedule(
      [pred, succ],
      [{ blockingItemId: 'p', blockedItemId: 's' }],
      [{ id: 's' }],
      cal,
    );
    // Its one working day (Thursday; Wednesday is a holiday) follows the predecessor.
    expect(plan.changes[0]?.to).toEqual(span('2026-11-05', '2026-11-05'));
    expect(scheduleSpan([pred, span('2026-11-05', '2026-11-06')], cal)?.duration).toBe(4);
    expect(scheduleSpan([pred, span('2026-11-05', '2026-11-05')], cal)?.duration).toBe(3);
  });
});
