import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AuditEntryDto, ItemRefDto, ProjectDto, WorkItemDetailDto } from '@kloister/shared';
import { makeBucket, makeItem, makeMember, makeProject, settle } from '../../../testing/fixtures';
import { ItemsApiService } from '../../core/items-api.service';
import { ProjectContext } from '../../core/project-context';
import { ProjectsApiService } from '../../core/projects-api.service';
import { SessionStore } from '../../core/session.store';
import { ItemDrawer } from './item-drawer';

/** The protected drawer members the tests drive directly. */
interface DrawerInternals {
  save(change: object): Promise<void>;
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
      remove: vi.fn().mockResolvedValue(undefined),
    };
    await TestBed.configureTestingModule({
      imports: [ItemDrawer],
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
    const ctx = TestBed.inject(ProjectContext);
    await ctx.open('KLO');
    await ctx.refresh();
    const fixture = TestBed.createComponent(ItemDrawer);
    fixture.componentRef.setInput('number', String(detail.number));
    await settle(fixture);
    const drawer = fixture.componentInstance as unknown as DrawerInternals;
    return { fixture, root: fixture.nativeElement as HTMLElement, ctx, itemsApi, drawer };
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

  it('disables every control when the item may not be edited', async () => {
    const { root } = await render(makeItem(4, { title: 'Locked', can: readOnly }));
    expect(root.querySelector('h3')?.textContent).toContain('Locked');
    const selects = [...root.querySelectorAll('mat-select')];
    expect(selects.length).toBeGreaterThan(0);
    expect(selects.every((s) => s.getAttribute('aria-disabled') === 'true')).toBe(true);
    expect(root.textContent).not.toContain('Delete item');
    expect(root.textContent).not.toContain('Add a checklist line');
    expect(root.querySelector('app-description-editor')).toBeNull();
  });

  it('shows editing controls and the activity history when the item is editable', async () => {
    const { root, itemsApi } = await render(makeItem(4));
    expect(root.querySelector('input[maxlength]')).not.toBeNull();
    expect(root.querySelector('app-description-editor')).not.toBeNull();
    expect(root.textContent).toContain('Delete item');
    expect(itemsApi.activity).toHaveBeenCalledWith('p1', 'i4', undefined);
    expect(root.textContent).toContain('Ann created this Task');
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

  it('deletes items with children as a cascade and forgets the subtree', async () => {
    const parent = makeItem(4, { type: 'STORY', childCount: 1 });
    const child = makeItem(5, {
      parentId: 'i4',
      ancestors: [{ id: 'i4', number: 4, key: 'KLO-4', type: 'STORY', title: 'Item 4' }],
    });
    const { root, itemsApi, ctx, fixture } = await render(parent, [child]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const button = [...root.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Delete item'),
    );
    button?.click();
    await settle(fixture);
    expect(itemsApi.remove).toHaveBeenCalledWith('p1', 'i4', true);
    expect(ctx.items()).toEqual([]);
  });

  it('hides delete when the item has children and the caller cannot cascade', async () => {
    const parent = makeItem(4, {
      childCount: 2,
      can: { edit: true, move: true, delete: true, deleteCascade: false, annotate: true },
    });
    const { root } = await render(parent);
    expect(root.textContent).not.toContain('Delete item');
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

  it('is read-only on archived projects whatever the item allows', async () => {
    const project = makeProject({ archivedAt: '2026-10-01T00:00:00.000Z' });
    const { root } = await render(makeItem(4), [], project);
    expect(root.querySelector('app-description-editor')).toBeNull();
    expect(root.textContent).not.toContain('Delete item');
    const selects = [...root.querySelectorAll('mat-select')];
    expect(selects.every((s) => s.getAttribute('aria-disabled') === 'true')).toBe(true);
  });
});
