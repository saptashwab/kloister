import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Page, ProjectDto, ProjectMemberDto, ProjectPermission } from '@kloister/shared';
import { makeBucket, makeMember, settle } from '../../../testing/fixtures';
import { ItemsApiService } from '../../core/items-api.service';
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
  async function render(
    permissions: ProjectPermission[],
    archived = false,
    members: ProjectMemberDto[] = [member],
  ) {
    const project: ProjectDto = {
      id: 'p1',
      key: 'KLO',
      name: 'Kanban',
      description: 'About',
      archivedAt: archived ? '2026-01-02T00:00:00.000Z' : null,
      settings: { membersCanAssignOthers: false, statusToBucket: {} },
      myRole: null,
      myVisibility: 'ALL',
      myTeams: [],
      myPermissions: permissions,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const api = {
      get: vi.fn<(ref: string) => Promise<ProjectDto>>().mockResolvedValue(project),
      members: vi
        .fn<(id: string) => Promise<Page<ProjectMemberDto>>>()
        .mockResolvedValue({ items: members, nextCursor: null }),
      teams: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    };
    const itemsApi = {
      buckets: vi
        .fn()
        .mockResolvedValue([makeBucket('b1', 'To Do', 1), makeBucket('b2', 'Done', 2)]),
      labels: vi.fn().mockResolvedValue([{ id: 'l1', name: 'urgent', colour: '#ff0000' }]),
    };
    await TestBed.configureTestingModule({
      imports: [ProjectSettingsPage],
      providers: [
        provideRouter([]),
        { provide: ProjectsApiService, useValue: api },
        { provide: ItemsApiService, useValue: itemsApi },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ProjectSettingsPage);
    fixture.componentRef.setInput('key', 'KLO');
    await settle(fixture);
    return { root: fixture.nativeElement as HTMLElement, api };
  }

  it('shows a read-only view to members without management rights', async () => {
    const { root, api } = await render(['VIEW_ITEMS']);
    expect(api.get).toHaveBeenCalledWith('KLO');
    expect(api.members).toHaveBeenCalledWith('p1', undefined);
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

  it('gives admins who are not PMs PM-role controls only, even when archived', async () => {
    const { root } = await render(['VIEW_ITEMS', 'ASSIGN_PMS'], true);
    expect(root.textContent).toContain('Add as Project Manager');
    expect(root.textContent).toContain('Make PM');
    expect(root.querySelector('form')).toBeNull();
    // The member listed is a Viewer: it can be promoted, not removed.
    expect(root.textContent).not.toContain('Remove');
  });

  it('hides member editing on archived projects', async () => {
    const { root } = await render(
      ['VIEW_ITEMS', 'MANAGE_PROJECT', 'MANAGE_MEMBERS', 'MANAGE_BOARD'],
      true,
    );
    expect(root.textContent).toContain('Unarchive');
    expect(root.textContent).not.toContain('Remove');
    // Buckets, labels and the status map are read-only too.
    expect(root.textContent).not.toContain('Add bucket');
    expect(root.textContent).not.toContain('Add label');
  });

  it('offers a bucket picker for members with the BUCKETS scope', async () => {
    const scoped = makeMember('u2', 'Bea', {
      visibility: 'BUCKETS',
      allowedBucketIds: ['b2'],
    });
    const { root } = await render(['VIEW_ITEMS', 'MANAGE_MEMBERS'], false, [scoped]);
    expect(root.querySelector('[aria-label="Buckets visible to Bea"]')?.textContent).toContain(
      'Done',
    );
  });

  it('names the visible buckets in the read-only view', async () => {
    const scoped = makeMember('u2', 'Bea', {
      visibility: 'BUCKETS',
      allowedBucketIds: ['b2'],
    });
    const { root } = await render(['VIEW_ITEMS'], false, [scoped]);
    expect(root.textContent?.replace(/\s+/g, ' ')).toContain('Selected buckets (Done)');
  });

  it('shows board settings, editable with MANAGE_BOARD only', async () => {
    const viewer = await render(['VIEW_ITEMS']);
    expect(viewer.root.textContent).toContain('To Do');
    expect(viewer.root.textContent).toContain('urgent');
    expect(viewer.root.textContent).not.toContain('Add bucket');
    TestBed.resetTestingModule();
    const lead = await render(['VIEW_ITEMS', 'MANAGE_BOARD']);
    expect(lead.root.textContent).toContain('Add bucket');
    expect(lead.root.textContent).toContain('Add label');
    // The status → bucket map is a project setting (PM only).
    expect(lead.root.textContent).not.toContain('Save status moves');
  });
});
