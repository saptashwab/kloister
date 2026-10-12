import {
  isScopedRole,
  permissionsFor,
  type ProjectDto,
  type ProjectMemberDto,
  type ProjectRole,
  Visibility,
} from '@kloister/shared';
import type { Project, ProjectMember, User } from '../generated/prisma/client.js';
import type { ProjectAccess } from './project-access.service.js';
import { parseProjectSettings } from './project-settings.js';

/**
 * Converts a project to its API shape for a caller with the given access.
 *
 * @param access The caller's resolved access.
 * @param project The project row, if fresher than the one in `access`.
 * @returns The DTO.
 */
export function toProjectDto(access: ProjectAccess, project: Project = access.project): ProjectDto {
  return projectDto(project, access.role, access.visibility);
}

/**
 * Converts a project row to its API shape from a membership (or none), as
 * the project list does without resolving full access per project.
 *
 * @param project The project row.
 * @param membership The caller's membership, or null for an admin listing
 *   projects they are not a member of.
 * @returns The DTO.
 */
export function toProjectListDto(
  project: Project,
  membership: Pick<ProjectMember, 'role' | 'visibility'> | null,
): ProjectDto {
  const role = membership?.role ?? null;
  const visibility =
    membership !== null && isScopedRole(role) ? membership.visibility : Visibility.ALL;
  return projectDto(project, role, visibility);
}

/**
 * Builds the project DTO.
 *
 * @param project The project row.
 * @param role The caller's role, or null.
 * @param visibility The caller's effective visibility.
 * @returns The DTO.
 */
function projectDto(
  project: Project,
  role: ProjectRole | null,
  visibility: Visibility,
): ProjectDto {
  const settings = parseProjectSettings(project.settings);
  return {
    id: project.id,
    key: project.key,
    name: project.name,
    description: project.description,
    archivedAt: project.archivedAt?.toISOString() ?? null,
    settings,
    myRole: role,
    myVisibility: visibility,
    myPermissions: permissionsFor(role, settings),
    createdAt: project.createdAt.toISOString(),
  };
}

/** The user fields a member DTO needs; select only these when loading members. */
export const MEMBER_USER_SELECT = { email: true, displayName: true, isActive: true } as const;

/**
 * Converts a membership with its user to the API shape.
 *
 * @param member The membership row including the selected user fields.
 * @returns The DTO.
 */
export function toMemberDto(
  member: ProjectMember & { user: Pick<User, keyof typeof MEMBER_USER_SELECT> },
): ProjectMemberDto {
  return {
    id: member.id,
    userId: member.userId,
    email: member.user.email,
    displayName: member.user.displayName,
    isActive: member.user.isActive,
    role: member.role,
    visibility: member.visibility,
    allowedBucketIds: member.allowedBucketIds,
    createdAt: member.createdAt.toISOString(),
  };
}
