import type {
  ItemStatus,
  OverviewReportDto,
  PlanHealthReportDto,
  ReportItemDto,
  SprintReportDto,
  WorkloadReportDto,
} from '@kloister/shared';

/** Status names as the board shows them. */
const STATUS_NAMES: Record<ItemStatus, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  BLOCKED: 'Blocked',
  DONE: 'Done',
};

/** The reports a project workbook summarises; Sprint and Plan health are projects only. */
export interface SheetReports {
  /** Overview. */
  overview: OverviewReportDto;
  /** Workload. */
  workload: WorkloadReportDto;
  /** Sprint, or null for personal spaces. */
  sprint: SprintReportDto | null;
  /** Plan health, or null for personal spaces. */
  health: PlanHealthReportDto | null;
}

/**
 * The Reports sheet of a project Excel export (M13): the numbers of the
 * Overview, Sprint, Workload and Plan health dashboards, one per row. The
 * reports are computed from the reader's visible items only.
 *
 * @param reports The reports.
 * @param names Display names by user id.
 * @returns The sheet's headers and rows.
 */
export function reportsSheet(
  reports: SheetReports,
  names: ReadonlyMap<string, string>,
): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  const add = (report: string, measure: string, value: string | number) =>
    rows.push([report, measure, String(value)]);
  const keys = (items: readonly ReportItemDto[]) => items.map((i) => i.key).join(', ');

  const { overview } = reports;
  add('Overview', 'Computed for', overview.today);
  add('Overview', 'Visible items', overview.total);
  for (const [status, count] of Object.entries(overview.byStatus))
    add('Overview', STATUS_NAMES[status as ItemStatus], count);
  add('Overview', 'Overdue', overview.overdue);
  add('Overview', `Due this week (to ${overview.weekEnd})`, overview.dueThisWeek);
  add('Overview', 'Done in the last 14 days', overview.doneRecently);
  add('Overview', 'Open ad-hoc items', overview.adHocOpen);
  for (const bucket of overview.openByBucket)
    add('Overview', `Open in ${bucket.name}`, bucket.count);

  const { sprint } = reports;
  if (sprint?.sprint) {
    add(
      'Sprint',
      'Sprint',
      `${sprint.sprint.name} (${sprint.sprint.startDate} to ${sprint.sprint.endDate})`,
    );
    add('Sprint', 'Items done', sprint.items.done);
    add('Sprint', 'Items remaining', sprint.items.remaining);
    add('Sprint', 'Working days done', sprint.days.done);
    add('Sprint', 'Working days remaining', sprint.days.remaining);
    add(
      'Sprint',
      'Sprint days passed',
      `${sprint.sprintDays.elapsed} of ${sprint.sprintDays.total}`,
    );
    add('Sprint', 'Added after the start', keys(sprint.added.map((c) => c.item)));
    add('Sprint', 'Removed after the start', keys(sprint.removed.map((c) => c.item)));
    add('Sprint', 'At risk (due after the sprint)', keys(sprint.atRisk));
  }

  for (const row of reports.workload.rows) {
    const who = row.userId === null ? 'Unassigned' : (names.get(row.userId) ?? 'Former member');
    row.cells.forEach((cell, w) => {
      const week = reports.workload.weeks[w];
      if (week === undefined) return;
      const load = cell.load === null ? 'no working days' : `${Math.round(cell.load * 100)}%`;
      add(
        'Workload',
        `${who}, week of ${week.start}`,
        `${cell.planned} of ${week.available} days (${load})`,
      );
    });
  }

  const { health } = reports;
  if (health !== null) {
    add('Plan health', 'Past due', keys(health.pastDue));
    add(
      'Plan health',
      'Start before their predecessors finish',
      keys(health.conflicts.map((c) => c.item)),
    );
    add(
      'Plan health',
      'Stories and Tasks without dates in the active sprint',
      keys(health.undatedInSprint),
    );
    add('Plan health', 'Held later by their pin', keys(health.pinnedLate.map((p) => p.item)));
  }
  return { headers: ['Report', 'Measure', 'Value'], rows };
}
