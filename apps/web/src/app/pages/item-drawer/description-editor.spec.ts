import { TestBed } from '@angular/core/testing';
import { settle } from '../../../testing/fixtures';
import { DescriptionEditor } from './description-editor';

/** The protected editor members the tests drive directly. */
interface EditorInternals {
  link(event: Event): void;
  submit(): void;
}

describe('DescriptionEditor', () => {
  async function render() {
    await TestBed.configureTestingModule({ imports: [DescriptionEditor] }).compileComponents();
    const fixture = TestBed.createComponent(DescriptionEditor);
    fixture.componentRef.setInput('html', '<p>Hello <script>alert(1)</script></p>');
    await settle(fixture);
    const editor = fixture.componentInstance as unknown as EditorInternals;
    return { fixture, root: fixture.nativeElement as HTMLElement, editor };
  }

  it('shows the stored description without scripts', async () => {
    const { root } = await render();
    const area = root.querySelector('[contenteditable]')!;
    expect(area.textContent).toContain('Hello');
    expect(area.querySelector('script')).toBeNull();
  });

  it('only creates http(s) and mailto links', async () => {
    const { editor } = await render();
    // jsdom has no execCommand; provide one to observe calls.
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    const ask = vi.spyOn(window, 'prompt');
    const event = new MouseEvent('mousedown');
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'ftp://host']) {
      ask.mockReturnValueOnce(url);
      editor.link(event);
    }
    expect(exec).not.toHaveBeenCalled();
    ask.mockReturnValueOnce('https://example.org');
    editor.link(event);
    expect(exec).toHaveBeenCalledWith('createLink', false, 'https://example.org');
    ask.mockRestore();
  });

  it('emits the edited HTML on save', async () => {
    const { root, editor, fixture } = await render();
    const saved: string[] = [];
    fixture.componentInstance.save.subscribe((html) => saved.push(html));
    const area = root.querySelector<HTMLElement>('[contenteditable]')!;
    area.innerHTML = '<p>Changed</p>';
    editor.submit();
    expect(saved).toEqual(['<p>Changed</p>']);
  });
});
