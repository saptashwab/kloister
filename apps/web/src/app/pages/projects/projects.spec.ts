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

  it('shows open, overdue and last activity, and a dash without a summary (M8.5)', async () => {
    list.mockReset();
    const counted = {
      ...project,
      summary: { open: 7, overdue: 2, lastActivityAt: '2026-10-23T12:05:00.000Z' },
    };
    const other = { ...project, id: 'p2', key: 'OTH', myRole: null, summary: null };
    await TestBed.configureTestingModule({
      imports: [ProjectsPage],
      providers: [
        provideRouter([]),
        {
          provide: ProjectsApiService,
          useValue: {
            list: vi.fn().mockResolvedValue({ items: [counted, other], nextCursor: null }),
          },
        },
        { provide: AdminApiService, useValue: {} },
      ],
    }).compileComponents();
    TestBed.inject(SessionStore).set({ systemRole: 'ADMIN' } as UserDto);
    const fixture = TestBed.createComponent(ProjectsPage);
    await settle(fixture);
    const rows = [...(fixture.nativeElement as HTMLElement).querySelectorAll('tbody tr')].map((r) =>
      [...r.querySelectorAll('td')].map((c) => c.textContent?.trim()),
    );
    expect(rows[0]?.slice(3, 5)).toEqual(['7', '2']);
    expect(rows[0]?.[5]).toMatch(/^23 Oct 2026, \d\d:\d\d$/);
    expect(rows[1]?.slice(3, 6)).toEqual(['—', '—', '—']);
  });

  it('gives admins the All/My toggle and the create form', async () => {
    const root = await render('ADMIN');
    expect(root.textContent).toContain('All projects');
    expect(root.textContent).toContain('New project');
  });
});
