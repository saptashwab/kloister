import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { UserWorkDto } from '@kloister/shared';
import { settle } from '../../../testing/fixtures';
import { SessionStore } from '../../core/session.store';
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

  async function render(userId: string) {
    const api = { list: vi.fn().mockResolvedValue(page) };
    await TestBed.configureTestingModule({
      imports: [WorkPage],
      providers: [provideRouter([]), { provide: WorkApiService, useValue: api }],
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
    return { api, fixture, root: fixture.nativeElement as HTMLElement };
  }

  it("lists a person's items with links into their projects", async () => {
    const { api, root } = await render('u2');
    expect(api.list).toHaveBeenCalledWith('u2', { includeDone: false });
    expect(root.querySelector('h1')?.textContent).toContain('Bo Chen');
    expect(root.textContent).toContain('bo@example.org');
    const link = root.querySelector('a.entry');
    expect(link?.getAttribute('href')).toBe('/p/KLO/items/4');
    expect(link?.textContent).toContain('Invoice form');
    expect(link?.textContent).toContain('Kanban');
    expect(link?.textContent).toContain('days overdue');
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
});
