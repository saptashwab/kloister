import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  MyCalendarDto,
  OverviewReportDto,
  PlanHealthReportDto,
  SprintReportDto,
  WorkloadReportDto,
} from '@kloister/shared';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from './api';

/**
 * The reports and the My work calendar of the API (M13). Kept apart from
 * {@link ItemsApiService} so only the pages that use them download them.
 */
@Injectable({ providedIn: 'root' })
export class ReportsApiService {
  private readonly http = inject(HttpClient);

  /**
   * Counts the project's visible items (Overview).
   *
   * @param projectId Project id.
   * @returns The overview.
   */
  overview(projectId: string): Promise<OverviewReportDto> {
    return firstValueFrom(
      this.http.get<OverviewReportDto>(apiUrl(`projects/${projectId}/reports/overview`)),
    );
  }

  /**
   * Reports on the active or a chosen sprint.
   *
   * @param projectId Project id.
   * @param sprintId Sprint id, or null for the active sprint.
   * @returns The sprint report.
   */
  sprint(projectId: string, sprintId: string | null): Promise<SprintReportDto> {
    const params = sprintId === null ? undefined : new HttpParams().set('sprint', sprintId);
    return firstValueFrom(
      this.http.get<SprintReportDto>(apiUrl(`projects/${projectId}/reports/sprint`), { params }),
    );
  }

  /**
   * Spreads planned work over people and weeks.
   *
   * @param projectId Project id.
   * @param from A day in the first week.
   * @param weeks Number of weeks.
   * @returns The workload.
   */
  workload(projectId: string, from: string, weeks: number): Promise<WorkloadReportDto> {
    const params = new HttpParams().set('from', from).set('weeks', weeks);
    return firstValueFrom(
      this.http.get<WorkloadReportDto>(apiUrl(`projects/${projectId}/reports/workload`), {
        params,
      }),
    );
  }

  /**
   * Lists what needs attention in the plan.
   *
   * @param projectId Project id.
   * @returns The plan health lists.
   */
  planHealth(projectId: string): Promise<PlanHealthReportDto> {
    return firstValueFrom(
      this.http.get<PlanHealthReportDto>(apiUrl(`projects/${projectId}/reports/plan-health`)),
    );
  }

  /**
   * The caller's items and holidays in a date range (My work calendar).
   *
   * @param from First day.
   * @param to Last day.
   * @returns The calendar.
   */
  myCalendar(from: string, to: string): Promise<MyCalendarDto> {
    const params = new HttpParams().set('from', from).set('to', to);
    return firstValueFrom(this.http.get<MyCalendarDto>(apiUrl('me/calendar'), { params }));
  }
}
