import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import type { PresenceEntryDto, ProjectMemberDto } from '@kloister/shared';
import { headPeople, personName, presenceLine } from '../core/live-logic';
import { LiveService } from '../core/live.service';
import { StaticAvatar } from './avatar';

/**
 * Global live update styles (highlight, others' outlines), loaded with the
 * project pages instead of the first page.
 */
@Component({
  selector: 'app-live-styles',
  template: '',
  styleUrl: '../../styles/_live.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LiveStyles {}

/**
 * The live updates connection chip (M10 plan section 4.4): nothing while
 * connected, "Reconnecting…" after a few seconds without the stream and
 * "Offline. Changes show when you are back." after a minute. Screen readers
 * hear it politely only when it goes offline and when it is back.
 */
@Component({
  selector: 'app-live-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: contents;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: var(--k-space-2);
      padding: var(--k-space-1) var(--k-space-3);
      border-radius: var(--k-radius-full);
      background: var(--k-warn-soft);
      color: var(--k-warn-ink);
      font-size: var(--k-body-sm);
      white-space: nowrap;
    }
    .dot {
      width: var(--k-size-6px);
      height: var(--k-size-6px);
      border-radius: 50%;
      background: currentColor;
    }
    .sr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
  `,
  template: `
    @if (text(); as t) {
      <span class="chip" [title]="t"><span class="dot" aria-hidden="true"></span>{{ t }}</span>
    }
    <span class="sr" aria-live="polite">{{ announcement() }}</span>
  `,
})
export class LiveStatusChip {
  private readonly live = inject(LiveService);

  /** The chip text, or null while connected or switched off. */
  protected readonly text = computed(() => {
    switch (this.live.status()) {
      case 'reconnecting':
        return 'Reconnecting…';
      case 'offline':
        return 'Offline. Changes show when you are back.';
      default:
        return null;
    }
  });

  /** What screen readers hear: only going offline and coming back. */
  protected readonly announcement = signal('');

  /** Announces offline and back. */
  constructor() {
    let wasOffline = false;
    effect(() => {
      const status = this.live.status();
      if (status === 'offline' && !wasOffline) {
        wasOffline = true;
        this.announcement.set('Offline. Changes show when you are back.');
      } else if (status === 'live' && wasOffline) {
        wasOffline = false;
        this.announcement.set('Back online. Changes show again.');
      }
    });
  }
}

/**
 * Avatars of other people on an item (M10 plan section 4.5), with what they
 * do in the tooltip and for screen readers. At most four, then "+3". The
 * project header uses `PresenceHead`, whose avatars have hover cards.
 */
@Component({
  selector: 'app-presence',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StaticAvatar],
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
    }
    /* Beside a drawer field's label. */
    :host(.field-presence) {
      margin-inline-start: var(--k-space-2);
      vertical-align: middle;
    }
    .people {
      display: inline-flex;
      align-items: center;
    }
    .people > * + * {
      margin-inline-start: calc(var(--k-space-1) * -1);
    }
    .more {
      margin-inline-start: var(--k-space-1);
      color: var(--k-muted);
      font-size: var(--k-body-sm);
    }
  `,
  template: `
    @if (people().length > 0) {
      <span class="people" role="img" [attr.aria-label]="line()" [title]="line()">
        @for (id of head().shown; track id) {
          <app-avatar-static [userId]="id" [name]="name(id)" [size]="size()" aria-hidden="true" />
        }
        @if (head().more > 0) {
          <span class="more" aria-hidden="true">+{{ head().more }}</span>
        }
      </span>
    }
  `,
})
export class PresenceAvatars {
  /** The people. */
  readonly people = input.required<readonly PresenceEntryDto[]>();
  /** Project members by user id. */
  readonly members = input.required<ReadonlyMap<string, ProjectMemberDto>>();
  /** Word for a moved thing: "this card", "this bar". */
  readonly what = input('this item');
  /** Avatar size. */
  readonly size = input(20);

  /** Who shows, and how many more. */
  protected readonly head = computed(() => headPeople(this.people().map((p) => p.userId)));

  /** The tooltip. */
  protected readonly line = computed(() =>
    presenceLine(this.people(), this.members(), this.what()),
  );

  /**
   * A person's name.
   *
   * @param id User id.
   * @returns The name.
   */
  protected name(id: string): string {
    return personName(this.members(), id);
  }
}
