import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { settle } from '../../../testing/fixtures';
import { HELP_ARTICLES } from './help-content';
import { HelpPage } from './help';
import { TourLauncher } from './tour';

describe('HelpPage', () => {
  async function render() {
    await TestBed.configureTestingModule({
      imports: [HelpPage],
      providers: [provideRouter([]), { provide: TourLauncher, useValue: { open: vi.fn() } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(HelpPage);
    await settle(fixture);
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  it('shows the self-contained ADO guide with steps and lazy screenshots', async () => {
    const { root } = await render();
    const ado = root.querySelector('article#ado');
    expect(ado?.querySelectorAll('h3').length).toBeGreaterThan(8);
    expect(ado?.textContent).toContain('Two ways to start');
    expect(ado?.textContent).toContain('Starting in ADO');
    const images = [...(ado?.querySelectorAll('img') ?? [])];
    expect(images.length).toBeGreaterThan(4);
    for (const image of images) {
      expect(image.getAttribute('loading')).toBe('lazy');
      expect(image.getAttribute('alt')).toBeTruthy();
      // Served by the app relative to its base path, never from another host.
      expect(image.getAttribute('src')).toMatch(/^help\/ado\/[\w-]+\.png$/);
    }
    // The guide never sends readers outside the app.
    expect(ado?.textContent).not.toMatch(/docs folder|\.md\b|github/i);
  });

  it('searches section headings and steps', async () => {
    const { fixture, root } = await render();
    const input = root.querySelector('input[type="search"]') as HTMLInputElement;
    input.value = 'spike';
    input.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect([...root.querySelectorAll('article')].map((a) => a.id)).toEqual(['ado']);
  });

  it('lists every screenshot the guide uses', () => {
    const images = HELP_ARTICLES.flatMap((a) => a.sections ?? []).flatMap((s) =>
      s.image ? [s.image.src] : [],
    );
    expect(new Set(images).size).toBe(images.length);
  });
});
