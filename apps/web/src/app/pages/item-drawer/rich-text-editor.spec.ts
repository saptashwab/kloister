import { TestBed } from '@angular/core/testing';
import type { InlineImageDto } from '@kloister/shared';
import { settle } from '../../../testing/fixtures';
import { Dialogs } from '../../ui/dialogs';
import { ImageViewer } from '../../ui/image-viewer';
import { ToastService } from '../../ui/toast.service';
import { RichTextEditor } from './rich-text-editor';

/** The protected editor members the tests drive directly. */
interface EditorInternals {
  link(): Promise<void>;
  submit(): void;
  paste(event: unknown): void;
  trackMention(): void;
  keydown(event: KeyboardEvent): void;
}

const PREFIX = 'api/v1/projects/p1/items/i1/images/';

const IMAGE: InlineImageDto = {
  id: 'img1',
  url: 'api/v1/projects/p1/items/i1/images/img1',
  name: 'shot.png',
  mimeType: 'image/png',
  sizeBytes: 10,
};

describe('RichTextEditor', () => {
  const prompt = vi.fn<(...args: unknown[]) => Promise<string | null>>();
  const openFrom = vi.fn().mockReturnValue(true);

  async function render(inputs: Record<string, unknown> = {}) {
    await TestBed.configureTestingModule({
      imports: [RichTextEditor],
      providers: [
        { provide: Dialogs, useValue: { prompt } },
        { provide: ImageViewer, useValue: { openFrom, openAt: vi.fn() } },
      ],
    }).compileComponents();
    const toastError = vi
      .spyOn(TestBed.inject(ToastService), 'error')
      .mockImplementation(() => undefined);
    const fixture = TestBed.createComponent(RichTextEditor);
    fixture.componentRef.setInput('html', '<p>Hello <script>alert(1)</script></p>');
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    await settle(fixture);
    const editor = fixture.componentInstance as unknown as EditorInternals;
    const root = fixture.nativeElement as HTMLElement;
    const area = root.querySelector<HTMLElement>('[contenteditable]')!;
    const saved: string[] = [];
    fixture.componentInstance.save.subscribe((html: string) => saved.push(html));
    return { fixture, root, area, editor, saved, toastError };
  }

  /**
   * Puts the caret at the end of the area's last text node.
   *
   * @param area The editing area.
   */
  function caretAtEnd(area: HTMLElement): void {
    const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    while (walker.nextNode()) last = walker.currentNode as Text;
    const range = document.createRange();
    range.setStart(last!, last!.length);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  it('shows the stored text without scripts', async () => {
    const { area } = await render();
    expect(area.textContent).toContain('Hello');
    expect(area.querySelector('script')).toBeNull();
  });

  it('keeps mentions whole and with their user id when editing stored text', async () => {
    const { area } = await render({ html: '<p>Hi <span data-mention="u2">@Bob</span></p>' });
    const mention = area.querySelector('span.k-mention');
    expect(mention?.getAttribute('data-mention')).toBe('u2');
    expect(mention?.getAttribute('contenteditable')).toBe('false');
  });

  it('only creates http(s) and mailto links', async () => {
    const { editor } = await render();
    // jsdom has no execCommand; provide one to observe calls.
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'ftp://host']) {
      prompt.mockResolvedValueOnce(url);
      await editor.link();
    }
    prompt.mockResolvedValueOnce(null);
    await editor.link();
    expect(exec).not.toHaveBeenCalled();
    prompt.mockResolvedValueOnce('https://example.org');
    await editor.link();
    expect(exec).toHaveBeenCalledWith('createLink', false, 'https://example.org');
  });

  it('emits the edited HTML on save', async () => {
    const { area, editor, saved } = await render();
    area.innerHTML = '<p>Changed</p>';
    editor.submit();
    expect(saved).toEqual(['<p>Changed</p>']);
  });

  it('uploads a pasted image and inserts it with the URL the API returned', async () => {
    const upload = vi.fn().mockResolvedValue(IMAGE);
    const { area, editor, fixture } = await render({ uploadImage: { prefix: PREFIX, upload } });
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    const preventDefault = vi.fn();
    editor.paste({ clipboardData: { files: [file], getData: () => '' }, preventDefault });
    await settle(fixture);
    expect(preventDefault).toHaveBeenCalled();
    expect(upload).toHaveBeenCalledWith(file);
    const img = area.querySelector('img');
    expect(img?.getAttribute('src')).toBe(IMAGE.url);
    expect(img?.getAttribute('alt')).toBe('shot.png');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('View images (1)');
  });

  it('refuses files that are not PNG, JPEG, GIF or WebP without uploading them', async () => {
    const upload = vi.fn().mockResolvedValue(IMAGE);
    const { area, editor, toastError, fixture } = await render({
      uploadImage: { prefix: PREFIX, upload },
    });
    const svg = new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' });
    editor.paste({ clipboardData: { files: [svg], getData: () => '' }, preventDefault: vi.fn() });
    await settle(fixture);
    expect(upload).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
    expect(area.querySelector('img')).toBeNull();
  });

  it('offers people after @ and inserts the chosen one as a mention', async () => {
    const people = [
      { id: 'u2', name: 'Mia Member' },
      { id: 'u3', name: 'Pat Manager' },
    ];
    const { area, editor, fixture, root } = await render({ html: '', mentionables: people });
    area.textContent = 'Thanks @Mi';
    caretAtEnd(area);
    editor.trackMention();
    await settle(fixture);
    const options = [...root.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim());
    expect(options).toEqual(['Mia Member']);
    expect(area.getAttribute('aria-expanded')).toBe('true');
    editor.keydown(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle(fixture);
    const mention = area.querySelector('span[data-mention="u2"]');
    expect(mention?.textContent).toBe('@Mia Member');
    expect(area.textContent).not.toContain('@Mi @');
    expect(root.querySelector('[role="listbox"]')).toBeNull();
  });

  it('as a composer, ignores empty notes and clears after posting', async () => {
    const { area, editor, saved } = await render({ html: '', clearOnSave: true });
    editor.submit();
    expect(saved).toEqual([]);
    area.innerHTML = '<p>A note</p>';
    editor.submit();
    expect(saved).toEqual(['<p>A note</p>']);
    expect(area.innerHTML).toBe('');
  });

  it('opens the full-size viewer when an image is clicked', async () => {
    const { area } = await render({ html: `<img src="${IMAGE.url}" alt="Shot">` });
    area.querySelector('img')?.click();
    expect(openFrom).toHaveBeenCalled();
  });
});
