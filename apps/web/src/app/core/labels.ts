import type { ProjectRole, Visibility } from '@kloister/shared';

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
};
