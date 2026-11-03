/**
 * Worked request and response examples for the main routes of the generated
 * API reference, keyed by operation id. A deployment test validates each one
 * against the generated schemas, so an example that no longer matches the
 * code fails the build. Example data only.
 */

/** One operation's examples. */
export interface OperationExample {
  /** JSON request body. */
  request?: unknown;
  /** JSON success response body. */
  response?: unknown;
}

const PERSON = '6f1d2c4e-8a0b-4c3d-9e5f-0a1b2c3d4e5f';
const EPIC = '3b9a7c1d-2e4f-4a6b-8c0d-1e2f3a4b5c6d';
const ITEM = '0c8e4f2a-6b1d-4e3f-a5c7-9d0b1e2f3a4b';
const BUCKET = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const SPRINT = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';

/** A Task as list and detail routes return it. */
const TASK = {
  id: ITEM,
  number: 42,
  key: 'KLO-42',
  type: 'TASK',
  parentId: EPIC,
  ancestors: [{ id: EPIC, number: 7, key: 'KLO-7', type: 'EPIC', title: 'Spring release' }],
  title: 'Write the upgrade notes',
  description: '<p>Cover the new timeline settings.</p>',
  status: 'NOT_STARTED',
  priority: 2,
  bucketId: BUCKET,
  sprintId: SPRINT,
  teamId: null,
  startDate: '2026-11-09',
  startSecondHalf: false,
  dueDate: '2026-11-11',
  dueFirstHalf: false,
  dueTime: null,
  startNoEarlierThan: null,
  position: 1024,
  outlinePosition: null,
  createdById: PERSON,
  assigneeIds: [PERSON],
  assigneeShares: [{ userId: PERSON, share: 100 }],
  labelIds: [],
  checklist: { done: 0, total: 0 },
  childCount: 0,
  adHoc: false,
  completedAt: null,
  createdAt: '2026-11-02T09:15:00.000Z',
  updatedAt: '2026-11-02T09:15:00.000Z',
  can: { edit: true, plan: true, move: true, delete: true, deleteCascade: true, annotate: true },
};

/** Examples by operation id. */
export const OPERATION_EXAMPLES: Record<string, OperationExample> = {
  ItemsController_list: { response: { items: [TASK], nextCursor: null } },
  ItemsController_create: {
    request: {
      type: 'TASK',
      title: 'Write the upgrade notes',
      description: '<p>Cover the new timeline settings.</p>',
      parentId: EPIC,
      priority: 2,
      sprintId: SPRINT,
      startDate: '2026-11-09',
      dueDate: '2026-11-11',
      assigneeIds: [PERSON],
    },
    response: { ...TASK, checklistItems: [], blockedBy: [], blocks: [] },
  },
  ItemsController_update: {
    request: {
      status: 'IN_PROGRESS',
      dueDate: '2026-11-12',
      dueTime: '15:00',
      assignees: [{ userId: PERSON, share: 50 }],
    },
  },
  TimelineController_reschedule: {
    request: {
      mode: 'preview',
      changes: [{ item: '42', startDate: '2026-11-10', dueDate: '2026-11-12' }],
      expect: { [ITEM]: '2026-11-02T09:15:00.000Z' },
    },
    response: {
      changes: [
        {
          item: {
            id: ITEM,
            number: 42,
            key: 'KLO-42',
            type: 'TASK',
            title: 'Write the upgrade notes',
          },
          from: {
            startDate: '2026-11-09',
            startSecondHalf: false,
            dueDate: '2026-11-11',
            dueFirstHalf: false,
          },
          to: {
            startDate: '2026-11-10',
            startSecondHalf: false,
            dueDate: '2026-11-12',
            dueFirstHalf: false,
          },
          pinFrom: null,
          pinTo: null,
          requested: true,
          snapped: false,
          version: '2026-11-02T09:15:00.000Z',
        },
      ],
      kept: [],
      items: [],
      rescheduleId: null,
    },
  },
  NotesController_create: {
    request: {
      body: `<p>Ready for review, <span data-mention="${PERSON}">@Alex Example</span>.</p>`,
    },
    response: {
      id: '7e6d5c4b-3a2f-4e1d-9c8b-7a6f5e4d3c2b',
      authorId: PERSON,
      authorName: 'Alex Example',
      body: `<p>Ready for review, <span data-mention="${PERSON}">@Alex Example</span>.</p>`,
      editedAt: null,
      createdAt: '2026-11-02T10:00:00.000Z',
      can: { edit: true, delete: true },
    },
  },
  SprintsController_create: {
    request: { name: 'Sprint 12', startDate: '2026-11-09', endDate: '2026-11-20' },
    response: {
      id: SPRINT,
      name: 'Sprint 12',
      startDate: '2026-11-09',
      endDate: '2026-11-20',
      state: 'PLANNED',
      adoIterationPath: null,
    },
  },
};
