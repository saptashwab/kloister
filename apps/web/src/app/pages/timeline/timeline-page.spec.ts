import { TestBed } from '@angular/core/testing';
import { ToastService } from '../../ui/toast.service';
import { provideRouter } from '@angular/router';
import type {
  HolidayDto,
  ProjectHolidaysDto,
  RescheduleChangeRequest,
  WorkItemDetailDto,
} from '@kloister/shared';
import {
  makeBucket,
  makeItem,
  makeMember,
  makeProject,
  makeSprint,
  settle,
} from '../../../testing/fixtures';
import { HolidaysApiService } from '../../core/holidays-api.service';
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
  focusAddChild(parent: WorkItemDetailDto): void;
  addRow(input: HTMLInputElement): Promise<void>;
  addLabel(): string;
  linkInOrder(): Promise<void>;
  typesFor(item: WorkItemDetailDto): string[];
  setType(item: WorkItemDetailDto, type: string): Promise<void>;
  resizeKey(event: KeyboardEvent, column: { id: string; width: number }): void;
  setDensity(density: 'compact' | 'two' | 'three'): void;
  setPane(width: number | null): void;
  gridPane(): number;
  gridWidth(): number;
  gridShift(): number;
}

const readOnly = {
  edit: false,
  plan: false,
  move: false,
  delete: false,
  deleteCascade: false,
  annotate: false,
};
const epicRef = { id: 'i1', number: 1, key: 'KLO-1', type: 'EPIC' as const, title: 'Launch' };

describe('TimelinePage (M9)', () => {
  async function render(
    items: WorkItemDetailDto[],
    options: { viewer?: boolean; holidays?: Partial<ProjectHolidaysDto> } = {},
  ) {
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
    const holidaysApi = {
      forProject: vi.fn().mockResolvedValue({
        holidays: [],
        useInstanceHolidays: true,
        instanceChanges: [],
        ...options.holidays,
      }),
      markReviewed: vi.fn().mockResolvedValue(undefined),
    };
    await TestBed.configureTestingModule({
      imports: [TimelinePage],
      providers: [
        provideRouter([]),
        ProjectContext,
        PageActions,
        { provide: RescheduleFlow, useValue: flow },
        { provide: HolidaysApiService, useValue: holidaysApi },
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
    return {
      fixture,
      root: fixture.nativeElement as HTMLElement,
      itemsApi,
      flow,
      page,
      holidaysApi,
    };
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
    expect(root.textContent).toContain('KLO-3: A Task cannot have child items');
  });

  it('adds child rows with the natural child type under the chosen row (v1.3.1)', async () => {
    const feature = makeItem(7, { type: 'FEATURE', bucketId: null, title: 'Checkout' });
    const { page, itemsApi, fixture, root } = await render([epic, a, feature]);
    itemsApi.create.mockImplementation((_p: string, request: { title: string }) =>
      Promise.resolve(makeItem(8, { type: 'STORY', title: request.title, parentId: feature.id })),
    );
    page.focusAddChild(feature);
    await settle(fixture);
    expect(page.addLabel()).toContain('New row under KLO-7');
    const input = document.createElement('input');
    input.value = 'Pay by card';
    await page.addRow(input);
    expect(itemsApi.create).toHaveBeenCalledWith('p1', {
      type: 'STORY',
      title: 'Pay by card',
      parentId: feature.id,
    });
    // Tasks and Bugs take no children: Alt+Enter on one says so.
    itemsApi.create.mockClear();
    page.focusAddChild(a);
    expect(itemsApi.create).not.toHaveBeenCalled();
    const show = vi.spyOn(TestBed.inject(ToastService), 'show');
    page.focusCell(1, 1, false);
    root
      .querySelector('[role="grid"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }));
    expect(show).toHaveBeenCalledWith('A Task cannot have child rows');
    // Alt+Enter on the Feature points the add field at it.
    page.focusCell(2, 1, false);
    root
      .querySelector('[role="grid"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }));
    await settle(fixture);
    expect(page.addLabel()).toContain('New row under KLO-7');
  });

  it('is read-only for viewers: no add row, no editors, no draggable edges', async () => {
    const locked = { ...a, can: readOnly };
    const { root, page } = await render([epic, locked], { viewer: true });
    expect(root.querySelector('.add')).toBeNull();
    page.startEdit(1, 1, null);
    expect(root.querySelector('.cell input[aria-label^="Title"]')).toBeNull();
    expect(root.querySelector('.bar .edge')).toBeNull();
  });

  it('keeps titles, dates and links to Leads when the schedule is kept to them', async () => {
    const own = { ...readOnly, edit: true, plan: false, move: true, annotate: true };
    const mine = { ...b, can: own };
    const { root, page, itemsApi, fixture } = await render([epic, a, mine]);
    page.startEdit(2, 1, null);
    page.startEdit(2, 2, null);
    await settle(fixture);
    expect(root.querySelector('.cell input[aria-label^="Title"]')).toBeNull();
    expect(root.querySelector('.cell input[aria-label^="Start"]')).toBeNull();
    // Only the Lead-editable row gets drag handles.
    expect(root.querySelectorAll('.bar .edge').length).toBe(2);
    page.selectClick(new MouseEvent('click'), 1);
    page.selectClick(new MouseEvent('click', { shiftKey: true }), 2);
    await page.linkInOrder();
    await settle(fixture);
    expect(itemsApi.addDependency).not.toHaveBeenCalled();
    expect(root.textContent).toContain('KLO-3: only PMs and Leads change its plan');
  });

  it('narrows the table with the splitter and scrolls a focused cell into view', async () => {
    const { page, root, fixture } = await render([epic, a, b]);
    const full = page.gridWidth();
    page.setPane(300);
    await settle(fixture);
    expect(page.gridPane()).toBe(300);
    expect(root.querySelector('.gscroll')).not.toBeNull();
    expect(localStorage.getItem('kloister.timeline.pane')).toBe('300');
    // Focusing the last column shifts the table so the cell shows.
    page.focusCell(1, 5, false);
    expect(page.gridShift()).toBeGreaterThan(0);
    page.focusCell(1, 0, false);
    expect(page.gridShift()).toBe(0);
    // As wide as the columns (or wider) fits them again.
    page.setPane(full + 50);
    await settle(fixture);
    expect(page.gridPane()).toBe(full);
    expect(root.querySelector('.gscroll')).toBeNull();
    page.setPane(null);
  });

  it('changes types within the hierarchy, resizes columns and wraps titles', async () => {
    localStorage.removeItem('kloister.timeline.widths');
    const { page, itemsApi, root, fixture } = await render([epic, a, b]);
    // Under an Epic only a Feature fits the hierarchy.
    expect(page.typesFor(a)).toEqual(['FEATURE']);
    itemsApi.update.mockResolvedValue({ ...epic, type: 'FEATURE' });
    expect(page.typesFor(epic)).toContain('FEATURE');
    await page.setType(epic, 'FEATURE');
    expect(itemsApi.update).toHaveBeenCalledWith('p1', 'i1', { type: 'FEATURE' });
    const title = { id: 'title', width: 200 };
    page.resizeKey(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true }), title);
    await settle(fixture);
    const header = root.querySelector<HTMLElement>(
      '[role="separator"][aria-label="Resize the Title column"]',
    );
    expect(header?.getAttribute('aria-valuenow')).toBe('232');
    page.setDensity('two');
    await settle(fixture);
    expect((fixture.nativeElement as HTMLElement).style.getPropertyValue('--tl-row')).toBe('52px');
    expect((fixture.nativeElement as HTMLElement).classList.contains('wrap')).toBe(true);
    page.setDensity('compact');
    localStorage.removeItem('kloister.timeline.widths');
  });

  it('skips holidays in durations and offers to keep durations after instance changes', async () => {
    const holiday: HolidayDto = {
      id: 'h1',
      name: 'Founders day',
      startDate: '2026-11-09',
      endDate: '2026-11-09',
      scope: 'INSTANCE',
      createdAt: '2026-11-01T00:00:00.000Z',
      deletedAt: null,
    };
    const { root, flow, holidaysApi, fixture } = await render([epic, a, b], {
      holidays: { holidays: [holiday], instanceChanges: [holiday] },
    });
    const rows = [...root.querySelectorAll('[role="row"]')];
    // KLO-2 spans Monday 9 Nov, now a holiday: 3 working days instead of 4.
    expect(rows[1]?.querySelector('.cell.num')?.textContent?.trim()).toBe('3');
    expect(root.querySelector('.holiday')).not.toBeNull();
    const notice = root.querySelector('.notice');
    expect(notice?.textContent).toContain('1 item spans them');
    flow.change.mockResolvedValue({ changes: [], kept: [], items: [], rescheduleId: 'r1' });
    [...(notice?.querySelectorAll('button') ?? [])][0]?.click();
    await settle(fixture);
    const [changes] = flow.change.mock.calls[0] as [RescheduleChangeRequest[]];
    expect(changes[0]).toMatchObject({ item: 'i2', dueDate: '2026-11-12', dueFirstHalf: true });
    expect(holidaysApi.markReviewed).toHaveBeenCalledWith('p1', '2026-11-01T00:00:00.000Z');
    expect(root.querySelector('.notice')).toBeNull();
  });
});
