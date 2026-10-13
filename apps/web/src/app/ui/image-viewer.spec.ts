import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialog } from '@angular/material/dialog';
import { settle } from '../../testing/fixtures';
import { ImageViewer, ImageViewerDialog } from './image-viewer';

const IMAGES = [
  { src: 'api/v1/projects/p/items/i/images/a', alt: 'First' },
  { src: 'api/v1/projects/p/items/i/images/b', alt: 'Second' },
];

describe('ImageViewerDialog', () => {
  async function render(index: number, images = IMAGES) {
    await TestBed.configureTestingModule({
      imports: [ImageViewerDialog],
      providers: [{ provide: MAT_DIALOG_DATA, useValue: { images, index } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(ImageViewerDialog);
    await settle(fixture);
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  it('shows the image named by its alternative text', async () => {
    const { root } = await render(1);
    expect(root.querySelector('img')?.getAttribute('src')).toBe(IMAGES[1]?.src);
    expect(root.querySelector('h2')?.textContent).toContain('Second');
    expect(root.textContent).toContain('2 of 2');
  });

  it('steps through the images with the arrow keys, wrapping around', async () => {
    const { root, fixture } = await render(1);
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    await settle(fixture);
    expect(root.querySelector('img')?.getAttribute('alt')).toBe('First');
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    await settle(fixture);
    expect(root.querySelector('img')?.getAttribute('alt')).toBe('Second');
  });

  it('has no step buttons for a single image', async () => {
    const { root } = await render(0, [IMAGES[0]]);
    expect(root.querySelector('[aria-label="Next image"]')).toBeNull();
  });
});

describe('ImageViewer', () => {
  it('opens at the clicked image of a rendered text', () => {
    const open = vi.fn();
    TestBed.configureTestingModule({ providers: [{ provide: MatDialog, useValue: { open } }] });
    const viewer = TestBed.inject(ImageViewer);
    const div = document.createElement('div');
    div.innerHTML = `<img src="${IMAGES[0]?.src}" alt="First"><p>x</p><img src="${IMAGES[1]?.src}" alt="Second">`;
    const second = div.querySelectorAll('img')[1];
    const event = { target: second, preventDefault: vi.fn() } as unknown as Event;
    expect(viewer.openFrom(event, div)).toBe(true);
    expect(open).toHaveBeenCalledWith(
      ImageViewerDialog,
      expect.objectContaining({ data: { images: IMAGES, index: 1 }, panelClass: 'k-image-viewer' }),
    );
    expect(viewer.openFrom({ target: div.querySelector('p') } as unknown as Event, div)).toBe(
      false,
    );
  });
});
