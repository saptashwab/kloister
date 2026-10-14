import type { ComponentFixture } from '@angular/core/testing';
import type {
  BucketDto,
  ProjectDto,
  ProjectMemberDto,
  SprintDto,
  WorkItemDetailDto,
} from '@kloister/shared';

// Data builders for the web unit tests. Plain data only, so this file also
// type-checks with the application sources.

/**
 * Builds a project as the API returns it.
 *
 * @param overrides Fields to change.
 * @returns The project.
 */
export function makeProject(overrides: Partial<ProjectDto> = {}): ProjectDto {
  return {
    id: 'p1',
    key: 'KLO',
    ownerId: null,
    name: 'Kanban',
    description: '',
    archivedAt: null,
    settings: { membersCanAssignOthers: false, statusToBucket: {}, labelStyle: 'SOLID' },
    myRole: 'PM',
    myVisibility: 'ALL',
    myTeams: [],
    myPermissions: [
      'VIEW_ITEMS',
      'CREATE_ITEMS',
      'EDIT_ANY_ITEM',
      'EDIT_OWN_ITEMS',
      'ASSIGN_OTHERS',
      'MOVE_ANY_ITEM',
      'MOVE_OWN_ITEMS',
      'DELETE_ANY_ITEM',
      'DELETE_OWN_ITEMS',
      'MANAGE_BOARD',
      'MANAGE_MEMBERS',
      'MANAGE_PROJECT',
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Builds a work item with full capabilities.
 *
 * @param number Item number; the id is `i<number>`.
 * @param overrides Fields to change.
 * @returns The item, with an empty checklist and no dependencies.
 */
export function makeItem(
  number: number,
  overrides: Partial<WorkItemDetailDto> = {},
): WorkItemDetailDto {
  return {
    id: `i${number}`,
    number,
    key: `KLO-${number}`,
    type: 'TASK',
    parentId: null,
    ancestors: [],
    title: `Item ${number}`,
    description: '',
    status: 'NOT_STARTED',
    priority: 2,
    bucketId: 'b1',
    sprintId: null,
    teamId: null,
    startDate: null,
    dueDate: null,
    position: number,
    createdById: 'u1',
    assigneeIds: [],
    labelIds: [],
    checklist: { done: 0, total: 0 },
    childCount: 0,
    completedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    can: { edit: true, move: true, delete: true, deleteCascade: true, annotate: true },
    checklistItems: [],
    blockedBy: [],
    blocks: [],
    ...overrides,
  };
}

/**
 * Builds a bucket without an entry rule.
 *
 * @param id Bucket id.
 * @param name Bucket name.
 * @param position Column order.
 * @returns The bucket.
 */
export function makeBucket(id: string, name: string, position: number): BucketDto {
  return { id, name, position, onEnterMode: 'NONE', onEnterStatus: null };
}

/**
 * Builds a project member.
 *
 * @param userId User id.
 * @param displayName Display name.
 * @param overrides Fields to change.
 * @returns The member.
 */
export function makeMember(
  userId: string,
  displayName: string,
  overrides: Partial<ProjectMemberDto> = {},
): ProjectMemberDto {
  return {
    id: `m-${userId}`,
    userId,
    email: `${userId}@example.org`,
    displayName,
    isActive: true,
    role: 'MEMBER',
    visibility: 'ALL',
    allowedBucketIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Builds a sprint.
 *
 * @param id Sprint id.
 * @param name Sprint name.
 * @param state Lifecycle state.
 * @returns The sprint.
 */
export function makeSprint(id: string, name: string, state: SprintDto['state']): SprintDto {
  return {
    id,
    name,
    startDate: '2026-10-01',
    endDate: '2026-10-14',
    state,
    adoIterationPath: null,
  };
}

/**
 * Lets pending promise chains (mocked API calls) finish and the fixture
 * render; `whenStable()` alone does not wait for untracked promises.
 *
 * @param fixture The component fixture.
 * @returns Resolves once settled.
 */
export async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
  }
}
