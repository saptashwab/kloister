import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Page, ProjectDto, UserDto } from '@kloister/shared';
import { AdminApiService } from '../../core/admin-api.service';
import { type ProjectListFilter, ProjectsApiService } from '../../core/projects-api.service';
import { SessionStore } from '../../core/session.store';
import { settle } from '../../../testing/fixtures';
import { ProjectsPage } from './projects';

const project: ProjectDto = {
  id: 'p1',
  key: 'KLO',
  ownerId: null,
  name: 'Kanban',
  description: '',
  archivedAt: null,
  settings: { membersCanAssignOthers: false, statusToBucket: {}, labelStyle: 'SOLID' },
  myRole: 'LEAD',
  myVisibility: 'ALL',
  myTeams: [],
  myPermissions: ['VIEW_ITEMS'],
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('ProjectsPage', () => {
  const list = vi.fn<(f: ProjectListFilter) => Promise<Page<ProjectDto>>>();

  async function render(systemRole: UserDto['systemRole']) {
    list.mockReset();
    list.mockResolvedValue({ items: [project], nextCursor: null });
    await TestBed.configureTestingModule({
      imports: [ProjectsPage],
      providers: [
        provideRouter([]),
        { provide: ProjectsApiService, useValue: { list } },
        { provide: AdminApiService, useValue: {} },
      ],
    }).compileComponents();
    TestBed.inject(SessionStore).set({ systemRole } as UserDto);
    const fixture = TestBed.createComponent(ProjectsPage);
    await settle(fixture);
    return fixture.nativeElement as HTMLElement;
  }

  it("lists the user's projects with their role and no admin controls", async () => {
    const root = await render('USER');
    expect(list).toHaveBeenCalledWith({ scope: 'mine', includeArchived: false });
    expect(root.textContent).toContain('KLO');
    expect(root.textContent).toContain('Lead');
    expect(root.textContent).not.toContain('All projects');
    expect(root.textContent).not.toContain('New project');
  });

  it('gives admins the All/My toggle and the create form', async () => {
    const root = await render('ADMIN');
    expect(root.textContent).toContain('All projects');
    expect(root.textContent).toContain('New project');
  });
});
