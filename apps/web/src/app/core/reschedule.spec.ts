import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { HttpErrorResponse } from '@angular/common/http';
import type { DestroyRef } from '@angular/core';
import { NO_HOLIDAYS, type RescheduleResultDto } from '@kloister/shared';
import { of } from 'rxjs';
import { makeItem, makeProject } from '../../testing/fixtures';
import { ToastService } from '../ui/toast.service';
import { ItemsApiService } from './items-api.service';
import { ProjectContext } from './project-context';
import { ProjectsApiService } from './projects-api.service';
import { changePatch, PLAN_CHANGED_NOTE, RescheduleFlow } from './reschedule';

const dates = (start: string, due: string) => ({
  startDate: start,
  startSecondHalf: false,
  dueDate: due,
  dueFirstHalf: false,
});

/** A plan where KLO-2 was asked for and KLO-3 follows. */
function plan(withDependent: boolean): RescheduleResultDto {
  const change = (n: number, requested: boolean) => ({
    item: { id: `i${n}`, number: n, key: `KLO-${n}`, type: 'TASK' as const, title: `Item ${n}` },
    from: dates('2026-11-02', '2026-11-03'),
    to: dates('2026-11-04', '2026-11-05'),
    pinFrom: null,
    pinTo: null,
    requested,
    snapped: false,
    version: '2026-01-01T00:00:00.000Z',
  });
  return {
    changes: withDependent ? [change(2, true), change(3, false)] : [change(2, true)],
    kept: [],
    items: [],
    rescheduleId: null,
  };
}

describe('RescheduleFlow (M9)', () => {
  function setup(auto: boolean, choice: unknown = null) {
    const api = { reschedule: vi.fn() };
    const projects = { get: vi.fn(), update: vi.fn() };
    const toast = { show: vi.fn(), error: vi.fn() };
    const dialog = { open: vi.fn().mockReturnValue({ afterClosed: () => of(choice) }) };
    TestBed.configureTestingModule({
      providers: [
        ProjectContext,
        RescheduleFlow,
        { provide: ItemsApiService, useValue: api },
        { provide: ProjectsApiService, useValue: projects },
        { provide: ToastService, useValue: toast },
        { provide: MatDialog, useValue: dialog },
      ],
    });
    const ctx = TestBed.inject(ProjectContext);
    const base = makeProject();
    ctx.project.set({ ...base, settings: { ...base.settings, autoMoveDependents: auto } });
    ctx.items.set([makeItem(2), makeItem(3)]);
    return { flow: TestBed.inject(RescheduleFlow), api, toast, dialog, projects, ctx };
  }

  /**
   * Lets the open page offer its links: KLO-3 follows KLO-2 (v1.4.1).
   *
   * @param ctx The project store.
   */
  function offerPlan(ctx: ProjectContext): void {
    ctx.items.set([
      makeItem(2, dates('2026-11-02', '2026-11-03')),
      makeItem(3, dates('2026-11-04', '2026-11-05')),
    ]);
    const destroy = { onDestroy: () => () => undefined } as unknown as DestroyRef;
    ctx.registerPlan(
      () => ({ edges: [{ blockingItemId: 'i2', blockedItemId: 'i3' }], calendar: NO_HOLIDAYS }),
      destroy,
    );
  }

  it('applies at once with automatic moving and offers an exact Undo', async () => {
    const { flow, api, toast } = setup(true);
    const applied = { ...plan(true), items: [makeItem(2), makeItem(3)], rescheduleId: 'r1' };
    api.reschedule.mockResolvedValueOnce(applied).mockResolvedValueOnce({ ...applied, items: [] });
    await flow.change([{ item: 'i2', startDate: '2026-11-04' }]);
    expect(api.reschedule).toHaveBeenCalledTimes(1);
    expect(api.reschedule.mock.calls[0]?.[1]).toMatchObject({ mode: 'apply' });
    const [message, undo] = toast.show.mock.calls[0] as [string, () => Promise<void>];
    expect(message).toBe('KLO-2 updated · moved KLO-3');
    await undo();
    expect(api.reschedule.mock.calls[1]?.[1]).toMatchObject({
      mode: 'only',
      changes: [
        { item: 'i2', startDate: '2026-11-02', pinTo: null },
        { item: 'i3', startDate: '2026-11-02', pinTo: null },
      ],
    });
  });

  it('applies a change that moves nothing else without asking', async () => {
    const { flow, api, dialog } = setup(false);
    api.reschedule.mockResolvedValueOnce(plan(false)).mockResolvedValueOnce(plan(false));
    await flow.change([{ item: 'i2', dueDate: '2026-11-05' }]);
    expect(dialog.open).not.toHaveBeenCalled();
    expect(api.reschedule.mock.calls.map((c) => (c[1] as { mode: string }).mode)).toEqual([
      'preview',
      'apply',
    ]);
  });

  it('asks before dependent moves and sends the previewed plan back', async () => {
    const { flow, api, dialog } = setup(false, { move: true, always: false });
    api.reschedule.mockResolvedValueOnce(plan(true)).mockResolvedValueOnce(plan(true));
    await flow.change([{ item: 'i2', startDate: '2026-11-04' }]);
    expect(dialog.open).toHaveBeenCalled();
    expect(api.reschedule.mock.calls[1]?.[1]).toMatchObject({
      mode: 'apply',
      previewed: [{ id: 'i3', to: dates('2026-11-04', '2026-11-05') }],
      expect: { i2: '2026-01-01T00:00:00.000Z', i3: '2026-01-01T00:00:00.000Z' },
    });
  });

  it('changes only the requested item, or nothing when cancelled', async () => {
    const only = setup(false, { move: false, always: false });
    only.api.reschedule.mockResolvedValueOnce(plan(true)).mockResolvedValueOnce(plan(false));
    await only.flow.change([{ item: 'i2', startDate: '2026-11-04' }]);
    expect(only.api.reschedule.mock.calls[1]?.[1]).toMatchObject({ mode: 'only' });
    TestBed.resetTestingModule();
    const cancel = setup(false, null);
    cancel.api.reschedule.mockResolvedValueOnce(plan(true));
    expect(await cancel.flow.change([{ item: 'i2', startDate: '2026-11-04' }])).toBeNull();
    expect(cancel.api.reschedule).toHaveBeenCalledTimes(1);
  });

  it('previews in the browser and opens the dialog without asking the API (v1.4.1)', async () => {
    const { flow, api, dialog, ctx } = setup(false, { move: true, always: false });
    offerPlan(ctx);
    api.reschedule.mockResolvedValueOnce(plan(true));
    // KLO-2 now finishes on 5 Nov, so KLO-3 moves to the 6th.
    await flow.change([{ item: 'i2', dueDate: '2026-11-05' }]);
    expect(dialog.open).toHaveBeenCalledTimes(1);
    const shown = (dialog.open.mock.calls[0]?.[1] as { data: { plan: RescheduleResultDto } }).data;
    expect(shown.plan.changes.map((c) => [c.item.key, c.to.startDate])).toEqual([
      ['KLO-2', '2026-11-02'],
      ['KLO-3', '2026-11-06'],
    ]);
    expect(api.reschedule).toHaveBeenCalledTimes(1);
    expect(api.reschedule.mock.calls[0]?.[1]).toMatchObject({
      mode: 'apply',
      previewed: [{ id: 'i3', to: { startDate: '2026-11-06' } }],
      expect: { i2: '2026-01-01T00:00:00.000Z', i3: '2026-01-01T00:00:00.000Z' },
    });
  });

  it('shows the API plan with a note when the plan changed meanwhile (v1.4.1)', async () => {
    const { flow, api, dialog, ctx } = setup(false, { move: true, always: false });
    offerPlan(ctx);
    const refresh = vi.spyOn(ctx, 'refresh').mockResolvedValue();
    api.reschedule
      .mockRejectedValueOnce(new HttpErrorResponse({ status: 409 }))
      .mockResolvedValueOnce(plan(true))
      .mockResolvedValueOnce(plan(true));
    expect(await flow.change([{ item: 'i2', dueDate: '2026-11-05' }])).not.toBeNull();
    expect(refresh).toHaveBeenCalled();
    expect(api.reschedule.mock.calls.map((c) => (c[1] as { mode: string }).mode)).toEqual([
      'apply',
      'preview',
      'apply',
    ]);
    expect(dialog.open).toHaveBeenCalledTimes(2);
    expect(dialog.open.mock.calls[1]?.[1]).toMatchObject({ data: { note: PLAN_CHANGED_NOTE } });
  });

  it('asks the API when the page knows no links, or for an exact pin (v1.4.1)', async () => {
    const { flow, api, ctx } = setup(false, null);
    api.reschedule.mockResolvedValue(plan(true));
    await flow.change([{ item: 'i2', dueDate: '2026-11-05' }]);
    expect(api.reschedule.mock.calls[0]?.[1]).toMatchObject({ mode: 'preview' });
    offerPlan(ctx);
    await flow.change([{ item: 'i2', startDate: '2026-11-02', pinTo: null }]);
    expect(api.reschedule.mock.calls[1]?.[1]).toMatchObject({ mode: 'preview' });
  });

  it('shows only the date fields a change names (v1.4.1)', () => {
    expect(changePatch({ item: 'i2', dueDate: '2026-11-05', dueFirstHalf: true })).toEqual({
      dueDate: '2026-11-05',
      dueFirstHalf: true,
    });
    expect(changePatch({ item: 'i2', startDate: null, startSecondHalf: true })).toEqual({
      startDate: null,
      startSecondHalf: false,
    });
    expect(changePatch({ item: 'i2' })).toEqual({});
  });
});
