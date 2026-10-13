import type { CdkDragDrop } from '@angular/cdk/drag-drop';
import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import type { ChecklistItemDto } from '@kloister/shared';
import { settle } from '../../../testing/fixtures';
import { ItemsApiService } from '../../core/items-api.service';
import { ItemChecklist } from './item-checklist';

/** The protected checklist members the tests drive directly. */
interface ChecklistInternals {
  lines(): ChecklistItemDto[];
  reorder(event: CdkDragDrop<unknown>): Promise<void>;
}

const line = (id: string, done = false): ChecklistItemDto => ({
  id,
  text: `Line ${id}`,
  done,
  position: 0,
});

describe('ItemChecklist', () => {
  async function render(canEdit: boolean) {
    const api = {
      moveChecklistLine: vi.fn(),
      updateChecklistLine: vi.fn(),
      addChecklistLine: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [ItemChecklist],
      providers: [{ provide: ItemsApiService, useValue: api }],
    }).compileComponents();
    const fixture = TestBed.createComponent(ItemChecklist);
    fixture.componentRef.setInput('projectId', 'p1');
    fixture.componentRef.setInput('itemId', 'i1');
    fixture.componentRef.setInput('items', [line('a', true), line('b'), line('c')]);
    fixture.componentRef.setInput('canEdit', canEdit);
    await settle(fixture);
    const checklist = fixture.componentInstance as unknown as ChecklistInternals;
    return { root: fixture.nativeElement as HTMLElement, api, checklist, fixture };
  }

  it('shows progress and no controls when read-only', async () => {
    const { root } = await render(false);
    expect(root.querySelector('h4')?.textContent).toContain('Checklist 1/3');
    expect(root.textContent).not.toContain('Delete');
    expect(root.querySelector('input.text, input.quick-add')).toBeNull();
  });

  it('reorders with the line it now follows', async () => {
    const { api, checklist } = await render(true);
    api.moveChecklistLine.mockResolvedValue(line('c'));
    await checklist.reorder({ previousIndex: 2, currentIndex: 1 } as CdkDragDrop<unknown>);
    expect(api.moveChecklistLine).toHaveBeenCalledWith('p1', 'i1', 'c', 'a');
    expect(checklist.lines().map((l) => l.id)).toEqual(['a', 'c', 'b']);
  });

  it('puts the lines back when the API refuses a reorder', async () => {
    const { api, checklist, root, fixture } = await render(true);
    api.moveChecklistLine.mockRejectedValue(
      new HttpErrorResponse({ status: 403, error: { code: 'FORBIDDEN', message: 'No' } }),
    );
    await checklist.reorder({ previousIndex: 0, currentIndex: 2 } as CdkDragDrop<unknown>);
    expect(api.moveChecklistLine).toHaveBeenCalledWith('p1', 'i1', 'a', 'c');
    expect(checklist.lines().map((l) => l.id)).toEqual(['a', 'b', 'c']);
    await settle(fixture);
    expect(root.querySelector('[role=alert]')?.textContent).toContain('No');
  });

  it('adds lines from the input', async () => {
    const { api, root, fixture } = await render(true);
    api.addChecklistLine.mockResolvedValue(line('d'));
    const input = root.querySelector<HTMLInputElement>('input[aria-label="New checklist line"]')!;
    input.value = 'Line d';
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }));
    await settle(fixture);
    expect(api.addChecklistLine).toHaveBeenCalledWith('p1', 'i1', { text: 'Line d' });
    expect(root.querySelector('h4')?.textContent).toContain('Checklist 1/4');
  });
});
