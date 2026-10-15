import { ProjectPermission as P, type ProjectDto } from '@kloister/shared';

/** A brief guided page visit; never an edit or demo-data operation. */
export interface TourStep {
  /** Short step name. */
  title: string;
  /** Brief, capability-specific explanation. */
  text: string;
  /** Existing permitted route, absent for an explanatory-only step. */
  route?: string[];
}

/**
 * Composes current project/team capabilities separately from system administration.
 * @param project Current readable project, or no memberships.
 * @param admin Independent system administration rights.
 * @returns A short common path with only relevant capability additions.
 */
export function tourSteps(project: ProjectDto | null, admin: boolean): TourStep[] {
  const steps: TourStep[] = [
    {
      title: 'Your work, together',
      text: 'This short introduction takes about 2–3 minutes, at your own pace. My work gathers your assigned project tasks and private personal tasks. Source, Done and created-item switches decide what appears.',
      route: ['/work'],
    },
    {
      title: 'Personal and navigation',
      text: 'Personal is your private space, visible only to you—even system administrators cannot open it. Open it from the sidebar when you need it. The tour does not create a space or sample work. Search or jump and keyboard help are also in the sidebar.',
    },
  ];
  if (project !== null) {
    const path = ['/p', project.key ?? 'personal'];
    const permissions = new Set(project.myPermissions);
    const writable = project.archivedAt === null;
    const leadTeams = project.myTeams
      .filter((team) => team.role === 'LEAD')
      .map((team) => team.teamId);
    steps.push({
      title: `${project.name}: board and details`,
      text: 'This project has its own buckets, labels and sprints. Filters narrow what you see. Open an item title for its description, checklist, notes, files and readable history. Title-only ancestors give context without granting access.',
      route: path,
    });
    steps.push({
      title: `${project.name}: your capabilities`,
      text: !writable
        ? 'This project is archived: you can read and export it. Changes and duplication are unavailable.'
        : permissions.has(P.CREATE_ITEMS)
          ? 'You can create items and duplicate fully readable items here. Dates, sprint and attachments are explicit copy options. Several assignees share progress; separate copies give each person independent progress. Editing and assigning still depend on each item and your scope.'
          : 'Your project access is read-only. You can inspect readable details and export them. Creation, assignment and duplication require additional project permissions.',
    });
    if (writable && (permissions.has(P.MANAGE_BOARD) || leadTeams.length > 0))
      steps.push({
        title: `${project.name}: planning and team scope`,
        text: permissions.has(P.MANAGE_BOARD)
          ? 'Your project role allows planning with buckets, labels and sprints. Assignment follows your project permissions. Use backlog hierarchy for larger plans.'
          : `Your Lead rights apply only to the teams you lead (${leadTeams.length}). They allow editing, moving, assigning and deleting those teams’ items. They do not grant project or membership management.`,
        route: permissions.has(P.MANAGE_BOARD) ? [...path, 'sprints'] : path,
      });
    if (writable && permissions.has(P.MANAGE_MEMBERS))
      steps.push({
        title: `${project.name}: project management`,
        text: 'In this project you can manage members, visibility and teams. Members may hold different roles in different projects. A team Lead manages its items, not the project’s membership.',
        route: [...path, 'settings'],
      });
  } else
    steps.push({
      title: 'Projects when you have them',
      text: 'You have no selected project. My work and Help remain available. When you join a project, its board and your permitted actions appear in navigation. Replay this introduction to learn your current capabilities.',
    });
  steps.push({
    title: 'Notifications, export and help',
    text: 'Notifications collect assignments, mentions, due reminders and status updates you may read. Export offers the current filtered view or every eligible item, with optional offline files. These snapshots are for reading; recovery still needs backups. Help & FAQ contains detailed procedures and keyboard guidance.',
    route: ['/notifications'],
  });
  if (admin)
    steps.push({
      title: 'Your system administrator tools',
      text: 'You can manage users, create projects, assign project managers, and manage branding, storage, security, backups and logs. System administration does not grant PM or Lead write rights in a project or access to anyone else’s personal space.',
      route: ['/admin/users'],
    });
  steps.push({
    title: 'Ready when you are',
    text: 'You can replay from Help & FAQ at any time. Replay uses your current project/team permissions. No work or settings were changed.',
    route: ['/help'],
  });
  return steps;
}
