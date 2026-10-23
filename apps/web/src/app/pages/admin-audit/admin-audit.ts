import { JsonPipe } from '@angular/common';
import { Component, inject, type OnInit, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import {
  AUDIT_ACTION_GROUPS,
  AUDIT_ACTION_LABELS,
  type AuditEntryDto,
  type MemberCandidateDto,
  type ProjectDto,
} from '@kloister/shared';
import { AdminApiService } from '../../core/admin-api.service';
import { errorMessage } from '../../core/api';
import { auditDetails, type AuditDetail } from '../../core/audit-text';
import { ProjectsApiService } from '../../core/projects-api.service';
import { AppDatePipe } from '../../ui/app-date.pipe';
import { DateField } from '../../ui/date-field';
import { EmptyState, Skeleton } from '../../ui/feedback';
import { phoneLayout, RowCardStyles } from '../../ui/row-cards';
import { UserPicker } from '../../ui/user-picker';

/** One entry as the viewer shows it. */
interface AuditRow {
  /** The stored entry. */
  entry: AuditEntryDto;
  /** Readable action. */
  action: string;
  /** Who did it: name, or "System". */
  actor: string;
  /** The project, e.g. "KLO · Kanban", or empty. */
  project: string;
  /** The entity by name, or its type and id when it no longer exists. */
  entity: string;
  /** Readable detail lines. */
  details: AuditDetail[];
}

/**
 * Audit log viewer (SPEC §6 Admin, M8.5), newest first: readable actions,
 * names instead of ids, labelled details with the raw JSON behind a
 * disclosure, and filters by action, person, project and dates. At phone
 * width the rows are cards.
 *
 * Permissions: route guarded for admins; the API enforces it independently.
 */
@Component({
  selector: 'app-admin-audit',
  host: { class: 'k-page' },
  imports: [
    AppDatePipe,
    DateField,
    EmptyState,
    JsonPipe,
    MatButtonModule,
    MatFormFieldModule,
    MatSelectModule,
    RowCardStyles,
    Skeleton,
    UserPicker,
  ],
  styles: `
    .filters {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--k-space-3);
      margin-bottom: var(--k-space-4);
    }
    .dates {
      display: inline-flex;
      align-items: center;
      gap: var(--k-space-2);
    }
    .sub {
      display: block;
      color: var(--k-muted);
      font-size: var(--k-body-sm);
    }
    .details {
      margin: 0;
      padding: 0;
      list-style: none;
      font-size: var(--k-body-sm);
    }
    summary {
      cursor: pointer;
      color: var(--k-muted);
      font-size: var(--k-body-sm);
    }
    code {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `,
  template: `
    <app-row-card-styles />
    <header class="k-page-head"><h1>Audit log</h1></header>
    <div class="filters">
      <mat-form-field>
        <mat-label>Action</mat-label>
        <mat-select [value]="filter().action" (valueChange)="setFilter({ action: $event })">
          <mat-option value="">All actions</mat-option>
          @for (group of groups; track group.name) {
            <mat-optgroup [label]="group.name">
              @for (a of group.actions; track a) {
                <mat-option [value]="a">{{ labels[a] }}</mat-option>
              }
            </mat-optgroup>
          }
        </mat-select>
      </mat-form-field>
      <app-user-picker
        label="Person"
        [searchUsers]="findUsers"
        [(selected)]="people"
        (selectedChange)="setFilter({ actorId: $event[0]?.id ?? '' })"
      />
      <mat-form-field>
        <mat-label>Project</mat-label>
        <mat-select [value]="filter().projectId" (valueChange)="setFilter({ projectId: $event })">
          <mat-option value="">All projects</mat-option>
          @for (p of projects(); track p.id) {
            <mat-option [value]="p.id">{{ p.key }} · {{ p.name }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <span class="dates">
        <app-date-field
          label="From"
          [value]="filter().from || null"
          (valueChange)="setFilter({ from: $event ?? '' })"
        />
        <span class="muted" aria-hidden="true">→</span>
        <app-date-field
          label="To"
          [value]="filter().to || null"
          [min]="filter().from || null"
          (valueChange)="setFilter({ to: $event ?? '' })"
        />
      </span>
    </div>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    @if (loading()) {
      <app-skeleton label="Loading the list" />
    } @else if (rows().length === 0) {
      <app-empty-state title="No entries match" text="Change the filters to see more history." />
    } @else if (phone()) {
      <ul class="k-row-cards" aria-label="Audit entries">
        @for (row of rows(); track row.entry.id) {
          <li class="k-row-card">
            <div class="k-row-card-title">{{ row.action }}</div>
            <dl>
              <dt>When</dt>
              <dd>{{ row.entry.createdAt | appDate }}</dd>
              <dt>Who</dt>
              <dd>
                {{ row.actor }}
                @if (row.entry.actorEmail) {
                  <span class="sub">{{ row.entry.actorEmail }}</span>
                }
              </dd>
              @if (row.project) {
                <dt>Project</dt>
                <dd>{{ row.project }}</dd>
              }
              @if (row.entity) {
                <dt>About</dt>
                <dd>{{ row.entity }}</dd>
              }
              @for (d of row.details; track $index) {
                <dt>{{ d.label }}</dt>
                <dd>{{ d.value }}</dd>
              }
            </dl>
            <details>
              <summary>Technical details</summary>
              <code>{{ row.entry.meta | json }}</code>
            </details>
          </li>
        }
      </ul>
    } @else {
      <div class="k-panel k-table-scroll" tabindex="0" role="region" aria-label="Scrollable table">
        <table class="data">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Who</th>
              <th scope="col">Action</th>
              <th scope="col">Project</th>
              <th scope="col">About</th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track row.entry.id) {
              <tr>
                <td>{{ row.entry.createdAt | appDate }}</td>
                <td>
                  {{ row.actor }}
                  @if (row.entry.actorEmail) {
                    <span class="sub">{{ row.entry.actorEmail }}</span>
                  }
                </td>
                <td>{{ row.action }}</td>
                <td>{{ row.project }}</td>
                <td>{{ row.entity }}</td>
                <td>
                  <ul class="details">
                    @for (d of row.details; track $index) {
                      <li>{{ d.label }}: {{ d.value }}</li>
                    }
                  </ul>
                  <details>
                    <summary>Technical details</summary>
                    <code>{{ row.entry.meta | json }}</code>
                  </details>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
    @if (nextCursor()) {
      <button mat-button type="button" (click)="loadMore()">Load more</button>
    }
  `,
})
export class AdminAuditPage implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly projectsApi = inject(ProjectsApiService);

  /** Action groups offered in the filter. */
  protected readonly groups = AUDIT_ACTION_GROUPS;
  /** Readable action names. */
  protected readonly labels: Record<string, string> = AUDIT_ACTION_LABELS;
  /** True at phone width, where rows become cards. */
  protected readonly phone = phoneLayout();
  /** Current filters; empty strings mean "any". */
  protected readonly filter = signal({ action: '', actorId: '', projectId: '', from: '', to: '' });
  /** The person chosen in the person filter. */
  protected readonly people = signal<MemberCandidateDto[]>([]);
  /** Projects offered in the project filter. */
  protected readonly projects = signal<ProjectDto[]>([]);
  /** Loaded entries, ready to show. */
  protected readonly rows = signal<AuditRow[]>([]);
  /** Cursor for the next page, or null. */
  protected readonly nextCursor = signal<string | null>(null);
  /** Last error message, if any. */
  protected readonly error = signal('');
  /** True while the list is being replaced. */
  protected readonly loading = signal(true);

  /**
   * Searches every user for the person filter (admins manage all users).
   *
   * @param q Search text.
   * @returns Matching users.
   */
  protected readonly findUsers = async (q: string): Promise<MemberCandidateDto[]> =>
    (await this.api.listUsers(q, undefined)).items;

  /**
   * Loads the first page and the projects for the filter.
   */
  ngOnInit(): void {
    void this.load(undefined);
    void this.projectsApi
      .list({ scope: 'all', includeArchived: true })
      .then((page) => this.projects.set(page.items))
      .catch(() => this.projects.set([]));
  }

  /**
   * Changes some filters and reloads from the newest entry.
   *
   * @param change Filters to change.
   * @returns Resolves once loaded.
   */
  protected async setFilter(
    change: Partial<{
      action: string;
      actorId: string;
      projectId: string;
      from: string;
      to: string;
    }>,
  ): Promise<void> {
    this.filter.update((f) => ({ ...f, ...change }));
    await this.load(undefined);
  }

  /**
   * Appends the next page.
   *
   * @returns Resolves once loaded.
   */
  protected async loadMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (cursor !== null) await this.load(cursor);
  }

  /**
   * Fetches a page and replaces or extends the list. The date range covers
   * whole local days: from the start of "From" to the end of "To".
   *
   * @param cursor Cursor to continue from, or undefined for the first page.
   * @returns Resolves once loaded.
   */
  private async load(cursor: string | undefined): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    const f = this.filter();
    const startOf = (day: string, offset = 0): string => {
      const [y, m, d] = day.split('-').map(Number) as [number, number, number];
      return new Date(y, m - 1, d + offset).toISOString();
    };
    try {
      const page = await this.api.listAudit({
        action: f.action,
        actorId: f.actorId,
        projectId: f.projectId,
        from: f.from ? startOf(f.from) : undefined,
        to: f.to ? startOf(f.to, 1) : undefined,
        cursor,
      });
      const rows = page.items.map(toRow);
      this.rows.update((existing) => (cursor ? [...existing, ...rows] : rows));
      this.nextCursor.set(page.nextCursor);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }
}

/** Entity types the API names at read time (AuditService.names). */
const NAMED_TYPES = new Set([
  'Project',
  'WorkItem',
  'User',
  'ProjectMember',
  'Bucket',
  'Label',
  'Sprint',
  'Team',
]);
/** A stored uuid entity id. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Builds the readable form of one entry.
 *
 * @param entry The stored entry.
 * @returns The row.
 */
export function toRow(entry: AuditEntryDto): AuditRow {
  const labels: Record<string, string> = AUDIT_ACTION_LABELS;
  const project =
    entry.projectKey || entry.projectName
      ? [entry.projectKey, entry.projectName].filter(Boolean).join(' · ')
      : '';
  // Only uuid ids of named entity types are looked up; others (setting keys, file names) are shown as stored.
  const resolvable = NAMED_TYPES.has(entry.entityType) && UUID.test(entry.entityId ?? '');
  const entity =
    entry.entityLabel ??
    (!entry.entityId
      ? ''
      : resolvable
        ? `${entry.entityType} ${entry.entityId.slice(0, 8)}… (deleted)`
        : `${entry.entityType} ${entry.entityId}`);
  return {
    entry,
    action: labels[entry.action] ?? entry.action,
    actor: entry.actorName ?? entry.actorEmail ?? 'System',
    project,
    entity: entry.entityType === 'Project' && entity === entry.projectKey ? '' : entity,
    details: auditDetails(entry.meta),
  };
}
