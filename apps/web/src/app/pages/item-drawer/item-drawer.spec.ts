import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideRouter, Router } from '@angular/router';
import type { AuditEntryDto, ItemRefDto, ProjectDto, WorkItemDetailDto } from '@kloister/shared';
import { makeBucket, makeItem, makeMember, makeProject, settle } from '../../../testing/fixtures';
import { AnnotationsApiService } from '../../core/annotations-api.service';
import { ItemsApiService } from '../../core/items-api.service';
import { ProjectContext } from '../../core/project-context';
import { ProjectsApiService } from '../../core/projects-api.service';
import { SessionStore } from '../../core/session.store';
import { Dialogs } from '../../ui/dialogs';
import { ImageViewer } from '../../ui/image-viewer';
import { ToastService } from '../../ui/toast.service';
import { ItemDrawer } from './item-drawer';

/** The protected drawer members the tests drive directly. */
interface DrawerInternals {
  save(change: object): Promise<void>;
  remove(): Promise<void>;
  reorderCard(value: string): Promise<void>;
}

const epic: ItemRefDto = { id: 'i1', number: 1, key: 'KLO-1', type: 'EPIC', title: 'Hidden epic' };
const feature: ItemRefDto = {
  id: 'i2',
  number: 2,
  key: 'KLO-2',
  type: 'FEATURE',
  title: 'Visible feature',
};
const readOnly = { edit: false, move: false, delete: false, deleteCascade: false, annotate: false };

describe('ItemDrawer', () => {
  async function render(
    detail: WorkItemDetailDto,
    visible: WorkItemDetailDto[] = [],
    project: ProjectDto = makeProject(),
  ) {
    const activity: AuditEntryDto = {
      id: 'a1',
      actorId: 'u1',
      actorEmail: 'ann@example.org',
      action: 'ITEM_CREATED',
      entityType: 'WorkItem',
      entityId: detail.id,
      projectId: 'p1',
      meta: { type: detail.type },
      createdAt: '2026-10-13T08:00:00.000Z',
    };
    const projectsApi = {
      get: vi.fn().mockResolvedValue(project),
      members: vi.fn().mockResolvedValue({
        items: [makeMember('u1', 'Ann'), makeMember('u2', 'Bob')],
        nextCursor: null,
      }),
      teams: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    };
    const itemsApi = {
      buckets: vi
        .fn()
        .mockResolvedValue([makeBucket('b1', 'To Do', 1), makeBucket('b2', 'Done', 2)]),
      labels: vi.fn().mockResolvedValue([]),
      sprints: vi.fn().mockResolvedValue([]),
      listAll: vi.fn().mockResolvedValue([...visible, detail]),
      get: vi.fn().mockResolvedValue(detail),
      children: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      activity: vi.fn().mockResolvedValue({ items: [activity], nextCursor: null }),
      update: vi.fn(),
      move: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const dialogs = { confirm: vi.fn().mockResolvedValue(true) };
    const annotationsApi = {
      notes: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      attachments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      addImage: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [ItemDrawer],
      providers: [
        provideRouter([]),
        ProjectContext,
        { provide: ProjectsApiService, useValue: projectsApi },
        { provide: ItemsApiService, useValue: itemsApi },
        { provide: AnnotationsApiService, useValue: annotationsApi },
        { provide: Dialogs, useValue: dialogs },
      ],
    }).compileComponents();
    const toast = TestBed.inject(ToastService);
    const show = vi.spyOn(toast, 'show').mockImplementation(() => undefined);
    const showError = vi.spyOn(toast, 'error').mockImplementation(() => undefined);
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
    const ctx = TestBed.inject(ProjectContext);
    await ctx.open('KLO');
    await ctx.refresh();
    const fixture = TestBed.createComponent(ItemDrawer);
    fixture.componentRef.setInput('number', String(detail.number));
    await settle(fixture);
    const drawer = fixture.componentInstance as unknown as DrawerInternals;
    return {
      fixture,
      root: fixture.nativeElement as HTMLElement,
      ctx,
      itemsApi,
      drawer,
      show,
      showError,
      dialogs,
    };
  }

  it('shows hidden ancestors as plain titles and visible ones as links', async () => {
    const parent = makeItem(2, { type: 'FEATURE', ancestors: [epic], parentId: 'i1' });
    const story = makeItem(3, { type: 'STORY', parentId: 'i2', ancestors: [epic, feature] });
    const { root, itemsApi } = await render(story, [parent]);
    expect(itemsApi.get).toHaveBeenCalledWith('p1', '3');
    const crumbs = root.querySelector('nav.crumbs')!;
    expect(crumbs.querySelector('span')?.textContent).toContain('Hidden epic');
    expect(crumbs.querySelector('a')?.textContent).toContain('Visible feature');
  });

  it('shows plain values and no editors when the item may not be edited', async () => {
    const { root } = await render(
      makeItem(4, { title: 'Locked', can: readOnly, assigneeIds: ['u2'] }),
    );
    expect(root.querySelector('h1')?.textContent).toContain('Locked');
    // The heading's accessible name is the title itself, editable or not.
    expect(root.querySelector('h1 [aria-label]')).toBeNull();
    expect(root.querySelector('button.title-btn')).toBeNull();
    expect(root.querySelectorAll('mat-select').length).toBe(0);
    expect(root.querySelectorAll('input[type="date"]').length).toBe(0);
    expect(root.querySelector('dl.fields')?.textContent).toContain('Bob');
    expect(root.querySelector('[aria-label="More actions"]')).toBeNull();
    expect(root.querySelector('input[aria-label="New checklist line"]')).toBeNull();
    expect(root.querySelector('app-rich-text-editor')).toBeNull();
  });

  it('shows inline editors and the activity history when the item is editable', async () => {
    const { root, itemsApi } = await render(makeItem(4));
    expect(root.querySelector('button.title-btn')).not.toBeNull();
    for (const field of ['Status', 'Bucket', 'Assignees', 'Labels', 'Sprint', 'Priority']) {
      expect(root.querySelector(`mat-select[aria-label="${field}"]`)).not.toBeNull();
    }
    expect(root.querySelector('app-rich-text-editor')).not.toBeNull();
    expect(root.querySelector('[aria-label="More actions"]')).not.toBeNull();
    expect(itemsApi.activity).toHaveBeenCalledWith('p1', 'i4', undefined);
    expect(root.textContent).toContain('Ann created this Task');
  });

  it('edits the title in place', async () => {
    const item = makeItem(4, { title: 'Old title' });
    const { root, itemsApi, fixture } = await render(item);
    itemsApi.update.mockResolvedValue({ ...item, title: 'New title' });
    root.querySelector<HTMLButtonElement>('button.title-btn')?.click();
    await settle(fixture);
    const input = root.querySelector<HTMLInputElement>('input[aria-label="Title"]')!;
    input.value = 'New title';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle(fixture);
    expect(itemsApi.update).toHaveBeenCalledWith('p1', 'i4', { title: 'New title' });
    expect(root.querySelector('h1')?.textContent).toContain('New title');
  });

  it('offers a non-drag card order control and undoes with its previous neighbour', async () => {
    const item = makeItem(4, { position: 2 });
    const before = makeItem(5, { position: 1 });
    const { drawer, itemsApi, show, root } = await render(item, [before]);
    itemsApi.move.mockResolvedValue({ ...item, position: 0 });
    expect(root.querySelector('mat-select[aria-label="Position in bucket"]')).not.toBeNull();
    await drawer.reorderCard('none');
    expect(itemsApi.move).toHaveBeenCalledWith('p1', 'i4', { bucketId: 'b1', afterId: null });
    await show.mock.calls[0]?.[1]?.();
    expect(itemsApi.move).toHaveBeenLastCalledWith('p1', 'i4', { bucketId: 'b1', afterId: 'i5' });
  });

  it('does not replace another item when a card-order Undo finishes', async () => {
    const original = makeItem(4);
    const other = makeItem(5, { title: 'Another item' });
    const { drawer, itemsApi, fixture, show, root } = await render(original, [other]);
    itemsApi.move
      .mockResolvedValueOnce({ ...original, position: 0 })
      .mockResolvedValueOnce(original);
    await drawer.reorderCard('none');
    itemsApi.get.mockResolvedValue(other);
    fixture.componentRef.setInput('number', '5');
    await settle(fixture);
    await show.mock.calls[0]?.[1]?.();
    await settle(fixture);
    expect(itemsApi.move).toHaveBeenLastCalledWith('p1', 'i4', { bucketId: 'b1', afterId: null });
    expect(root.querySelector('h1')?.textContent).toContain('Another item');
  });

  it('shows the bucket the server chose after a status change', async () => {
    const item = makeItem(4);
    const { drawer, itemsApi, ctx, fixture } = await render(item);
    itemsApi.update.mockResolvedValue({ ...item, status: 'DONE', bucketId: 'b2' });
    await drawer.save({ status: 'DONE' });
    await settle(fixture);
    expect(itemsApi.update).toHaveBeenCalledWith('p1', 'i4', { status: 'DONE' });
    expect(ctx.itemsById().get('i4')).toMatchObject({ status: 'DONE', bucketId: 'b2' });
    // The history reloads after the change.
    expect(itemsApi.activity).toHaveBeenCalledTimes(2);
  });

  it('offers Undo, which moves the card back and restores the status', async () => {
    const item = makeItem(4);
    const { drawer, itemsApi, ctx, show } = await render(item);
    const changed = { ...item, status: 'DONE' as const, bucketId: 'b2' };
    itemsApi.update.mockResolvedValueOnce(changed);
    await drawer.save({ status: 'DONE' });
    expect(show).toHaveBeenCalledWith('Status saved', expect.any(Function));

    Object.assign(itemsApi, { move: vi.fn().mockResolvedValue({ ...changed, bucketId: 'b1' }) });
    itemsApi.update.mockResolvedValueOnce(item);
    await show.mock.calls[0]?.[1]?.();
    expect((itemsApi as unknown as { move: unknown }).move).toHaveBeenCalledWith('p1', 'i4', {
      bucketId: 'b1',
      afterId: null,
    });
    expect(itemsApi.update).toHaveBeenLastCalledWith('p1', 'i4', { status: 'NOT_STARTED' });
    expect(ctx.itemsById().get('i4')).toMatchObject({ status: 'NOT_STARTED', bucketId: 'b1' });
  });

  it('shows a refused change as an error toast and keeps the stored value', async () => {
    const item = makeItem(4);
    const { drawer, itemsApi, showError, root, fixture } = await render(item);
    itemsApi.update.mockRejectedValue(new Error('Refused'));
    await drawer.save({ priority: 1 });
    await settle(fixture);
    expect(showError).toHaveBeenCalled();
    expect(root.querySelector('mat-select[aria-label="Priority"]')?.textContent).toContain('High');
  });

  it('deletes items with children as a cascade and forgets the subtree', async () => {
    const parent = makeItem(4, { type: 'STORY', childCount: 1 });
    const child = makeItem(5, {
      parentId: 'i4',
      ancestors: [{ id: 'i4', number: 4, key: 'KLO-4', type: 'STORY', title: 'Item 4' }],
    });
    const { itemsApi, ctx, drawer, dialogs } = await render(parent, [child]);
    await drawer.remove();
    expect(dialogs.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Delete KLO-4 and everything under it?', danger: true }),
    );
    expect(itemsApi.remove).toHaveBeenCalledWith('p1', 'i4', true);
    expect(ctx.items()).toEqual([]);
  });

  it('deletes nothing when the confirmation is cancelled', async () => {
    const { itemsApi, drawer, dialogs } = await render(makeItem(4));
    dialogs.confirm.mockResolvedValue(false);
    await drawer.remove();
    expect(itemsApi.remove).not.toHaveBeenCalled();
  });

  it('hides delete when the item has children and the caller cannot cascade', async () => {
    const parent = makeItem(4, {
      childCount: 2,
      can: { edit: true, move: true, delete: true, deleteCascade: false, annotate: true },
    });
    const { root } = await render(parent);
    expect(root.querySelector('[aria-label="More actions"]')).toBeNull();
  });

  it('lets callers without ASSIGN_OTHERS change only their own assignment', async () => {
    const project = makeProject({
      myRole: 'MEMBER',
      myPermissions: ['VIEW_ITEMS', 'CREATE_ITEMS', 'EDIT_OWN_ITEMS', 'MOVE_OWN_ITEMS'],
    });
    const { root, fixture } = await render(makeItem(4), [], project);
    root.querySelector<HTMLElement>('mat-select[multiple] .mat-mdc-select-trigger')?.click();
    await settle(fixture);
    const options = [...document.querySelectorAll('mat-option')];
    const state = (name: string) =>
      options.find((o) => o.textContent?.includes(name))?.getAttribute('aria-disabled');
    expect(state('Ann')).toBe('false');
    expect(state('Bob')).toBe('true');
  });

  it('offers notes and attachments to callers who may annotate but not edit', async () => {
    const annotateOnly = { ...readOnly, annotate: true };
    const { root } = await render(makeItem(4, { can: annotateOnly }));
    expect(root.querySelector('[contenteditable][aria-label="New note"]')).not.toBeNull();
    expect(root.querySelector('[contenteditable][aria-label="Description"]')).toBeNull();
    expect(root.querySelector('app-item-attachments')?.textContent).toContain('Attach files');
  });

  it('hides the note composer and attaching from callers who may not annotate', async () => {
    const { root } = await render(makeItem(4, { can: readOnly }));
    expect(root.querySelector('[aria-label="New note"]')).toBeNull();
    expect(root.querySelector('app-item-attachments')?.textContent).not.toContain('Attach files');
  });

  it('opens images of a read-only description in the full-size viewer', async () => {
    const src = 'api/v1/projects/p1/items/i4/images/a';
    const { root } = await render(
      makeItem(4, { can: readOnly, description: `<p>See</p><img src="${src}" alt="Shot">` }),
    );
    const open = vi.spyOn(TestBed.inject(ImageViewer), 'open').mockImplementation(() => undefined);
    const img = root.querySelector<HTMLImageElement>('.description img')!;
    expect(img.getAttribute('tabindex')).toBe('0');
    img.click();
    expect(open).toHaveBeenCalledWith([{ src, alt: 'Shot' }], 0);
  });

  it('leaves Esc to an open dialog and closes on Esc otherwise', async () => {
    const { fixture, root } = await render(makeItem(4));
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const dialog = TestBed.inject(MatDialog);
    const openDialogs = vi.spyOn(dialog, 'openDialogs', 'get');
    const esc = () =>
      root
        .querySelector('.d-panel')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    openDialogs.mockReturnValue([{} as never]);
    esc();
    expect(navigate).not.toHaveBeenCalled();
    openDialogs.mockReturnValue([]);
    esc();
    await settle(fixture);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('is read-only on archived projects whatever the item allows', async () => {
    const project = makeProject({ archivedAt: '2026-10-01T00:00:00.000Z' });
    const { root } = await render(makeItem(4), [], project);
    expect(root.querySelector('app-rich-text-editor')).toBeNull();
    expect(root.querySelector('[aria-label="More actions"]')).toBeNull();
    expect(root.querySelectorAll('mat-select').length).toBe(0);
  });
});
