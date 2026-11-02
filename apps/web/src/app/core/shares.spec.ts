import { makeItem } from '../../testing/fixtures';
import { planBulk } from './bulk';
import { revertFields } from './item-changes';
import {
  clampShare,
  nextShare,
  parseWho,
  shareLabel,
  sharesOf,
  stepShare,
  whoText,
  withShareFor,
} from './shares';

const people = [
  { userId: 'ann', displayName: 'Ann Lee', email: 'ann@example.org' },
  { userId: 'bo', displayName: 'Bo Chen', email: 'bo@example.org' },
  { userId: 'bob', displayName: 'Bob Diaz', email: 'bob@example.org' },
  { userId: 'raj', displayName: 'Raj Rao', email: 'raj@example.org' },
];

describe('assignee shares (M13)', () => {
  it('reads typed Who text with shares', () => {
    expect(parseWho('Ann, Raj, Bo Chen 25, bob 25%', people)).toEqual({
      assignees: [
        { userId: 'ann', share: 100 },
        { userId: 'raj', share: 100 },
        { userId: 'bo', share: 25 },
        { userId: 'bob', share: 25 },
      ],
      unknown: [],
    });
  });

  it('reports names that match nobody or several people', () => {
    // "Bo" starts both "Bo Chen" and "Bob Diaz".
    expect(parseWho('Bo 50, Zed', people).unknown).toEqual(['Bo 50', 'Zed']);
    expect(parseWho('bo@example.org 50', people).assignees).toEqual([{ userId: 'bo', share: 50 }]);
  });

  it('rounds typed shares to steps of 5 between 5 and 100', () => {
    expect(clampShare(33)).toBe(35);
    expect(clampShare(1)).toBe(5);
    expect(clampShare(250)).toBe(100);
    expect(parseWho('Ann 0', people).assignees).toEqual([{ userId: 'ann', share: 5 }]);
  });

  it('cycles badges 25 → 50 → 100 and steps with the arrows', () => {
    expect([nextShare(25), nextShare(50), nextShare(100), nextShare(35)]).toEqual([
      50, 100, 25, 50,
    ]);
    expect([stepShare(100, -1), stepShare(50, -1), stepShare(25, -1)]).toEqual([75, 25, 25]);
    expect([stepShare(25, 1), stepShare(60, 1), stepShare(100, 1)]).toEqual([50, 75, 100]);
  });

  it('writes the Who text and labels', () => {
    const name = (id: string) => people.find((p) => p.userId === id)!.displayName;
    expect(
      whoText(
        [
          { userId: 'ann', share: 100 },
          { userId: 'bo', share: 25 },
        ],
        name,
      ),
    ).toBe('Ann Lee, Bo Chen 25');
    expect(shareLabel('Bo', 25)).toBe('Bo 25%');
    expect(shareLabel('Bo', 100)).toBe('Bo');
  });

  it('changes one share or adds the person', () => {
    const list = [{ userId: 'ann', share: 100 }];
    expect(withShareFor(list, 'ann', 50)).toEqual([{ userId: 'ann', share: 50 }]);
    expect(withShareFor(list, 'bo', 25)).toEqual([...list, { userId: 'bo', share: 25 }]);
    expect(sharesOf({ assigneeIds: ['x'] })).toEqual([{ userId: 'x', share: 100 }]);
  });

  it('undoes a share change with the shares it had', () => {
    const before = makeItem(1, { assigneeIds: ['ann'] });
    const after = makeItem(1, {
      assigneeIds: ['ann'],
      assigneeShares: [{ userId: 'ann', share: 25 }],
    });
    expect(revertFields(before, after)).toEqual({ assignees: [{ userId: 'ann', share: 100 }] });
  });

  it('plans the selection’s Share… under the plan and assignment rules', () => {
    const rights = { userId: 'ann', canAssignOthers: () => false };
    const mine = makeItem(1, { assigneeIds: ['ann'] });
    const locked = makeItem(2, {
      assigneeIds: ['ann'],
      can: {
        edit: true,
        plan: false,
        move: true,
        delete: true,
        deleteCascade: true,
        annotate: true,
      },
    });
    const other = makeItem(3);
    const plan = planBulk([mine, locked, other], 'share', 'ann:50', rights);
    expect(plan.steps.map((s) => s.request)).toEqual([
      { assignees: [{ userId: 'ann', share: 50 }] },
      { assignees: [{ userId: 'ann', share: 50 }] },
    ]);
    expect(plan.skipped.map((i) => i.id)).toEqual(['i2']);
    // Adding someone else needs the assignment right.
    expect(planBulk([other], 'share', 'bo:100', rights).skipped).toHaveLength(1);
  });
});
