import { TestBed } from '@angular/core/testing';
import type { AttachmentDto } from '@kloister/shared';
import { settle } from '../../../testing/fixtures';
import { AnnotationsApiService } from '../../core/annotations-api.service';
import { Dialogs } from '../../ui/dialogs';
import { ToastService } from '../../ui/toast.service';
import { ItemAttachments } from './item-attachments';

/** The protected members the tests drive directly. */
interface Internals {
  remove(attachment: AttachmentDto): Promise<void>;
  drop(event: unknown): Promise<void>;
}

/**
 * Builds an attachment as the API returns it.
 *
 * @param id Attachment id.
 * @param name File name.
 * @param canDelete Whether the caller may delete it.
 * @returns The attachment.
 */
function file(id: string, name: string, canDelete = true): AttachmentDto {
  return {
    id,
    name,
    sizeBytes: 2048,
    mimeType: 'application/pdf',
    uploaderId: 'u1',
    uploaderName: 'Ann',
    createdAt: '2026-10-13T08:00:00.000Z',
    url: `api/v1/projects/p1/items/i4/attachments/${id}`,
    can: { edit: false, delete: canDelete },
  };
}

describe('ItemAttachments', () => {
  async function render(canAdd: boolean, rows: AttachmentDto[] = [file('a1', 'plan.pdf')]) {
    const api = {
      attachments: vi.fn().mockResolvedValue({ items: rows, nextCursor: null }),
      attach: vi.fn(),
      removeAttachment: vi.fn().mockResolvedValue(undefined),
    };
    const dialogs = { confirm: vi.fn().mockResolvedValue(true) };
    await TestBed.configureTestingModule({
      imports: [ItemAttachments],
      providers: [
        { provide: AnnotationsApiService, useValue: api },
        { provide: Dialogs, useValue: dialogs },
      ],
    }).compileComponents();
    const toast = TestBed.inject(ToastService);
    const show = vi.spyOn(toast, 'show').mockImplementation(() => undefined);
    const error = vi.spyOn(toast, 'error').mockImplementation(() => undefined);
    const fixture = TestBed.createComponent(ItemAttachments);
    fixture.componentRef.setInput('projectId', 'p1');
    fixture.componentRef.setInput('itemId', 'i4');
    fixture.componentRef.setInput('canAdd', canAdd);
    await settle(fixture);
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    const root = fixture.nativeElement as HTMLElement;
    return {
      api,
      dialogs,
      show,
      error,
      fixture,
      root,
      changed,
      self: fixture.componentInstance as unknown as Internals,
    };
  }

  it('lists attachments as download links with size and uploader', async () => {
    const { root } = await render(false);
    const link = root.querySelector<HTMLAnchorElement>('a.file-name')!;
    expect(link.textContent).toBe('plan.pdf');
    expect(link.getAttribute('href')).toBe('api/v1/projects/p1/items/i4/attachments/a1');
    expect(link.hasAttribute('download')).toBe(true);
    expect(root.textContent).toContain('2.0 KB · Ann');
    expect(root.textContent).not.toContain('Attach files');
  });

  it('uploads dropped files, one refusal not stopping the others', async () => {
    const { api, self, root, fixture, show, error, changed } = await render(true, []);
    api.attach
      .mockRejectedValueOnce(new Error('Too large'))
      .mockResolvedValueOnce(file('a2', 'notes.txt'));
    const files = [new File(['x'], 'huge.bin'), new File(['y'], 'notes.txt')];
    await self.drop({ dataTransfer: { files }, preventDefault: vi.fn() });
    await settle(fixture);
    expect(api.attach).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith('notes.txt attached');
    expect(root.querySelector('a.file-name')?.textContent).toBe('notes.txt');
    expect(changed).toHaveBeenCalled();
  });

  it('ignores drops when the caller may not add files', async () => {
    const { api, self } = await render(false);
    await self.drop({ dataTransfer: { files: [new File(['x'], 'a')] }, preventDefault: vi.fn() });
    expect(api.attach).not.toHaveBeenCalled();
  });

  it('deletes after confirmation and only offers delete where allowed', async () => {
    const rows = [file('a1', 'plan.pdf'), file('a2', 'theirs.pdf', false)];
    const { api, self, root, fixture, dialogs } = await render(true, rows);
    expect(root.querySelector('[aria-label="Delete attachment plan.pdf"]')).not.toBeNull();
    expect(root.querySelector('[aria-label="Delete attachment theirs.pdf"]')).toBeNull();
    await self.remove(rows[0]);
    await settle(fixture);
    expect(dialogs.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Delete plan.pdf?', danger: true }),
    );
    expect(api.removeAttachment).toHaveBeenCalledWith('p1', 'i4', 'a1');
    expect(root.textContent).not.toContain('plan.pdf');
  });
});
