import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AuditEntryDto,
  CreateUserRequest,
  Page,
  TemporaryPasswordResponse,
  UpdateUserRequest,
  UserDto,
} from '@kloister/shared';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from './api';

/** Filters for {@link AdminApiService.listAudit}. */
export interface AuditFilter {
  /** Only this action. */
  action?: string;
  /** Cursor from the previous page. */
  cursor?: string;
}

/**
 * Client for the admin endpoints (users and audit log). The API rejects
 * non-admins with 403; the UI hides these screens from them as well.
 */
@Injectable({ providedIn: 'root' })
export class AdminApiService {
  private readonly http = inject(HttpClient);

  /**
   * Lists users, newest first.
   *
   * @param q Optional search text.
   * @param cursor Cursor from the previous page.
   * @returns One page of users.
   */
  listUsers(q?: string, cursor?: string): Promise<Page<UserDto>> {
    let params = new HttpParams();
    if (q) params = params.set('q', q);
    if (cursor) params = params.set('cursor', cursor);
    return firstValueFrom(this.http.get<Page<UserDto>>(apiUrl('admin/users'), { params }));
  }

  /**
   * Creates a user.
   *
   * @param request Email, name and role.
   * @returns The user and their one-time temporary password.
   */
  createUser(request: CreateUserRequest): Promise<TemporaryPasswordResponse> {
    return firstValueFrom(
      this.http.post<TemporaryPasswordResponse>(apiUrl('admin/users'), request),
    );
  }

  /**
   * Changes a user's name, role or active state.
   *
   * @param id User id.
   * @param request Fields to change.
   * @returns The updated user.
   */
  updateUser(id: string, request: UpdateUserRequest): Promise<UserDto> {
    return firstValueFrom(this.http.patch<UserDto>(apiUrl(`admin/users/${id}`), request));
  }

  /**
   * Issues a new temporary password and ends the user's sessions.
   *
   * @param id User id.
   * @returns The user and their one-time temporary password.
   */
  resetPassword(id: string): Promise<TemporaryPasswordResponse> {
    return firstValueFrom(
      this.http.post<TemporaryPasswordResponse>(apiUrl(`admin/users/${id}/reset-password`), {}),
    );
  }

  /**
   * Lists audit entries, newest first.
   *
   * @param filter Optional action filter and cursor.
   * @returns One page of entries.
   */
  listAudit(filter: AuditFilter = {}): Promise<Page<AuditEntryDto>> {
    let params = new HttpParams();
    if (filter.action) params = params.set('action', filter.action);
    if (filter.cursor) params = params.set('cursor', filter.cursor);
    return firstValueFrom(this.http.get<Page<AuditEntryDto>>(apiUrl('admin/audit'), { params }));
  }
}
