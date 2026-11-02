import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { CreateHolidayRequest, HolidayDto, ProjectHolidaysDto } from '@kloister/shared';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from './api';

/**
 * Holidays (SPEC §6.4, M9.1): a project's calendar for the timeline, and the
 * instance-wide list for admins. The API checks every permission.
 */
@Injectable({ providedIn: 'root' })
export class HolidaysApiService {
  private readonly http = inject(HttpClient);

  /**
   * The project's holidays and the instance changes since the last review.
   *
   * @param projectId Project id.
   * @returns The holidays.
   */
  forProject(projectId: string): Promise<ProjectHolidaysDto> {
    return firstValueFrom(
      this.http.get<ProjectHolidaysDto>(apiUrl(`projects/${projectId}/holidays`)),
    );
  }

  /**
   * Adds a project holiday (PMs and Leads).
   *
   * @param projectId Project id.
   * @param request The holiday.
   * @returns The holiday.
   */
  addToProject(projectId: string, request: CreateHolidayRequest): Promise<HolidayDto> {
    return firstValueFrom(
      this.http.post<HolidayDto>(apiUrl(`projects/${projectId}/holidays`), request),
    );
  }

  /**
   * Removes a project holiday (PMs and Leads).
   *
   * @param projectId Project id.
   * @param id Holiday id.
   * @returns Resolves once removed.
   */
  removeFromProject(projectId: string, id: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(apiUrl(`projects/${projectId}/holidays/${id}`)));
  }

  /**
   * Records that the instance holiday changes were reviewed (PMs and Leads).
   *
   * @param projectId Project id.
   * @param through The newest change shown; later ones stay unreviewed.
   * @returns Resolves once recorded.
   */
  markReviewed(projectId: string, through?: string): Promise<void> {
    return firstValueFrom(
      this.http.post<void>(
        apiUrl(`projects/${projectId}/holidays/reviewed`),
        through === undefined ? {} : { through },
      ),
    );
  }

  /**
   * Lists the instance holidays (admins).
   *
   * @returns Holidays, earliest first.
   */
  listInstance(): Promise<HolidayDto[]> {
    return firstValueFrom(this.http.get<HolidayDto[]>(apiUrl('admin/holidays')));
  }

  /**
   * Adds an instance holiday (admins).
   *
   * @param request The holiday.
   * @returns The holiday.
   */
  addInstance(request: CreateHolidayRequest): Promise<HolidayDto> {
    return firstValueFrom(this.http.post<HolidayDto>(apiUrl('admin/holidays'), request));
  }

  /**
   * Removes an instance holiday (admins).
   *
   * @param id Holiday id.
   * @returns Resolves once removed.
   */
  removeInstance(id: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(apiUrl(`admin/holidays/${id}`)));
  }
}
