import {
  addDays,
  ItemStatus,
  ItemType,
  PinAction,
  type PlanEdge,
  planSchedule,
  type PreviewItem,
  previewReschedule,
  toPlanChange,
  workCalendar,
} from './index.js';

// The local reschedule preview (v1.4.1) must plan what the API's preview
// plans: the API builds its plan changes with the same `toPlanChange` and
// runs the same planner over the caller's visible, non-ad-hoc items.

/**
 * A chain-heavy plan: `count` items in parallel chains of ten, each item
 * blocked by the one before it and by the same place in the chain before.
 *
 * @param count How many items.
 * @returns Items and links.
 */
function bigPlan(count: number): { items: PreviewItem[]; edges: PlanEdge[] } {
  const items: PreviewItem[] = [];
  const edges: PlanEdge[] = [];
  for (let n = 0; n < count; n++) {
    const start = addDays('2026-11-02', (n % 10) * 7);
    items.push({
      id: `item-${n}`,
      startDate: start,
      startSecondHalf: false,
      dueDate: addDays(start, 4),
      dueFirstHalf: false,
      // Every 37th item is started and stays; every 41st cannot be edited.
      status: n % 37 === 0 ? ItemStatus.IN_PROGRESS : ItemStatus.NOT_STARTED,
      pin: n % 53 === 0 ? { date: start, second: false } : null,
      editable: n % 41 !== 0,
      ref: { id: `item-${n}`, number: n + 1, key: `KLO-${n + 1}`, type: ItemType.TASK, title: '' },
      version: `2026-11-01T00:00:00.${String(n % 1000).padStart(3, '0')}Z`,
    });
    if (n % 10 !== 0) edges.push({ blockingItemId: `item-${n - 1}`, blockedItemId: `item-${n}` });
    if (n >= 10) edges.push({ blockingItemId: `item-${n - 10}`, blockedItemId: `item-${n}` });
  }
  return { items, edges };
}

describe('previewReschedule', () => {
  const cal = workCalendar([
    { startDate: '2026-12-24', endDate: '2026-12-26' },
    { startDate: '2026-11-19', endDate: '2026-11-19' },
  ]);

  it('plans a large project as the API does, quickly', () => {
    const { items, edges } = bigPlan(600);
    const changes = [
      { item: 'item-0', startDate: '2026-11-09', dueDate: '2026-11-13' },
      { item: 'item-300', startDate: '2026-11-16' },
    ];
    const started = performance.now();
    const preview = previewReschedule(items, edges, changes, cal);
    const took = performance.now() - started;
    // What the API computes for the same request (timeline.service.ts).
    const byId = new Map(items.map((i) => [i.id, i]));
    const plan = planSchedule(
      items,
      edges,
      changes.map((c) => toPlanChange(c, c.item, byId.get(c.item)!)),
      cal,
    );
    expect(preview).not.toBeNull();
    expect(preview!.changes.length).toBeGreaterThan(50);
    expect(preview!.changes.map((c) => [c.item.id, c.from, c.to, c.pinFrom, c.pinTo])).toEqual(
      plan.changes.map((c) => [c.id, c.from, c.to, c.pinFrom, c.pinTo]),
    );
    expect(preview!.changes.map((c) => c.version)).toEqual(
      plan.changes.map((c) => byId.get(c.id)!.version),
    );
    expect(preview!.kept.map((k) => [k.item.id, k.reason])).toEqual(
      plan.kept.map((k) => [k.id, k.reason]),
    );
    expect(preview!.items).toEqual([]);
    expect(preview!.rescheduleId).toBeNull();
    // Opening the dialog at once needs the plan in well under a frame budget or two.
    expect(took).toBeLessThan(250);
  });

  it('answers null when a requested item is not among the visible ones', () => {
    const { items, edges } = bigPlan(20);
    expect(previewReschedule(items, edges, [{ item: 'hidden', startDate: null }])).toBeNull();
  });

  it('builds plan changes from requests as the API did', () => {
    const current = {
      startDate: '2026-11-02',
      startSecondHalf: true,
      dueDate: '2026-11-06',
      dueFirstHalf: true,
    };
    expect(toPlanChange({ item: '7' }, 'id-7', current)).toEqual({
      id: 'id-7',
      pin: PinAction.AUTO,
    });
    expect(toPlanChange({ item: '7', dueDate: '2026-11-09' }, 'id-7', current)).toEqual({
      id: 'id-7',
      dates: { ...current, dueDate: '2026-11-09' },
      pin: PinAction.AUTO,
    });
    expect(toPlanChange({ item: '7', startDate: null, pinTo: null }, 'id-7', current)).toEqual({
      id: 'id-7',
      dates: { ...current, startDate: null, startSecondHalf: false },
      pin: PinAction.KEEP,
    });
  });
});
