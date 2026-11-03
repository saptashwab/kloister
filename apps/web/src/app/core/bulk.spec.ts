import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom, throwError } from 'rxjs';
import { makeItem } from '../../testing/fixtures';
import { NONE } from './board-logic';
import { assertUndone, planBulk, runBulk, undoBulk } from './bulk';

describe('bulk edits', () => {
  const rights = (assignOthers: boolean) => ({
    userId: 'me',
    canAssignOthers: (teamId: string | null) => assignOthers || teamId === 'led',
  });
  const readOnly = {
    edit: false,
    plan: false,
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

  it('skips Epics and Features when setting a sprint (M12)', () => {
    const items = [makeItem(1, { type: 'EPIC' }), makeItem(2, { type: 'FEATURE' }), makeItem(3)];
    const plan = planBulk(items, 'sprint', 's1', rights(true));
    expect(plan.steps.map((s) => s.item.number)).toEqual([3]);
    expect(plan.skipped.map((i) => i.number)).toEqual([1, 2]);
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

  it('changes types and says why rows were left out (v1.3.1)', () => {
    const storyParent = { id: 's', number: 9, key: 'KLO-9', type: 'STORY' as const, title: 'S' };
    const free = makeItem(1, { type: 'FEATURE', parentId: null, ancestors: [] });
    const underStory = makeItem(2, { type: 'TASK', parentId: 's', ancestors: [storyParent] });
    const withStories = makeItem(3, { type: 'FEATURE', parentId: null, ancestors: [] });
    const locked = makeItem(4, { type: 'FEATURE', can: readOnly });
    const plan = planBulk([free, underStory, withStories, locked], 'type', 'STORY', {
      ...rights(true),
      childTypes: (id) => (id === withStories.id ? ['STORY'] : []),
    });
    expect(plan.steps).toEqual([{ item: free, kind: 'update', request: { type: 'STORY' } }]);
    expect(plan.reasons.get(underStory.id)).toBe(
      'it sits under a User Story, which cannot hold a User Story',
    );
    expect(plan.reasons.get(withStories.id)).toBe('a User Story cannot hold its User Story items');
    expect(plan.skipped.map((i) => i.number)).toEqual([2, 3, 4]);
    expect(plan.reasons.has(locked.id)).toBe(false);
  });

  it('moves rows under a parent and fixes their type like an indent (v1.3.1)', () => {
    const feature = makeItem(10, { type: 'FEATURE', parentId: null, ancestors: [] });
    const strayFeature = makeItem(11, { type: 'FEATURE', parentId: null, ancestors: [] });
    const task = makeItem(12, { type: 'TASK', parentId: null, ancestors: [] });
    const featureRef = {
      id: feature.id,
      number: 10,
      key: feature.key,
      type: 'FEATURE' as const,
      title: 'F',
    };
    const child = makeItem(13, { type: 'STORY', parentId: feature.id, ancestors: [featureRef] });
    const adHoc = makeItem(14, { type: 'TASK', adHoc: true, parentId: null, ancestors: [] });
    const byId = new Map([feature, child].map((i) => [i.id, i]));
    const plan = planBulk([strayFeature, task, feature, adHoc], 'parent', child.id, {
      ...rights(true),
      itemById: (id) => byId.get(id),
    });
    // The stray Feature becomes a Task under the Story; the Task keeps its type.
    expect(plan.steps.map((s) => s.request)).toEqual([
      { parentId: child.id, type: 'TASK' },
      { parentId: child.id },
    ]);
    expect(plan.reasons.get(feature.id)).toBe('an item cannot sit under itself or its own child');
    expect(plan.reasons.get(adHoc.id)).toBe('an ad-hoc item has no parent');
    const top = planBulk([child], 'parent', NONE, rights(true));
    expect(top.steps[0]?.request).toEqual({ parentId: null });
    // A Bug moved under an Epic becomes a Feature; an unknown parent is reported.
    const epic = makeItem(20, { type: 'EPIC', parentId: null, ancestors: [] });
    const bug = makeItem(21, { type: 'BUG', parentId: null, ancestors: [] });
    const underEpic = planBulk([bug], 'parent', epic.id, {
      ...rights(true),
      itemById: (id) => (id === epic.id ? epic : undefined),
    });
    expect(underEpic.steps[0]?.request).toEqual({ parentId: epic.id, type: 'FEATURE' });
    const gone = planBulk([bug], 'parent', 'missing', {
      ...rights(true),
      itemById: () => undefined,
    });
    expect(gone.reasons.get(bug.id)).toBe('the new parent is not visible');
  });

  it('lets an item off the board become a Story; the API picks its bucket (v1.3.1)', () => {
    const loose = makeItem(30, { type: 'FEATURE', bucketId: null, parentId: null, ancestors: [] });
    expect(planBulk([loose], 'type', 'STORY', rights(true)).steps[0]?.request).toEqual({
      type: 'STORY',
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

  describe('undo (v1.4.0)', () => {
    it('puts back exactly the fields the edit changed, per item', async () => {
      const before = [
        makeItem(1, { sprintId: 'old', priority: 3 }),
        makeItem(2, { sprintId: null, priority: 1 }),
      ];
      const after = before.map((i) => ({ ...i, sprintId: 's1' }));
      const calls: unknown[] = [];
      const result = await undoBulk(new Map(before.map((i) => [i.id, i])), after, {
        move: () => Promise.reject(new Error('no move expected')),
        update: (item, request) => {
          calls.push([item.number, request]);
          return Promise.resolve({ ...item, ...request } as typeof item);
        },
      });
      expect(calls).toEqual([
        [1, { sprintId: 'old' }],
        [2, { sprintId: null }],
      ]);
      expect(result.updated.map((i) => i.sprintId)).toEqual(['old', null]);
      expect(() => assertUndone(result)).not.toThrow();
    });

    it('moves a card back to its bucket first, then restores a status an entry rule changed', async () => {
      const was = makeItem(1, { bucketId: 'b1', status: 'NOT_STARTED' });
      const after = { ...was, bucketId: 'b2', status: 'IN_PROGRESS' as const };
      const calls: string[] = [];
      await undoBulk(new Map([[was.id, was]]), [after], {
        move: (item, request) => {
          calls.push(`move ${request.bucketId}`);
          // The old bucket's rule leaves the status as it is.
          return Promise.resolve({ ...item, bucketId: request.bucketId ?? null });
        },
        update: (item, request) => {
          calls.push(`status ${request.status}`);
          return Promise.resolve({ ...item, ...request } as typeof item);
        },
      });
      expect(calls).toEqual(['move b1', 'status NOT_STARTED']);
    });

    it('puts a type back before taking an item off the board again', async () => {
      const was = makeItem(1, { type: 'FEATURE', bucketId: null });
      const after = { ...was, type: 'TASK' as const, bucketId: 'b1' };
      const calls: string[] = [];
      await undoBulk(new Map([[was.id, was]]), [after], {
        move: (item, request) => {
          calls.push(`move ${request.bucketId}`);
          return Promise.resolve({ ...item, bucketId: request.bucketId ?? null });
        },
        update: (item, request) => {
          calls.push(`type ${request.type}`);
          return Promise.resolve({ ...item, ...request } as typeof item);
        },
      });
      expect(calls).toEqual(['type FEATURE', 'move null']);
    });

    it('reports items the API refused to put back', async () => {
      const was = makeItem(1, { priority: 3 });
      const result = await undoBulk(new Map([[was.id, was]]), [{ ...was, priority: 1 }], {
        move: () => Promise.reject(new Error('unused')),
        update: () =>
          firstValueFrom(
            throwError(
              () =>
                new HttpErrorResponse({
                  status: 403,
                  error: { code: 'FORBIDDEN', message: 'Not your item' },
                }),
            ),
          ),
      });
      expect(result.failed.map((f) => f.message)).toEqual(['Not your item']);
      expect(() => assertUndone(result)).toThrow(/KLO-1 \(Not your item\)/);
    });
  });
});
