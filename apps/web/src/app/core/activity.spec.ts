import type { AuditEntryDto } from '@kloister/shared';
import { type ActivityNames, describeActivity } from './activity';

const names: ActivityNames = {
  bucket: (id) => ({ b1: 'To Do', b2: 'Done' })[id] ?? null,
  sprint: (id) => (id === 's1' ? 'Sprint 1' : null),
  member: (id) => (id === 'u1' ? 'Ann' : null),
  label: (id) => (id === 'l1' ? 'urgent' : null),
  team: () => null,
  item: (id) => (id === 'i9' ? 'KLO-9' : null),
};

/**
 * Builds an item audit entry.
 *
 * @param action Audit action.
 * @param meta Entry detail.
 * @returns The entry.
 */
function entry(action: string, meta: Record<string, unknown>): AuditEntryDto {
  return {
    id: 'a1',
    actorId: 'u1',
    actorEmail: 'ann@example.org',
    action,
    entityType: 'WorkItem',
    entityId: 'i1',
    projectId: 'p1',
    meta,
    createdAt: '2026-10-13T08:00:00.000Z',
  };
}

describe('describeActivity', () => {
  it('describes creation, moves and field changes with names', () => {
    expect(describeActivity(entry('ITEM_CREATED', { type: 'BUG' }), names)).toEqual([
      'created this Bug',
    ]);
    expect(
      describeActivity(
        entry('ITEM_MOVED', { from: 'b1', to: 'b2', status: { from: 'IN_PROGRESS', to: 'DONE' } }),
        names,
      ),
    ).toEqual(['moved the card from To Do to Done', 'changed the status from In progress to Done']);
    expect(
      describeActivity(
        entry('ITEM_UPDATED', {
          changes: {
            sprintId: { from: null, to: 's1' },
            assigneeIds: { from: [], to: ['u1'] },
            labelIds: { from: ['l1'], to: [] },
            description: { from: null, to: null },
            priority: { from: 2, to: 1 },
          },
        }),
        names,
      ),
    ).toEqual([
      'changed the sprint from none to Sprint 1',
      'changed the assignees from none to Ann',
      'changed the labels from urgent to none',
      'changed the description',
      'changed the priority from 2 – High to 1 – Highest',
    ]);
  });

  it('shows references the API redacted as "another item"', () => {
    expect(
      describeActivity(
        entry('DEPENDENCY_ADDED', { blockingItemId: null, blockingNumber: null, redacted: true }),
        names,
      ),
    ).toEqual(['marked this as blocked by another item']);
    expect(describeActivity(entry('DEPENDENCY_REMOVED', { blockingItemId: 'i9' }), names)).toEqual([
      'removed the block by KLO-9',
    ]);
    expect(
      describeActivity(
        entry('ITEM_UPDATED', { changes: { parentId: { from: null, to: null } }, redacted: true }),
        names,
      ),
    ).toEqual(['changed the parent']);
  });

  it('describes checklist changes', () => {
    expect(describeActivity(entry('CHECKLIST_ITEM_ADDED', { text: 'Write tests' }), names)).toEqual(
      ['added checklist line “Write tests”'],
    );
    expect(
      describeActivity(
        entry('CHECKLIST_ITEM_UPDATED', { changes: { done: { from: false, to: true } } }),
        names,
      ),
    ).toEqual(['ticked a checklist line']);
  });
});
