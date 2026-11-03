import { ChangeDetectionStrategy, Component, ViewEncapsulation } from '@angular/core';

/**
 * The timeline grid's styles, loaded with the timeline route (SPEC §6.4).
 * Global selectors scoped under `app-timeline` keep each stylesheet within
 * the component style budget.
 */
@Component({
  selector: 'app-timeline-grid-styles',
  template: '',
  styleUrl: '../../../styles/_timeline-grid.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimelineGridStyles {}

/**
 * The timeline bars' styles, loaded with the timeline route (SPEC §6.4).
 */
@Component({
  selector: 'app-timeline-bar-styles',
  template: '',
  styleUrl: '../../../styles/_timeline-bars.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimelineBarStyles {}

/**
 * The timeline toolbar, selection bar and plan strip styles, loaded with the
 * timeline route (SPEC §6.4).
 */
@Component({
  selector: 'app-timeline-tool-styles',
  template: '',
  styleUrl: '../../../styles/_timeline-tools.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimelineToolStyles {}

/**
 * The timeline row grip, row dragging and typing row styles, loaded with the
 * timeline route (SPEC §6.4, v1.3.2).
 */
@Component({
  selector: 'app-timeline-drag-styles',
  template: '',
  styleUrl: '../../../styles/_timeline-drag.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimelineDragStyles {}
