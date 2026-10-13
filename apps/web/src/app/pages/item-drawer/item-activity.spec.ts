import { TestBed } from '@angular/core/testing';
import type { AuditEntryDto, NoteDto } from '@kloister/shared';
import { settle } from '../../../testing/fixtures';
import { AnnotationsApiService } from '../../core/annotations-api.service';
import { ItemsApiService } from '../../core/items-api.service';
import { ProjectContext } from '../../core/project-context';
import { ToastService } from '../../ui/toast.service';
import { ItemActivity } from './item-activity';

/** The protected members the tests drive directly. */
interface Internals {
  filter: { set(value: 'all' | 'notes' | 'history'): void };
  post(html: string): Promise<void>;
}

/**
 * Builds a history entry.
 *
 * @param id Entry id.
 * @param action Audit action.
 * @param at ISO timestamp.
 * @returns The entry.
 */
function entry(id: string, action: string, at: string): AuditEntryDto {
  return {
    id,
    actorId: null,
    actorEmail: 'ann@example.org',
    action,
    entityType: 'WorkItem',
    entityId: 'i4',
    projectId: 'p1',
    meta: { type: 'TASK' },
    createdAt: at,
  };
}

const NOTE: NoteDto = {
  id: 'n1',
  authorId: 'u1',
  authorName: 'Ann',
  body: '<p>Looks good <span data-mention="u2">@Bob</span></p>',
  editedAt: null,
  createdAt: '2026-10-13T09:00:00.000Z',
  can: { edit: true, delete: true },
};

describe('ItemActivity', () => {
  async function render(canAnnotate: boolean) {
    const annotations = {
      notes: vi.fn().mockResolvedValue({ items: [NOTE], nextCursor: null }),
      addNote: vi.fn().mockResolvedValue(NOTE),
    };
    const items = {
      activity: vi.fn().mockResolvedValue({
        items: [
          entry('h2', 'NOTE_ADDED', '2026-10-13T09:00:00.000Z'),
          entry('h1', 'ITEM_CREATED', '2026-10-13T08:00:00.000Z'),
        ],
        nextCursor: null,
      }),
    };
    await TestBed.configureTestingModule({
      imports: [ItemActivity],
      providers: [
        ProjectContext,
        { provide: AnnotationsApiService, useValue: annotations },
        { provide: ItemsApiService, useValue: items },
      ],
    }).compileComponents();
    const show = vi.spyOn(TestBed.inject(ToastService), 'show').mockImplementation(() => undefined);
    const fixture = TestBed.createComponent(ItemActivity);
    fixture.componentRef.setInput('projectId', 'p1');
    fixture.componentRef.setInput('itemId', 'i4');
    fixture.componentRef.setInput('canAnnotate', canAnnotate);
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    const self = fixture.componentInstance as unknown as Internals;
    const texts = () =>
      [...root.querySelectorAll('.timeline > li')].map((li) => li.textContent ?? '');
    return { annotations, items, fixture, root, self, texts, show };
  }

  it('merges notes and history newest first, leaving out "added a note"', async () => {
    const { texts, root } = await render(true);
    const rows = texts();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Looks good');
    expect(rows[1]).toContain('created this Task');
    expect(root.querySelector('.note-body .k-mention')?.textContent).toBe('@Bob');
  });

  it('filters to notes or to the full history', async () => {
    const { texts, self, fixture } = await render(true);
    self.filter.set('notes');
    await settle(fixture);
    expect(texts()).toHaveLength(1);
    self.filter.set('history');
    await settle(fixture);
    expect(texts().map((t) => t.includes('added a note') || t.includes('created'))).toEqual([
      true,
      true,
    ]);
  });

  it('shows the composer only to callers who may annotate', async () => {
    const yes = await render(true);
    expect(yes.root.querySelector('[aria-label="New note"]')).not.toBeNull();
    TestBed.resetTestingModule();
    const no = await render(false);
    expect(no.root.querySelector('[aria-label="New note"]')).toBeNull();
  });

  it('posts a note and reloads the timeline', async () => {
    const { annotations, items, self, show } = await render(true);
    await self.post('<p>New</p>');
    expect(annotations.addNote).toHaveBeenCalledWith('p1', 'i4', { body: '<p>New</p>' });
    expect(show).toHaveBeenCalledWith('Note added');
    expect(annotations.notes).toHaveBeenCalledTimes(2);
    expect(items.activity).toHaveBeenCalledTimes(2);
  });
});
