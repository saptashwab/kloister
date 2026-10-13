import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * The bundled icon set (DESIGN §5): 24-unit stroke paths, drawn with
 * `currentColor`. Compiled into the app, so nothing is fetched from another
 * host and no icon font is needed. Add new icons here.
 */
export const ICONS = {
  board: 'M4 4h6v16H4zM14 4h6v10h-6z',
  backlog: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  sprints: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4',
  settings:
    'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1',
  home: 'M3 11l9-7 9 7v9H3z',
  work: 'M4 6h16M4 12h10M4 18h7M16 16l3 3-3 3M13 19h6',
  folder: 'M3 6h6l2 2h10v11H3z',
  users:
    'M9 11a4 4 0 1 0 0-8a4 4 0 1 0 0 8M2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7M22 21v-1a6 6 0 0 0-4-5.6',
  audit: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM9 12l2 2 4-4',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M20 20l-4-4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'M6 6l12 12M18 6 6 18',
  link: 'M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  check: 'M5 12l5 5 9-10',
  calendar: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',
  checklist: 'M4 4h16v16H4zM8 12l3 3 5-6',
  filter: 'M4 5h16l-6 8v6l-4-2v-4z',
  key: 'M14 10a4 4 0 1 0-4-4M10 6 3 13v4h4v-2h2v-2h2l1.5-1.5',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
  menu: 'M4 6h16M4 12h16M4 18h16',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 8.5h.01',
  alert: 'M12 3l10 18H2zM12 10v4M12 17h.01',
  info: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 11v5M12 8h.01',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  /* Item types (DESIGN §3.1). */
  EPIC: 'M13 2 4 14h7l-1 8 9-12h-7l1-8z',
  FEATURE: 'M12 3 3 8l9 5 9-5-9-5zM3 13l9 5 9-5',
  STORY: 'M6 3h12v18l-6-4-6 4z',
  TASK: 'M4 4h16v16H4zM8 12l3 3 5-6',
  BUG: 'M9 9h6v6a3 3 0 0 1-6 0zM10 9V7a2 2 0 0 1 4 0v2M4 12h5M15 12h5M6 6l3 3M18 6l-3 3M6 19l3-3M18 19l-3-3',
  /* Statuses (DESIGN §3.2). */
  NOT_STARTED: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18',
  IN_PROGRESS: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7v5l3 2',
  BLOCKED: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M8 12h8',
  DONE: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M8 12l3 3 5-6',
} as const;

/** The name of a bundled icon. */
export type IconName = keyof typeof ICONS;

/**
 * One bundled SVG icon (DESIGN §5). Decorative by default
 * (`aria-hidden`); give it a `label` when the icon alone carries meaning,
 * which makes it `role="img"` with that name.
 */
@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    style: 'display: inline-flex; flex: none',
  },
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      [attr.stroke-width]="stroke()"
      stroke-linecap="round"
      stroke-linejoin="round"
      [attr.aria-hidden]="label() ? null : 'true'"
      [attr.role]="label() ? 'img' : null"
      [attr.aria-label]="label() || null"
      focusable="false"
    >
      <path [attr.d]="path()" />
    </svg>
  `,
})
export class Icon {
  /** Which icon. */
  readonly name = input.required<IconName>();
  /** Size in px. */
  readonly size = input(16);
  /** Stroke width in grid units. */
  readonly stroke = input(2);
  /** Accessible name; empty for decorative icons. */
  readonly label = input('');

  /** The path data. */
  protected readonly path = computed(() => ICONS[this.name()]);
}
