import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { ItemRefDto, WorkItemDetailDto } from '@kloister/shared';
import {
  makeBucket,
  makeItem,
  makeMember,
  makeProject,
  makeSprint,
  settle,
} from '../../../testing/fixtures';
import { ItemsApiService } from '../../core/items-api.service';
import { ProjectContext } from '../../core/project-context';
import { ProjectsApiService } from '../../core/projects-api.service';
import { SessionStore } from '../../core/session.store';
import { BacklogPage } from './backlog';

/** The protected backlog members the tests drive directly. */
interface BacklogInternals {
  toggle(id: string, on: boolean): void;
  bulk(field: 'sprint' | 'bucket' | 'assignee', value: string): Promise<void>;
}

const hiddenEpic: ItemRefDto = { id: 'i1', number: 1, key: 'KLO-1', type: 'EPIC', title: 'Secret' };
const readOnly = { edit: false, move: false, delete: false, deleteCascade: false, annotate: false };

describe('BacklogPage', () => {
  async function render(items: WorkItemDetailDto[]) {
    const projectsApi = {
      get: vi.fn().mockResolvedValue(makeProject()),
      members: vi.fn().mockResolvedValue({ items: [makeMember('u1', 'Ann')], nextCursor: null }),
      teams: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    };
    const itemsApi = {
      buckets: vi.fn().mockResolvedValue([makeBucket('b1', 'To Do', 1)]),
      labels: vi.fn().mockResolvedValue([]),
      sprints: vi.fn().mockResolvedValue([makeSprint('s1', 'Sprint 1', 'PLANNED')]),
      listAll: vi.fn().mockResolvedValue(items),
      update: vi.fn(),
      move: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [BacklogPage],
      providers: [
        provideRouter([]),
        ProjectContext,
        { provide: ProjectsApiService, useValue: projectsApi },
        { provide: ItemsApiService, useValue: itemsApi },
      ],
    }).compileComponents();
    TestBed.inject(SessionStore).set({
      id: 'u1',
      email: 'ann@example.org',
      displayName: 'Ann',
      systemRole: 'USER',
      mustChangePassword: false,
      isActive: true,
      lastLoginAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await TestBed.inject(ProjectContext).open('KLO');
    const fixture = TestBed.createComponent(BacklogPage);
    await settle(fixture);
    const page = fixture.componentInstance as unknown as BacklogInternals;
    return { fixture, root: fixture.nativeElement as HTMLElement, itemsApi, page };
  }

  it('shows the tree with hidden ancestors as unselectable title rows', async () => {
    const feature = makeItem(2, {
      type: 'FEATURE',
      title: 'Login',
      parentId: 'i1',
      ancestors: [hiddenEpic],
    });
    const { root } = await render([feature]);
    const rows = [...root.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toMatch(/KLO-1\s*Secret/);
    expect(rows[1]?.textContent).toMatch(/KLO-2\s*Login/);
    expect(rows[0]?.querySelector('mat-checkbox')).toBeNull();
    expect(rows[0]?.querySelector('a')).toBeNull();
    expect(rows[1]?.querySelector('mat-checkbox')).not.toBeNull();
  });

  it('bulk-sets the sprint item by item, skipping items the caller cannot edit', async () => {
    const editable = makeItem(3);
    const locked = makeItem(4, { can: readOnly });
    const { page, itemsApi, root, fixture } = await render([editable, locked]);
    itemsApi.update.mockResolvedValue({ ...editable, sprintId: 's1' });
    page.toggle('i3', true);
    page.toggle('i4', true);
    await page.bulk('sprint', 's1');
    await settle(fixture);
    expect(itemsApi.update).toHaveBeenCalledTimes(1);
    expect(itemsApi.update).toHaveBeenCalledWith('p1', 'i3', { sprintId: 's1' });
    expect(root.textContent).toContain('1 updated, 0 already set, 1 skipped, 0 refused.');
    expect(root.textContent).toContain('KLO-4: you cannot make this change');
  });

  it('bulk-moves cards through the move endpoint', async () => {
    const card = makeItem(3, { bucketId: 'b9' });
    const { page, itemsApi } = await render([card]);
    itemsApi.move.mockResolvedValue({ ...card, bucketId: 'b1' });
    page.toggle('i3', true);
    await page.bulk('bucket', 'b1');
    expect(itemsApi.move).toHaveBeenCalledWith('p1', 'i3', { bucketId: 'b1' });
  });
});
