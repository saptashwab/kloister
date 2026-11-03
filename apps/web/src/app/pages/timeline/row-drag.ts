import { signal } from '@angular/core';
import type { ItemType } from '@kloister/shared';
import {
  dropTarget,
  type DraggedRow,
  type DropTarget,
  type TimelineRow,
} from '../../core/timeline-logic';

/** Pointer travel, in px, before a press on the grip becomes a drag. */
const DRAG_THRESHOLD = 4;
/** Sideways travel, in px, that picks one level deeper or shallower. */
const LEVEL_PX = 16;
/** Distance, in px, from the top or bottom edge where the plan scrolls. */
const EDGE_PX = 32;
/** Height of the plan's sticky header row, in px. */
export const HEADER_PX = 48;
/** Widest the card under the pointer gets, in px. */
const CARD_MAX = 420;
/** Fastest scroll while dragging near an edge, in px per frame. */
const MAX_SCROLL = 18;

/**
 * The element that scrolls the page around the plan: the nearest ancestor
 * that scrolls vertically, or the document.
 *
 * @param el The plan's scroller.
 * @returns The scrolling ancestor.
 */
function scrollParent(el: HTMLElement): Element {
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight)
      return node;
  }
  return document.scrollingElement ?? document.documentElement;
}

/** The card that follows the pointer while rows are dragged. */
export interface RowDragCard {
  /** Type of the first dragged item. */
  type: ItemType;
  /** Its key. */
  key: string;
  /** Its title. */
  title: string;
  /** "+3 rows" or "+2 items", or empty. */
  more: string;
}

/** What the page shows while rows are dragged (v1.3.2). */
export interface RowDragView {
  /** Indexes of the dragged rows, their own rows included; they are hidden. */
  hidden: ReadonlySet<number>;
  /** Rows each row is shifted by to open the gap, by row index. */
  shift: readonly number[];
  /** The gap, as a row slot from the top. */
  gap: number;
  /** The level the rows would take. */
  depth: number;
  /** Whether they can land there. */
  valid: boolean;
  /** Where they land ("Under KLO-3 · becomes User Story") or why they cannot. */
  label: string;
  /** Sideways scroll of the plan, where the pinned table starts. */
  left: number;
  /** Left edge of the card, in viewport px. */
  x: number;
  /** Top edge of the card, in viewport px. */
  y: number;
  /** Width of the card. */
  width: number;
  /** The card's content. */
  card: RowDragCard;
}

/** What the timeline gives the row drag. */
export interface RowDragHost {
  /** Rows in display order. */
  rows(): readonly TimelineRow[];
  /** Row height in px. */
  rowHeight(): number;
  /**
   * The rows a drag from this row moves: the selection when the row is
   * selected, otherwise the row alone; in display order, none inside another.
   */
  draggedFrom(index: number): number[];
  /** Types of an item's children. */
  childTypes(id: string): ItemType[];
  /** Describes a possible drop for its label. */
  label(target: DropTarget): string;
  /** The scrolling plan. */
  scroller(): HTMLElement | undefined;
  /**
   * Called when the drag begins; returns what to call when it ends, with
   * whether changes from others that waited should be shown (not on a drop,
   * which reloads the project anyway).
   */
  begin(rows: DraggedRow[]): (apply: boolean) => void;
  /**
   * Places the rows where they were dropped and ends the drag with `release`:
   * without replaying others' waiting changes when the project reloads, with
   * them when nothing moved.
   */
  drop(target: DropTarget, release: (apply: boolean) => void): Promise<void>;
}

/**
 * Drags timeline rows by their grip (v1.3.1; reworked in v1.3.2 to feel like
 * the board's cards): a card follows the pointer, the other rows slide apart
 * to open a gap where the rows would land, indented to the level the pointer's
 * sideways travel picks and labelled with the new parent and type. Near the
 * top or bottom edge the plan scrolls; Escape cancels.
 */
export class RowDrag {
  /** The drag's state while it runs, or null. */
  readonly view = signal<RowDragView | null>(null);
  /** Ends the running drag without placing anything, or null. */
  private stop: (() => void) | null = null;

  /**
   * Creates the drag for a timeline.
   *
   * @param host The timeline.
   */
  constructor(private readonly host: RowDragHost) {}

  /** Cancels a running drag, e.g. when the timeline closes. */
  cancel(): void {
    this.stop?.();
  }

  /**
   * Starts watching a press on a row's grip; it becomes a drag once the
   * pointer travels a few pixels.
   *
   * @param event The pointer event.
   * @param index Row index.
   */
  start(event: PointerEvent, index: number): void {
    if (event.button !== 0 || this.stop !== null) return;
    const rows = this.host.rows();
    if (!rows[index]?.node.item) return;
    event.preventDefault();
    const handle = event.target as HTMLElement;
    const grid = handle.closest<HTMLElement>('[role="grid"]');
    const cells = handle.closest<HTMLElement>('.cells')?.getBoundingClientRect();
    if (grid === null || cells === undefined) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const grabX = startX - cells.left;
    const grabY = startY - cells.top;
    const width = Math.min(cells.width, CARD_MAX);
    let x = startX;
    let y = startY;
    let begun = false;
    let frame = 0;
    let target: DropTarget | null = null;
    let end: ((apply: boolean) => void) | null = null;
    let hidden = new Set<number>();
    let rest: TimelineRow[] = [];
    let restPos: number[] = [];
    let dragged: DraggedRow[] = [];
    let card: RowDragCard | null = null;
    const base = rows[index].depth;

    const begin = () => {
      const tops = this.host.draggedFrom(index);
      if (tops.length === 0) return false;
      // Each dragged row takes its own rows along.
      hidden = new Set<number>();
      for (const top of tops) {
        hidden.add(top);
        for (let i = top + 1; i < rows.length && rows[i].depth > rows[top].depth; i++)
          hidden.add(i);
      }
      restPos = [];
      rest = [];
      rows.forEach((row, i) => {
        restPos.push(rest.length);
        if (!hidden.has(i)) rest.push(row);
      });
      dragged = tops.map((i) => {
        const item = rows[i].node.item!;
        return { item, childTypes: this.host.childTypes(item.id) };
      });
      const first = dragged[0].item;
      card = {
        type: first.type,
        key: first.key,
        title: first.title,
        more:
          tops.length > 1
            ? `+${tops.length - 1} ${tops.length === 2 ? 'item' : 'items'}`
            : hidden.size > 1
              ? `+${hidden.size - 1} ${hidden.size === 2 ? 'row' : 'rows'}`
              : '',
      };
      end = this.host.begin(dragged);
      return true;
    };

    // Recomputes the gap, the level and the shifted rows from the pointer.
    const update = () => {
      if (card === null) return;
      const h = this.host.rowHeight();
      const gap = Math.max(
        0,
        Math.min(rest.length, Math.floor((y - grid.getBoundingClientRect().top) / h)),
      );
      const wanted = base + Math.round((x - startX) / LEVEL_PX);
      target = dropTarget(rest, gap, wanted, dragged);
      const shift = rows.map((_, i) => {
        if (hidden.has(i)) return 0;
        const p = restPos[i];
        return p + (p >= gap ? 1 : 0) - i;
      });
      this.view.set({
        hidden,
        shift,
        gap,
        depth: target.depth,
        valid: target.moves !== null,
        label: this.host.label(target),
        left: this.host.scroller()?.scrollLeft ?? 0,
        x: x - grabX,
        y: y - grabY,
        width,
        card,
      });
    };

    // Scrolls while the pointer rests near the top or bottom edge of the
    // visible plan: the page first while the plan runs past the window,
    // then the plan itself.
    const scroll = () => {
      frame = requestAnimationFrame(scroll);
      const el = this.host.scroller();
      if (el === undefined) return;
      const box = el.getBoundingClientRect();
      // Below the sticky header row.
      const upper = Math.max(box.top + HEADER_PX, 0) + EDGE_PX;
      const lower = Math.min(box.bottom, window.innerHeight) - EDGE_PX;
      const speed =
        y < upper
          ? -Math.min(MAX_SCROLL, (upper - y) / 2 + 1)
          : y > lower
            ? Math.min(MAX_SCROLL, (y - lower) / 2 + 1)
            : 0;
      if (speed === 0) return;
      const pastWindow = speed > 0 ? box.bottom > window.innerHeight : box.top + HEADER_PX < 0;
      const target = pastWindow ? scrollParent(el) : el;
      const before = target.scrollTop;
      target.scrollTop += speed;
      if (target.scrollTop !== before) update();
    };

    const move = (e: PointerEvent) => {
      x = e.clientX;
      y = e.clientY;
      if (!begun) {
        if (Math.hypot(x - startX, y - startY) < DRAG_THRESHOLD) return;
        if (!begin()) {
          finish(false);
          return;
        }
        begun = true;
        frame = requestAnimationFrame(scroll);
      }
      update();
    };
    const finish = (place: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      cancelAnimationFrame(frame);
      this.stop = null;
      this.view.set(null);
      const drop = place && begun ? target : null;
      // Others' waiting changes are dropped when the drop reloads anyway.
      if (drop?.moves) void this.host.drop(drop, (apply) => end?.(apply));
      else end?.(true);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    // Escape cancels; caught first so the grid and drawer do not see it.
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };
    // On the window, so a re-render that removes the grip cannot strand the drag.
    this.stop = cancel;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
  }
}
