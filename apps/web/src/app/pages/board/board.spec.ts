import type { CdkDragDrop } from '@angular/cdk/drag-drop';
import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { ProjectPermission, WorkItemDetailDto, WorkItemDto } from '@kloister/shared';
import {
  makeBucket,
  makeItem,
  makeMember,
  makeProject,
  makeSprint,
  settle,
} from '../../../testing/fixtures';
import type { BoardColumn } from '../../core/board-logic';
import { ItemsApiService } from '../../core/items-api.service';
import { ProjectContext } from '../../core/project-context';
import { ProjectsApiService } from '../../core/projects-api.service';
import { ToastService } from '../../ui/toast.service';
import { BoardPage } from './board';

/** The protected board members the tests drive directly. */
interface BoardInternals {
  columns(): BoardColumn[];
  drop(event: CdkDragDrop<BoardColumn, BoardColumn, WorkItemDto>): Promise<void>;
  toggle(userId: string): void;
  active(): string | null;
}

describe('BoardPage', () => {
  const buckets = [makeBucket('b1', 'To Do', 1), makeBucket('b2', 'Done', 2)];

  async function render(
    items: WorkItemDetailDto[],
    options: { permissions?: ProjectPermission[]; sprint?: string } = {},
  ) {
    const project = makeProject(
      options.permissions === undefined ? {} : { myPermissions: options.permissions },
    );
    const projectsApi = {
      get: vi.fn().mockResolvedValue(project),
      members: vi.fn().mockResolvedValue({
        items: [makeMember('u1', 'Ann'), makeMember('u2', 'Bo Chen')],
        nextCursor: null,
      }),
      teams: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    };
    const itemsApi = {
      buckets: vi.fn().mockResolvedValue(buckets),
      labels: vi.fn().mockResolvedValue([]),
      sprints: vi.fn().mockResolvedValue([makeSprint('s1', 'Sprint 1', 'ACTIVE')]),
      listAll: vi.fn().mockResolvedValue(items),
      move: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [BoardPage],
      providers: [
        provideRouter([]),
        ProjectContext,
        { provide: ProjectsApiService, useValue: projectsApi },
        { provide: ItemsApiService, useValue: itemsApi },
      ],
    }).compileComponents();
    const ctx = TestBed.inject(ProjectContext);
    const toast = TestBed.inject(ToastService);
    const show = vi.spyOn(toast, 'show').mockImplementation(() => undefined);
    const showError = vi.spyOn(toast, 'error').mockImplementation(() => undefined);
    await ctx.open('KLO');
    const fixture = TestBed.createComponent(BoardPage);
    if (options.sprint !== undefined) fixture.componentRef.setInput('sprint', options.sprint);
    await settle(fixture);
    const board = fixture.componentInstance as unknown as BoardInternals;
    return {
      fixture,
      root: fixture.nativeElement as HTMLElement,
      ctx,
      itemsApi,
      board,
      show,
      showError,
    };
  }

  /**
   * Builds a drop event between two columns.
   *
   * @param item The dragged card.
   * @param from Source column.
   * @param to Target column.
   * @param currentIndex Drop index.
   * @returns The event.
   */
  function dropEvent(
    item: WorkItemDto,
    from: BoardColumn,
    to: BoardColumn,
    currentIndex: number,
  ): CdkDragDrop<BoardColumn, BoardColumn, WorkItemDto> {
    return {
      item: { data: item },
      previousContainer: { data: from },
      container: { data: to },
      currentIndex,
    } as unknown as CdkDragDrop<BoardColumn, BoardColumn, WorkItemDto>;
  }

  it('shows bucket columns with their cards', async () => {
    const { root } = await render([
      makeItem(1, { title: 'Write spec', dueDate: '2000-01-01', assigneeIds: ['u1'] }),
      makeItem(2, { bucketId: 'b2', status: 'DONE' }),
    ]);
    const columns = [...root.querySelectorAll('section.column')];
    expect(columns.map((c) => c.getAttribute('aria-label'))).toEqual(['To Do', 'Done']);
    expect(columns[0]?.textContent).toContain('KLO-1');
    expect(columns[0]?.textContent).toContain('Write spec');
    expect(columns[0]?.textContent).toContain('days overdue');
    expect(columns[0]?.querySelector('.k-avatar')?.textContent?.trim()).toBe('A');
    expect(columns[0]?.querySelector('[aria-label="Priority 2 – High"]')).not.toBeNull();
    expect(columns[1]?.textContent).toContain('KLO-2');
  });

  it('offers quick-add and dragging only where the caller may act', async () => {
    const readOnly = {
      edit: false,
      move: false,
      delete: false,
      deleteCascade: false,
      annotate: false,
    };
    const { root } = await render([makeItem(1, { can: readOnly })], {
      permissions: ['VIEW_ITEMS'],
    });
    expect(root.querySelector('.quick-add')).toBeNull();
    expect(root.querySelector('.cdk-drag')?.classList).toContain('cdk-drag-disabled');
  });

  it('moves a card with afterId and shows the bucket and status the server returns', async () => {
    const first = makeItem(1, { bucketId: 'b2', position: 1 });
    const moving = makeItem(2, { position: 5 });
    const { board, itemsApi, ctx, root, fixture } = await render([first, moving]);
    // The Done bucket's entry rule set the status on the server.
    itemsApi.move.mockResolvedValue({ ...moving, bucketId: 'b2', position: 2, status: 'DONE' });
    const [todo, done] = board.columns();
    await board.drop(dropEvent(moving, todo, done, 1));
    expect(itemsApi.move).toHaveBeenCalledWith('p1', 'i2', { bucketId: 'b2', afterId: 'i1' });
    expect(ctx.itemsById().get('i2')).toMatchObject({ bucketId: 'b2', status: 'DONE' });
    await settle(fixture);
    expect(root.querySelectorAll('section.column')[1]?.textContent).toContain('KLO-2');
  });

  it('puts the card back and shows the refusal when the API says no', async () => {
    const moving = makeItem(2);
    const { board, itemsApi, ctx, showError } = await render([moving]);
    const refusal = new HttpErrorResponse({
      status: 403,
      error: { code: 'FORBIDDEN', message: 'Not yours' },
    });
    itemsApi.move.mockRejectedValue(refusal);
    const [todo, done] = board.columns();
    await board.drop(dropEvent(moving, todo, done, 0));
    expect(ctx.itemsById().get('i2')?.bucketId).toBe('b1');
    expect(showError).toHaveBeenCalledWith(refusal);
  });

  it('confirms a move with a toast whose Undo moves the card back and restores the status', async () => {
    const above = makeItem(1, { position: 1 });
    const moving = makeItem(2, { position: 2 });
    const { board, itemsApi, ctx, show } = await render([above, moving]);
    const moved = { ...moving, bucketId: 'b2', status: 'DONE' as const };
    itemsApi.move.mockResolvedValueOnce(moved);
    const [todo, done] = board.columns();
    await board.drop(dropEvent(moving, todo, done, 0));
    expect(show).toHaveBeenCalledWith(
      'KLO-2 moved to Done · status set to Done',
      expect.any(Function),
    );

    // Undo: back after KLO-1 in To Do, then the status the move changed.
    itemsApi.move.mockResolvedValueOnce({ ...moved, bucketId: 'b1' });
    itemsApi.update.mockResolvedValueOnce({ ...moving });
    const undo = show.mock.calls[0]?.[1];
    await undo?.();
    expect(itemsApi.move).toHaveBeenLastCalledWith('p1', 'i2', { bucketId: 'b1', afterId: 'i1' });
    expect(itemsApi.update).toHaveBeenCalledWith('p1', 'i2', { status: 'NOT_STARTED' });
    expect(ctx.itemsById().get('i2')).toMatchObject({ bucketId: 'b1', status: 'NOT_STARTED' });
  });

  it('filters the board to one person from the quick person filter', async () => {
    const { board, root, fixture } = await render([
      makeItem(1, { assigneeIds: ['u1'] }),
      makeItem(2, { assigneeIds: ['u2'] }),
    ]);
    const quick = root.querySelector('[aria-label="Filter by person"]');
    expect(quick?.querySelectorAll('button.k-avatar').length).toBe(2);
    board.toggle('u2');
    await settle(fixture);
    expect(board.active()).toBe('u2');
    expect(root.querySelector('.columns')?.textContent).not.toContain('KLO-1');
    expect(root.querySelector('.columns')?.textContent).toContain('KLO-2');
    expect(quick?.querySelector('[aria-label="Bo Chen"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(root.textContent).toContain('Assignee: Bo Chen');
    board.toggle('u2');
    await settle(fixture);
    expect(board.active()).toBeNull();
    expect(root.querySelector('.columns')?.textContent).toContain('KLO-1');
  });

  it('creates quick-add cards in the column they were typed into', async () => {
    const { root, itemsApi, fixture, ctx } = await render([]);
    itemsApi.create.mockResolvedValue(makeItem(9, { bucketId: 'b2', title: 'New card' }));
    const input = root.querySelectorAll<HTMLInputElement>('.quick-add')[1];
    input.value = 'New card';
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }));
    await settle(fixture);
    expect(itemsApi.create).toHaveBeenCalledWith('p1', {
      type: 'TASK',
      title: 'New card',
      bucketId: 'b2',
    });
    expect(ctx.items().map((i) => i.number)).toEqual([9]);
    expect(input.value).toBe('');
  });

  it('becomes the sprint board with ?sprint=', async () => {
    const { root } = await render([makeItem(1, { sprintId: 's1' }), makeItem(2)], {
      sprint: 's1',
    });
    expect(root.textContent).toContain('Sprint board: Sprint 1');
    expect(root.textContent).toContain('KLO-1');
    expect(root.textContent).not.toContain('KLO-2');
  });

  it('sets the status when a card is dropped in the Status view', async () => {
    const card = makeItem(1);
    const { fixture, board, itemsApi, ctx } = await render([card]);
    const page = fixture.componentInstance as unknown as { groupBy: { set(v: string): void } };
    page.groupBy.set('status');
    // The project maps Done to the Done bucket; the server moved the card.
    itemsApi.update.mockResolvedValue({ ...card, status: 'DONE', bucketId: 'b2' });
    const columns = board.columns();
    await board.drop(dropEvent(card, columns[0], columns[3], 0));
    expect(itemsApi.update).toHaveBeenCalledWith('p1', 'i1', { status: 'DONE' });
    expect(ctx.itemsById().get('i1')).toMatchObject({ status: 'DONE', bucketId: 'b2' });
  });

  it('drops the sprint filter when leaving the sprint board', async () => {
    const { fixture, root } = await render([makeItem(1, { sprintId: 's1' }), makeItem(2)], {
      sprint: 's1',
    });
    fixture.componentRef.setInput('sprint', undefined);
    await settle(fixture);
    expect(root.textContent).not.toContain('Sprint board');
    expect(root.textContent).toContain('KLO-2');
  });
});
