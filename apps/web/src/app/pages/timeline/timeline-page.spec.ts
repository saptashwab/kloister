import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { RescheduleChangeRequest, WorkItemDetailDto } from '@kloister/shared';
import {
  makeBucket,
  makeItem,
  makeMember,
  makeProject,
  makeSprint,
  settle,
} from '../../../testing/fixtures';
import { ItemsApiService } from '../../core/items-api.service';
import { PageActions } from '../../core/page-actions';
import { ProjectContext } from '../../core/project-context';
import { ProjectsApiService } from '../../core/projects-api.service';
import { RescheduleFlow } from '../../core/reschedule';
import { SessionStore } from '../../core/session.store';
import { TimelinePage } from './timeline-page';

/** The protected members the tests drive directly. */
interface TimelineInternals {
  focusCell(row: number, col: number, focusDom?: boolean): void;
  startEdit(row: number, col: number, typed: string | null): void;
  editValue(value: string): void;
  commit(next: null): Promise<void>;
  selectClick(event: MouseEvent, index: number): void;
  bulk(field: 'status', value: string): Promise<void>;
  outline(direction: 1 | -1): Promise<void>;
  linkInOrder(): Promise<void>;
}

const readOnly = { edit: false, move: false, delete: false, deleteCascade: false, annotate: false };
const epicRef = { id: 'i1', number: 1, key: 'KLO-1', type: 'EPIC' as const, title: 'Launch' };

describe('TimelinePage (M9)', () => {
  async function render(items: WorkItemDetailDto[], options: { viewer?: boolean } = {}) {
    const project = makeProject(
      options.viewer === true ? { myRole: 'VIEWER', myPermissions: ['VIEW_ITEMS'] } : {},
    );
    const projectsApi = {
      get: vi.fn().mockResolvedValue(project),
      members: vi.fn().mockResolvedValue({ items: [makeMember('u1', 'Ann')], nextCursor: null }),
      teams: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    };
    const itemsApi = {
      buckets: vi.fn().mockResolvedValue([makeBucket('b1', 'To Do', 1)]),
      labels: vi.fn().mockResolvedValue([]),
      sprints: vi.fn().mockResolvedValue([makeSprint('s1', 'Sprint 1', 'PLANNED')]),
      listAll: vi.fn().mockResolvedValue(items),
      timeline: vi.fn().mockResolvedValue({ edges: [] }),
      update: vi.fn(),
      create: vi.fn(),
      addDependency: vi.fn().mockResolvedValue(undefined),
    };
    const flow = { change: vi.fn().mockResolvedValue(null) };
    await TestBed.configureTestingModule({
      imports: [TimelinePage],
      providers: [
        provideRouter([]),
        ProjectContext,
        PageActions,
        { provide: RescheduleFlow, useValue: flow },
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
    const fixture = TestBed.createComponent(TimelinePage);
    await settle(fixture);
    await settle(fixture);
    const page = fixture.componentInstance as unknown as TimelineInternals;
    return { fixture, root: fixture.nativeElement as HTMLElement, itemsApi, flow, page };
  }

  const epic = makeItem(1, { type: 'EPIC', bucketId: null, title: 'Launch' });
  const a = makeItem(2, {
    title: 'Draft copy',
    parentId: 'i1',
    ancestors: [epicRef],
    startDate: '2026-11-05',
    startSecondHalf: true,
    dueDate: '2026-11-11',
    dueFirstHalf: true,
  });
  const b = makeItem(3, {
    title: 'Review',
    parentId: 'i1',
    ancestors: [epicRef],
    startDate: '2026-11-12',
    dueDate: '2026-11-13',
  });

  it('shows rows in hierarchy order with half days, durations and the plan total', async () => {
    const { root } = await render([epic, a, b]);
    const rows = [...root.querySelectorAll('[role="row"]')];
    expect(rows.map((r) => r.querySelector('.k-key')?.textContent?.trim())).toEqual([
      'KLO-1',
      'KLO-2',
      'KLO-3',
    ]);
    expect(rows[1]?.textContent).toContain('5 Nov, 2nd half');
    expect(rows[1]?.textContent).toContain('11 Nov, 1st half');
    // 5 Nov 2nd half to 11 Nov 1st half is 4 working days; the epic spans 6.5.
    const days = (row: Element | undefined) => row?.querySelector('.cell.num')?.textContent?.trim();
    expect(days(rows[1])).toBe('4');
    expect(days(rows[0])).toBe('6.5');
    expect(root.querySelector('.plan')?.textContent).toContain('6.5');
    expect(root.querySelectorAll('.bar').length).toBe(2);
    expect(root.querySelector('.bracket')).not.toBeNull();
  });

  it('edits a title by typing and sends date changes through the reschedule flow', async () => {
    const { page, itemsApi, flow, fixture } = await render([epic, a, b]);
    itemsApi.update.mockResolvedValue({ ...a, title: 'Draft all copy' });
    page.startEdit(1, 1, null);
    page.editValue('Draft all copy');
    await page.commit(null);
    expect(itemsApi.update).toHaveBeenCalledWith('p1', 'i2', { title: 'Draft all copy' });
    // Typing a new start keeps the duration (4 days) and keeps the half.
    page.startEdit(1, 2, null);
    page.editValue('9 Nov 2026');
    await page.commit(null);
    await settle(fixture);
    const [changes] = flow.change.mock.calls[0] as [RescheduleChangeRequest[]];
    expect(changes[0]).toEqual({
      item: 'i2',
      startDate: '2026-11-09',
      startSecondHalf: false,
      dueDate: '2026-11-12',
      dueFirstHalf: false,
    });
  });

  it('sets a status on the selected rows and links them in order', async () => {
    const { page, itemsApi, flow, root, fixture } = await render([epic, a, b]);
    itemsApi.update.mockImplementation((_p: string, id: string) =>
      Promise.resolve({ ...(id === 'i2' ? a : b), status: 'IN_PROGRESS' }),
    );
    page.selectClick(new MouseEvent('click'), 1);
    page.selectClick(new MouseEvent('click', { shiftKey: true }), 2);
    await settle(fixture);
    expect(root.querySelector('.bulk')?.textContent).toContain('2 selected');
    await page.bulk('status', 'IN_PROGRESS');
    expect(itemsApi.update).toHaveBeenCalledTimes(2);
    await page.linkInOrder();
    expect(itemsApi.addDependency).toHaveBeenCalledWith('p1', 'i3', { blockingItemId: 'i2' });
    expect(flow.change).toHaveBeenCalledWith([{ item: 'i3' }]);
  });

  it('refuses an indent that breaks the hierarchy rules without a request', async () => {
    const { page, itemsApi, root, fixture } = await render([epic, a, b]);
    page.focusCell(2, 1, false);
    page.selectClick(new MouseEvent('click'), 2);
    await page.outline(1);
    await settle(fixture);
    expect(itemsApi.update).not.toHaveBeenCalled();
    expect(root.textContent).toContain('KLO-3: A Task cannot sit under a Task');
  });

  it('is read-only for viewers: no add row, no editors, no draggable edges', async () => {
    const locked = { ...a, can: readOnly };
    const { root, page } = await render([epic, locked], { viewer: true });
    expect(root.querySelector('.add')).toBeNull();
    page.startEdit(1, 1, null);
    expect(root.querySelector('.cell input[aria-label^="Title"]')).toBeNull();
    expect(root.querySelector('.bar .edge')).toBeNull();
  });
});
