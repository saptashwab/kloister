import type {
  BucketRule,
  ItemStatus,
  ItemType,
  ProjectRole,
  SprintState,
  TeamRole,
  Visibility,
} from '@kloister/shared';

/** Display names of project roles (SPEC §3.2). */
export const ROLE_LABELS: Record<ProjectRole, string> = {
  PM: 'Project Manager',
  LEAD: 'Lead',
  MEMBER: 'Member',
  VIEWER: 'Viewer',
};

/** Display names of visibility scopes (SPEC §3.3). */
export const VISIBILITY_LABELS: Record<Visibility, string> = {
  ALL: 'All items',
  BUCKETS: 'Selected buckets',
  OWN: 'Own items',
  TEAMS: "Their teams' items",
};

/** Display names of team roles (SPEC §3.5). */
export const TEAM_ROLE_LABELS: Record<TeamRole, string> = {
  LEAD: 'Team lead',
  MEMBER: 'Team member',
};

/** Display names of work item types (SPEC §4). */
export const TYPE_LABELS: Record<ItemType, string> = {
  EPIC: 'Epic',
  FEATURE: 'Feature',
  STORY: 'User Story',
  TASK: 'Task',
  BUG: 'Bug',
};

/**
 * Short type badges shown on cards and tree rows. Plain letters, because the
 * UI loads no icon fonts (the server may have no internet access).
 */
export const TYPE_BADGES: Record<ItemType, string> = {
  EPIC: 'E',
  FEATURE: 'F',
  STORY: 'S',
  TASK: 'T',
  BUG: 'B',
};

/** Display names of item statuses (SPEC §4.2). */
export const STATUS_LABELS: Record<ItemStatus, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  BLOCKED: 'Blocked',
  DONE: 'Done',
};

/** Display names of bucket entry rules (SPEC §4.2). */
export const BUCKET_RULE_LABELS: Record<BucketRule, string> = {
  NONE: 'No change',
  SET: 'Set status',
  SET_IF_NOT_STARTED: 'Set status if not started',
};

/** Display names of sprint states. */
export const SPRINT_STATE_LABELS: Record<SprintState, string> = {
  PLANNED: 'Planned',
  ACTIVE: 'Active',
  CLOSED: 'Closed',
};

/** Display names of priorities, 1 (highest) to 4. */
export const PRIORITY_LABELS: Record<number, string> = {
  1: '1 – Highest',
  2: '2 – High',
  3: '3 – Medium',
  4: '4 – Low',
};
