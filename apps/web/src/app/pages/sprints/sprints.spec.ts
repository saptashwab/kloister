import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { ProjectPermission } from '@kloister/shared';
import { makeItem, makeProject, makeSprint, settle } from '../../../testing/fixtures';
import { ItemsApiService } from '../../core/items-api.service';
import { ProjectContext } from '../../core/project-context';
import { ProjectsApiService } from '../../core/projects-api.service';
import { SprintsPage } from './sprints';
import { PageActions } from '../../core/page-actions';

/** The protected page members the tests drive directly. */
interface SprintsInternals {
  openClose(sprint: object): void;
  closeTarget: { set(value: string): void };
  close(sprint: object): Promise<void>;
}

describe('SprintsPage', () => {
  const active = makeSprint('s1', 'Sprint 1', 'ACTIVE');
  const planned = makeSprint('s2', 'Sprint 2', 'PLANNED');

  async function render(permissions?: ProjectPermission[]) {
    const projectsApi = {
      get: vi
        .fn()
        .mockResolvedValue(
          makeProject(permissions === undefined ? {} : { myPermissions: permissions }),
        ),
      members: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      teams: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    };
    const itemsApi = {
      buckets: vi.fn().mockResolvedValue([]),
      labels: vi.fn().mockResolvedValue([]),
      sprints: vi.fn().mockResolvedValue([active, planned]),
      listAll: vi
        .fn()
        .mockResolvedValue([
          makeItem(1, { sprintId: 's1' }),
          makeItem(2, { sprintId: 's1', status: 'DONE' }),
        ]),
      closeSprint: vi
        .fn()
        .mockResolvedValue({ sprint: { ...active, state: 'CLOSED' }, movedItems: 1 }),
    };
    await TestBed.configureTestingModule({
      imports: [SprintsPage],
      providers: [
        provideRouter([]),
        ProjectContext,
        PageActions,
        { provide: ProjectsApiService, useValue: projectsApi },
        { provide: ItemsApiService, useValue: itemsApi },
      ],
    }).compileComponents();
    await TestBed.inject(ProjectContext).open('KLO');
    const fixture = TestBed.createComponent(SprintsPage);
    await settle(fixture);
    const page = fixture.componentInstance as unknown as SprintsInternals;
    return { fixture, root: fixture.nativeElement as HTMLElement, itemsApi, page };
  }

  it('lists sprints with sprint board links but no controls for members', async () => {
    const { root } = await render(['VIEW_ITEMS', 'CREATE_ITEMS']);
    expect(root.textContent).toContain('Sprint 1');
    expect(root.textContent).toContain('Active');
    expect(root.querySelector('a[href*="sprint=s1"]')).not.toBeNull();
    expect(root.querySelector('form')).toBeNull();
    expect(root.textContent).not.toContain('Set active');
    expect(root.textContent).not.toContain('Close');
  });

  it('gives PMs and Leads the management controls', async () => {
    const { root } = await render();
    expect(root.querySelector('form')).not.toBeNull();
    expect(root.textContent).toContain('Set active');
    expect(root.textContent).toContain('Close');
  });

  it('closes a sprint and moves unfinished items to the backlog', async () => {
    const { page, itemsApi, root, fixture } = await render();
    page.openClose(active);
    await settle(fixture);
    expect(root.textContent).toContain('1 unfinished items are in this sprint.');
    page.closeTarget.set('none');
    await page.close(active);
    await settle(fixture);
    expect(itemsApi.closeSprint).toHaveBeenCalledWith('p1', 's1', { moveUnfinishedTo: null });
    expect(root.textContent).toContain('1 unfinished items moved');
  });
});
