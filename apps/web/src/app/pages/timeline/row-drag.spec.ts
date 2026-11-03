import { makeItem as item } from '../../../testing/fixtures';
import { buildTree } from '../../core/board-logic';
import { type DropTarget, timelineRows } from '../../core/timeline-logic';
import { RowDrag, type RowDragHost } from './row-drag';

const epic = item(1, { type: 'EPIC', bucketId: null });
const ref = { id: 'i1', number: 1, key: 'KLO-1', type: 'EPIC' as const, title: 'Item 1' };
const a = item(2, { type: 'FEATURE', parentId: 'i1', ancestors: [ref] });
const b = item(3, { type: 'FEATURE', parentId: 'i1', ancestors: [ref] });
const rows = timelineRows(buildTree([epic, a, b]), new Set());

/** A pointer event; the test DOM has none, and the drag reads only these fields. */
function pointer(type: string, clientX: number, clientY: number): PointerEvent {
  return new MouseEvent(type, { clientX, clientY, button: 0, bubbles: true }) as PointerEvent;
}

describe('RowDrag (v1.3.2)', () => {
  let grid: HTMLElement;
  let handle: HTMLElement;
  let host: RowDragHost & { end: ReturnType<typeof vi.fn<(apply: boolean) => void>> };
  let drop: ReturnType<
    typeof vi.fn<(target: DropTarget, release: (apply: boolean) => void) => Promise<void>>
  >;

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    grid = document.createElement('div');
    grid.setAttribute('role', 'grid');
    const cells = document.createElement('div');
    cells.className = 'cells';
    handle = document.createElement('span');
    cells.append(handle);
    grid.append(cells);
    document.body.append(grid);
    const end = vi.fn<(apply: boolean) => void>();
    // The timeline ends the drag's holds itself once it has placed the rows.
    drop = vi.fn((_target: DropTarget, release: (apply: boolean) => void) => {
      release(false);
      return Promise.resolve();
    });
    host = {
      end,
      rows: () => rows,
      rowHeight: () => 30,
      draggedFrom: (index) => [index],
      childTypes: () => [],
      label: (target) => target.reason || 'ok',
      scroller: () => undefined,
      begin: () => end,
      drop: (target, release) => drop(target, release),
    };
  });

  afterEach(() => {
    grid.remove();
    vi.unstubAllGlobals();
  });

  /** Presses on the grip of row 2 (b), at y 75 in a grid starting at 0. */
  function press(drag: RowDrag) {
    const down = pointer('pointerdown', 10, 75);
    Object.defineProperty(down, 'target', { value: handle });
    drag.start(down, 2);
  }

  it('waits for a few pixels before dragging, so a click does nothing', () => {
    const drag = new RowDrag(host);
    press(drag);
    window.dispatchEvent(pointer('pointermove', 11, 76));
    expect(drag.view()).toBeNull();
    window.dispatchEvent(pointer('pointerup', 11, 76));
    expect(drop).not.toHaveBeenCalled();
    expect(host.end).not.toHaveBeenCalled();
  });

  it('opens a gap under the pointer and drops the row there', () => {
    const drag = new RowDrag(host);
    press(drag);
    // Up to the slot after the Epic: b becomes its first child.
    window.dispatchEvent(pointer('pointermove', 10, 40));
    const view = drag.view()!;
    expect(view.gap).toBe(1);
    expect(view.hidden.has(2)).toBe(true);
    // a slides down one row to open the gap; the Epic stays.
    expect(view.shift).toEqual([0, 1, 0]);
    expect(view.valid).toBe(true);
    window.dispatchEvent(pointer('pointerup', 10, 40));
    expect(drag.view()).toBeNull();
    // Waiting changes from others are not replayed: the drop reloads.
    expect(host.end).toHaveBeenCalledWith(false);
    expect(drop).toHaveBeenCalledWith(
      expect.objectContaining({ moves: [{ item: b, move: { afterId: null } }] }),
      expect.any(Function),
    );
  });

  it('cancels with Escape or when the page closes, and stops listening', () => {
    const drag = new RowDrag(host);
    press(drag);
    window.dispatchEvent(pointer('pointermove', 10, 40));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(drag.view()).toBeNull();
    expect(host.end).toHaveBeenCalledWith(true);
    window.dispatchEvent(pointer('pointermove', 10, 20));
    window.dispatchEvent(pointer('pointerup', 10, 20));
    expect(drag.view()).toBeNull();
    expect(drop).not.toHaveBeenCalled();

    press(drag);
    window.dispatchEvent(pointer('pointermove', 10, 40));
    drag.cancel();
    expect(drag.view()).toBeNull();
    window.dispatchEvent(pointer('pointerup', 10, 40));
    expect(drop).not.toHaveBeenCalled();
  });
});
