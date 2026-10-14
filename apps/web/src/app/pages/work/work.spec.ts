import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { UserWorkDto } from '@kloister/shared';
import { settle } from '../../../testing/fixtures';
import { SessionStore } from '../../core/session.store';
import { ItemsApiService } from '../../core/items-api.service';
import { ToastService } from '../../ui/toast.service';
import { WorkApiService } from '../../core/work-api.service';
import { WorkPage } from './work';

describe('WorkPage', () => {
  const page: UserWorkDto = {
    user: { id: 'u2', displayName: 'Bo Chen', email: 'bo@example.org' },
    items: [
      {
        id: 'i1',
        number: 4,
        key: 'KLO-4',
        projectId: 'p1',
        projectKey: 'KLO',
        personal: false,
        bucket: { id: 'b1', name: 'Doing' },
        labels: [],
        labelStyle: 'SOLID',
        canEdit: false,
        projectName: 'Kanban',
        type: 'TASK',
        title: 'Invoice form',
        status: 'IN_PROGRESS',
        priority: 2,
        dueDate: '2000-01-01',
      },
    ],
    nextCursor: null,
  };

  async function render(userId: string, pages: UserWorkDto[] = [page]) {
    const api = { list: vi.fn().mockResolvedValue(pages[0]) };
    for (const result of pages) api.list.mockResolvedValueOnce(result);
    const itemsApi = { update: vi.fn(), buckets: vi.fn(), move: vi.fn() };
    const toast = { show: vi.fn(), error: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [WorkPage],
      providers: [
        provideRouter([]),
        { provide: WorkApiService, useValue: api },
        { provide: ItemsApiService, useValue: itemsApi },
        { provide: ToastService, useValue: toast },
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
    const fixture = TestBed.createComponent(WorkPage);
    fixture.componentRef.setInput('userId', userId);
    await settle(fixture);
    return { api, itemsApi, toast, fixture, root: fixture.nativeElement as HTMLElement };
  }

  it("lists a person's items with links into their projects", async () => {
    const { api, root } = await render('u2');
    expect(api.list).toHaveBeenCalledWith('u2', { includeDone: false });
    expect(root.querySelector('h1')?.textContent).toContain('Bo Chen');
    expect(root.textContent).toContain('bo@example.org');
    const link = root.querySelector('a.entry');
    expect(link?.getAttribute('href')).toBe('/p/KLO/items/4');
    expect(link?.textContent).toContain('Invoice form');
    expect(link?.closest('.card')?.textContent).toContain('Kanban');
    expect(link?.closest('.card')?.textContent).toContain('days overdue');
  });

  it('is "My work" for the signed-in user and reloads with Done items on request', async () => {
    const { api, root, fixture } = await render('u1');
    expect(root.querySelector('h1')?.textContent).toContain('My work');
    const page = fixture.componentInstance as unknown as { includeDone: { set(v: boolean): void } };
    page.includeDone.set(true);
    await settle(fixture);
    expect(api.list).toHaveBeenLastCalledWith('u1', { includeDone: true });
  });

  it('shows an empty state when nothing is assigned', async () => {
    const api = { list: vi.fn().mockResolvedValue({ ...page, items: [] }) };
    await TestBed.configureTestingModule({
      imports: [WorkPage],
      providers: [provideRouter([]), { provide: WorkApiService, useValue: api }],
    }).compileComponents();
    const fixture = TestBed.createComponent(WorkPage);
    fixture.componentRef.setInput('userId', 'u2');
    await settle(fixture);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Nothing to show');
  });

  it('loads every page before grouping, and personal links use the private alias', async () => {
    const privateItem = {
      ...page.items[0],
      id: 'private',
      projectKey: null,
      personal: true,
      projectId: 'private-project',
      projectName: 'Personal',
      key: '#4',
    };
    const { api, fixture, root } = await render('u1', [
      { ...page, nextCursor: 'next' },
      { ...page, items: [privateItem] },
    ]);
    expect(api.list).toHaveBeenNthCalledWith(2, 'u1', { includeDone: false, cursor: 'next' });
    expect(root.querySelectorAll('a.entry')).toHaveLength(2);
    expect(root.querySelector('a[href="/p/personal/items/4"]')).not.toBeNull();
    const actions = fixture.componentInstance as unknown as {
      setFilter(v: { source: 'PERSONAL' }): void;
    };
    actions.setFilter({ source: 'PERSONAL' });
    await settle(fixture);
    expect(root.querySelectorAll('a.entry')).toHaveLength(1);
    expect(root.textContent).toContain('Personal');
  });

  it('status edits use the card project, accept the server bucket, and Undo reverses both', async () => {
    const card = { ...page.items[0], canEdit: true };
    const { itemsApi, toast, fixture, root } = await render('u1', [{ ...page, items: [card] }]);
    const actions = fixture.componentInstance as unknown as {
      changeStatus(item: typeof card, status: 'BLOCKED'): Promise<void>;
    };
    itemsApi.update
      .mockResolvedValueOnce({
        status: 'BLOCKED',
        bucketId: 'mapped',
        can: { edit: true },
      })
      .mockResolvedValueOnce({
        status: 'IN_PROGRESS',
        bucketId: 'old-status-mapping',
        can: { edit: true },
      });
    itemsApi.move.mockResolvedValue({ status: 'IN_PROGRESS', bucketId: 'b1', can: { edit: true } });
    itemsApi.buckets.mockResolvedValue([{ id: 'mapped', name: 'Mapped bucket' }]);
    await actions.changeStatus(card, 'BLOCKED');
    await settle(fixture);
    expect(itemsApi.update).toHaveBeenCalledWith('p1', 'i1', { status: 'BLOCKED' });
    expect(root.textContent).toContain('Mapped bucket');
    const undo = toast.show.mock.calls[0]?.[1] as () => Promise<void>;
    await undo();
    expect(itemsApi.move).toHaveBeenCalledWith('p1', 'i1', { bucketId: 'b1', afterId: null });
    expect(itemsApi.update).toHaveBeenLastCalledWith('p1', 'i1', { status: 'IN_PROGRESS' });
    expect(itemsApi.update.mock.invocationCallOrder[1]).toBeLessThan(
      itemsApi.move.mock.invocationCallOrder[0],
    );
  });

  it('does not write read-only cards, and rolls back a refused edit', async () => {
    const card = page.items[0];
    const { itemsApi, toast, fixture, root } = await render('u1');
    const actions = fixture.componentInstance as unknown as {
      changeStatus(item: typeof card, status: 'BLOCKED'): Promise<void>;
    };
    await actions.changeStatus(card, 'BLOCKED');
    expect(itemsApi.update).not.toHaveBeenCalled();
    itemsApi.update.mockRejectedValue(new Error('Permission changed'));
    await actions.changeStatus({ ...card, canEdit: true }, 'BLOCKED');
    await settle(fixture);
    expect(root.textContent).toContain('In progress');
    expect(toast.error).toHaveBeenCalled();
  });

  it('keeps a successful status edit when its bucket metadata read fails', async () => {
    const card = { ...page.items[0], canEdit: true };
    const { itemsApi, toast, fixture, root } = await render('u1', [{ ...page, items: [card] }]);
    const actions = fixture.componentInstance as unknown as {
      changeStatus(item: typeof card, status: 'BLOCKED'): Promise<void>;
    };
    itemsApi.update.mockResolvedValue({
      status: 'BLOCKED',
      bucketId: 'mapped',
      can: { edit: true },
    });
    itemsApi.buckets.mockRejectedValue(
      new HttpErrorResponse({ status: 503, error: { message: 'Bucket read failed' } }),
    );
    await actions.changeStatus(card, 'BLOCKED');
    await settle(fixture);
    expect(root.textContent).toContain('Blocked');
    expect(root.textContent).toContain('Bucket details unavailable');
    expect(toast.show.mock.calls[0]?.[0]).toContain('Bucket read failed');
  });

  it('preserves a project cover-label style on work cards', async () => {
    const card = {
      ...page.items[0],
      labelStyle: 'COVER' as const,
      labels: [{ id: 'l1', name: 'Planning', colour: '#123456' }],
    };
    const { root } = await render('u1', [{ ...page, items: [card] }]);
    expect(root.querySelector('.card')?.classList.contains('cover')).toBe(true);
    expect(
      (root.querySelector('.card') as HTMLElement).style.getPropertyValue('--k-work-cover'),
    ).toBe('#123456');
  });
});
