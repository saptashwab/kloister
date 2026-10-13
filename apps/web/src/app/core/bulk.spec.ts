import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom, throwError } from 'rxjs';
import { makeItem } from '../../testing/fixtures';
import { NONE } from './board-logic';
import { planBulk, runBulk } from './bulk';

describe('bulk edits', () => {
  const rights = (assignOthers: boolean) => ({
    userId: 'me',
    canAssignOthers: (teamId: string | null) => assignOthers || teamId === 'led',
  });
  const readOnly = {
    edit: false,
    move: false,
    delete: false,
    deleteCascade: false,
    annotate: false,
  };

  it('sets the sprint on editable items and skips the rest', () => {
    const items = [makeItem(1), makeItem(2, { sprintId: 's1' }), makeItem(3, { can: readOnly })];
    const plan = planBulk(items, 'sprint', 's1', rights(true));
    expect(plan.steps).toEqual([{ item: items[0], kind: 'update', request: { sprintId: 's1' } }]);
    expect(plan.unchanged.map((i) => i.number)).toEqual([2]);
    expect(plan.skipped.map((i) => i.number)).toEqual([3]);
    expect(planBulk([items[1]], 'sprint', NONE, rights(true)).steps[0]?.request).toEqual({
      sprintId: null,
    });
  });

  it('moves cards with the move endpoint and needs can.move', () => {
    const movable = makeItem(1, { can: { ...readOnly, move: true } });
    const fixed = makeItem(2, { can: { ...readOnly, edit: true } });
    const plan = planBulk([movable, fixed], 'bucket', 'b2', rights(true));
    expect(plan.steps).toEqual([{ item: movable, kind: 'move', request: { bucketId: 'b2' } }]);
    expect(plan.skipped).toEqual([fixed]);
  });

  it('only lets callers without ASSIGN_OTHERS assign or unassign themselves', () => {
    const mine = makeItem(1);
    const someoneElses = makeItem(2, { assigneeIds: ['other'] });
    const teamItem = makeItem(3, { assigneeIds: ['other'], teamId: 'led' });
    const self = planBulk([mine, someoneElses, teamItem], 'assignee', 'me', rights(false));
    expect(self.steps.map((s) => [s.item.number, s.request])).toEqual([
      [1, { assigneeIds: ['me'] }],
      // A team Lead may replace others on the team's items.
      [3, { assigneeIds: ['me'] }],
    ]);
    expect(self.skipped.map((i) => i.number)).toEqual([2]);

    const others = planBulk([mine], 'assignee', 'other', rights(true));
    expect(others.steps[0]?.request).toEqual({ assigneeIds: ['other'] });
    expect(planBulk([someoneElses], 'assignee', NONE, rights(true)).steps[0]?.request).toEqual({
      assigneeIds: [],
    });
  });

  it('keeps going after a refusal and reports the API message', async () => {
    const items = [makeItem(1), makeItem(2), makeItem(3)];
    const plan = planBulk(items, 'sprint', 's1', rights(true));
    const refusal = new HttpErrorResponse({
      status: 403,
      error: { code: 'FORBIDDEN', message: 'Not your item' },
    });
    const result = await runBulk(plan.steps, (step) =>
      step.item.number === 2
        ? firstValueFrom(throwError(() => refusal))
        : Promise.resolve({ ...step.item, sprintId: 's1' }),
    );
    expect(result.updated.map((i) => [i.number, i.sprintId])).toEqual([
      [1, 's1'],
      [3, 's1'],
    ]);
    expect(result.failed).toEqual([{ item: items[1], message: 'Not your item' }]);
  });
});
