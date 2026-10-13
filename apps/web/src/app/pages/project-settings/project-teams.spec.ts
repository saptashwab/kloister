import { TestBed } from '@angular/core/testing';
import type { Page, ProjectMemberDto, TeamDto } from '@kloister/shared';
import { ProjectsApiService } from '../../core/projects-api.service';
import { ProjectTeamsComponent } from './project-teams';

const viewer: ProjectMemberDto = {
  id: 'm1',
  userId: 'u1',
  email: 'ann@example.org',
  displayName: 'Ann',
  isActive: true,
  role: 'VIEWER',
  visibility: 'TEAMS',
  allowedBucketIds: [],
  createdAt: '2026-01-01T00:00:00.000Z',
};

const team: TeamDto = {
  id: 't1',
  name: 'Backend',
  description: '',
  members: [
    { userId: 'u1', email: 'ann@example.org', displayName: 'Ann', isActive: true, role: 'MEMBER' },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('ProjectTeamsComponent', () => {
  async function render(canEdit: boolean) {
    const api = {
      teams: vi
        .fn<(id: string) => Promise<Page<TeamDto>>>()
        .mockResolvedValue({ items: [team], nextCursor: null }),
    };
    await TestBed.configureTestingModule({
      imports: [ProjectTeamsComponent],
      providers: [{ provide: ProjectsApiService, useValue: api }],
    }).compileComponents();
    const fixture = TestBed.createComponent(ProjectTeamsComponent);
    fixture.componentRef.setInput('projectId', 'p1');
    fixture.componentRef.setInput('members', [viewer]);
    fixture.componentRef.setInput('canEdit', canEdit);
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    return {
      root: fixture.nativeElement as HTMLElement,
      api,
      component: fixture.componentInstance,
    };
  }

  it('lists teams read-only for non-PMs', async () => {
    const { root, api } = await render(false);
    expect(api.teams).toHaveBeenCalledWith('p1', undefined);
    expect(root.textContent).toContain('Backend');
    expect(root.textContent).toContain('Team member');
    expect(root.textContent).not.toContain('Create team');
    expect(root.textContent).not.toContain('Remove');
  });

  it('shows team management to PMs', async () => {
    const { root } = await render(true);
    expect(root.textContent).toContain('Create team');
    expect(root.textContent).toContain('Add to team');
    expect(root.textContent).toContain('Remove');
  });

  it('offers project Viewers the team Member role only', async () => {
    const { component } = await render(true);
    const rolesFor = (component as unknown as { rolesFor: (id: string) => string[] }).rolesFor.bind(
      component,
    );
    expect(rolesFor('u1')).toEqual(['MEMBER']);
    expect(rolesFor('someone-else')).toEqual(['LEAD', 'MEMBER']);
  });
});
