import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { makeBucket, makeSprint, settle } from '../../../testing/fixtures';
import { NewItemDialog, type NewItemData } from './new-item-dialog';

/** The dialog's protected state, reached in tests. */
interface DialogInternals {
  title: string;
  type: string;
  parentId: string | null;
  sprintId: string | null;
  startDate: string | null;
  dueDate: string | null;
  parentOptions(): { id: string }[];
  typeChanged(): void;
  valid(): boolean;
  submit(): void;
}

describe('NewItemDialog (M9.2)', () => {
  async function render() {
    const close = vi.fn();
    const data: NewItemData = {
      buckets: [makeBucket('b1', 'To Do', 1)],
      parents: [
        { id: 'e1', key: 'KLO-1', title: 'Launch', type: 'EPIC' },
        { id: 's1', key: 'KLO-3', title: 'Pages', type: 'STORY' },
      ],
      sprints: [makeSprint('sp1', 'Sprint 1', 'ACTIVE')],
    };
    await TestBed.configureTestingModule({
      imports: [NewItemDialog],
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(NewItemDialog);
    await settle(fixture);
    return {
      close,
      root: fixture.nativeElement as HTMLElement,
      dialog: fixture.componentInstance as unknown as DialogInternals,
    };
  }

  it('offers parent, sprint and dates so Members can plan an item when creating it', async () => {
    const { root, dialog, close } = await render();
    expect(root.querySelector('mat-select[name="sprint"]')).not.toBeNull();
    expect(root.querySelectorAll('app-date-field').length).toBe(2);
    // A Task may sit under the Story, not the Epic.
    expect(dialog.parentOptions().map((p) => p.id)).toEqual(['s1']);
    dialog.title = 'Write FAQ';
    dialog.parentId = 's1';
    dialog.sprintId = 'sp1';
    dialog.startDate = '2026-11-09';
    dialog.dueDate = '2026-11-06';
    expect(dialog.valid()).toBe(false);
    dialog.dueDate = '2026-11-10';
    dialog.submit();
    expect(close).toHaveBeenCalledWith({
      type: 'TASK',
      title: 'Write FAQ',
      bucketId: 'b1',
      parentId: 's1',
      sprintId: 'sp1',
      startDate: '2026-11-09',
      dueDate: '2026-11-10',
    });
  });

  it('drops a parent the new type may not sit under and leaves empty fields out', async () => {
    const { dialog, close } = await render();
    dialog.parentId = 's1';
    dialog.type = 'FEATURE';
    dialog.typeChanged();
    expect(dialog.parentId).toBeNull();
    dialog.title = 'Checkout';
    dialog.submit();
    expect(close).toHaveBeenCalledWith({ type: 'FEATURE', title: 'Checkout', bucketId: 'b1' });
  });
});
