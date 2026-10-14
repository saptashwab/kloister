import { inject, Injectable, signal } from '@angular/core';
import type { ProjectDto } from '@kloister/shared';
import { fetchAll } from './items-api.service';
import { ProjectsApiService } from './projects-api.service';

/**
 * The caller's projects for the sidebar's project switcher (DESIGN §7):
 * their own memberships, archived ones left out. Pages that create, rename
 * or archive projects call {@link refresh}.
 */
@Injectable({ providedIn: 'root' })
export class ProjectsNav {
  private readonly api = inject(ProjectsApiService);

  /** The caller's unarchived projects, by key. */
  readonly projects = signal<ProjectDto[]>([]);

  /** Counts loads, so only the latest stores its answer. */
  private run = 0;

  /**
   * Reloads the list; failures leave the previous list (the sidebar is a
   * shortcut, the projects page shows errors).
   *
   * @returns Resolves once loaded.
   */
  async refresh(): Promise<void> {
    const run = ++this.run;
    try {
      const projects = await fetchAll((cursor) =>
        this.api.list(cursor === undefined ? {} : { cursor }),
      );
      if (run === this.run) {
        this.projects.set(
          projects
            .filter((p) => p.archivedAt === null && p.ownerId === null)
            .sort((a, b) => (a.key ?? '').localeCompare(b.key ?? '')),
        );
      }
    } catch {
      // Keep the last list.
    }
  }

  /** Forgets the list, e.g. after signing out. */
  clear(): void {
    this.run++;
    this.projects.set([]);
  }
}
