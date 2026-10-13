import { TestBed } from '@angular/core/testing';
import type { WorkItemDto } from '@kloister/shared';
import { makeItem, makeProject } from '../../testing/fixtures';
import { ItemsApiService } from './items-api.service';
import { ProjectContext } from './project-context';
import { ProjectsApiService } from './projects-api.service';

describe('ProjectContext', () => {
  function setup() {
    const projectsApi = {
      get: vi.fn().mockResolvedValue(makeProject()),
      members: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      teams: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    };
    const itemsApi = {
      buckets: vi.fn().mockResolvedValue([]),
      labels: vi.fn().mockResolvedValue([]),
      sprints: vi.fn().mockResolvedValue([]),
      listAll: vi.fn<() => Promise<WorkItemDto[]>>(),
    };
    TestBed.configureTestingModule({
      providers: [
        ProjectContext,
        { provide: ProjectsApiService, useValue: projectsApi },
        { provide: ItemsApiService, useValue: itemsApi },
      ],
    });
    return { ctx: TestBed.inject(ProjectContext), projectsApi, itemsApi };
  }

  it('loads the project once for the first refresh', async () => {
    const { ctx, projectsApi, itemsApi } = setup();
    itemsApi.listAll.mockResolvedValue([makeItem(1)]);
    await ctx.open('KLO');
    await ctx.refresh();
    // Each request for a project a non-member admin opens is audited.
    expect(projectsApi.get).toHaveBeenCalledTimes(1);
    expect(ctx.items().map((i) => i.key)).toEqual(['KLO-1']);
    await ctx.refresh();
    expect(projectsApi.get).toHaveBeenCalledTimes(2);
  });

  it('keeps the newest refresh when an older one answers later', async () => {
    const { ctx, itemsApi } = setup();
    let answerOld: (items: WorkItemDto[]) => void = () => undefined;
    itemsApi.listAll
      .mockReturnValueOnce(new Promise((resolve) => (answerOld = resolve)))
      .mockResolvedValueOnce([makeItem(2)]);
    await ctx.open('KLO');
    const older = ctx.refresh();
    // Let the first refresh reach its item request before the second starts.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await ctx.refresh();
    answerOld([makeItem(1)]);
    await older;
    expect(ctx.items().map((i) => i.key)).toEqual(['KLO-2']);
  });

  it('offers teams per the M3 rules', async () => {
    const { ctx, projectsApi } = setup();
    projectsApi.get.mockResolvedValue(
      makeProject({ myRole: 'MEMBER', myTeams: [{ teamId: 't1', role: 'LEAD' }] }),
    );
    await ctx.open('KLO');
    expect(ctx.canPickTeam(null)).toBe(true);
    expect(ctx.canPickTeam('t1')).toBe(true);
    expect(ctx.canPickTeam('t2')).toBe(false);
  });
});
