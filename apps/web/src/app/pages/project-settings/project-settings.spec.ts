import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Page, ProjectDto, ProjectMemberDto, ProjectPermission } from '@kloister/shared';
import { ProjectsApiService } from '../../core/projects-api.service';
import { ProjectSettingsPage } from './project-settings';

const member: ProjectMemberDto = {
  id: 'm1',
  userId: 'u1',
  email: 'ann@example.org',
  displayName: 'Ann',
  isActive: true,
  role: 'VIEWER',
  visibility: 'OWN',
  allowedBucketIds: [],
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('ProjectSettingsPage', () => {
  async function render(permissions: ProjectPermission[], archived = false) {
    const project: ProjectDto = {
      id: 'p1',
      key: 'KLO',
      name: 'Kanban',
      description: 'About',
      archivedAt: archived ? '2026-01-02T00:00:00.000Z' : null,
      settings: { membersCanAssignOthers: false },
      myRole: null,
      myVisibility: 'ALL',
      myPermissions: permissions,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const api = {
      get: vi.fn<(ref: string) => Promise<ProjectDto>>().mockResolvedValue(project),
      members: vi
        .fn<(id: string) => Promise<Page<ProjectMemberDto>>>()
        .mockResolvedValue({ items: [member], nextCursor: null }),
    };
    await TestBed.configureTestingModule({
      imports: [ProjectSettingsPage],
      providers: [provideRouter([]), { provide: ProjectsApiService, useValue: api }],
    }).compileComponents();
    const fixture = TestBed.createComponent(ProjectSettingsPage);
    fixture.componentRef.setInput('key', 'KLO');
    await fixture.whenStable();
    return { root: fixture.nativeElement as HTMLElement, api };
  }

  it('shows a read-only view to members without management rights', async () => {
    const { root, api } = await render(['VIEW_ITEMS']);
    expect(api.get).toHaveBeenCalledWith('KLO');
    expect(api.members).toHaveBeenCalledWith('p1');
    expect(root.textContent).toContain('Ann');
    expect(root.textContent).toContain('Viewer');
    expect(root.textContent).toContain('Own items');
    expect(root.querySelector('form')).toBeNull();
    expect(root.textContent).not.toContain('Remove');
  });

  it('shows editing controls to PMs', async () => {
    const { root } = await render(['VIEW_ITEMS', 'MANAGE_PROJECT', 'MANAGE_MEMBERS']);
    expect(root.querySelector('form')).not.toBeNull();
    expect(root.textContent).toContain('Remove');
    expect(root.textContent).toContain('Find user');
  });

  it('hides member editing on archived projects', async () => {
    const { root } = await render(['VIEW_ITEMS', 'MANAGE_PROJECT', 'MANAGE_MEMBERS'], true);
    expect(root.textContent).toContain('archived and read-only');
    expect(root.textContent).toContain('Unarchive');
    expect(root.textContent).not.toContain('Remove');
  });
});
