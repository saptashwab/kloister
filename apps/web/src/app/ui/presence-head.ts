import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import type { PresenceEntryDto } from '@kloister/shared';
import { headPeople, personName, presenceDoing } from '../core/live-logic';
import { ProjectContext } from '../core/project-context';
import { Avatar } from './avatar';
import { Icon } from './icon';

/**
 * Avatars of the other people on the project, in the project header
 * (M10, DESIGN §9.1): at most four, then "+3". Each avatar's hover card says
 * what the person is doing ("Ann is editing the due date of KLO-42 · Fix
 * login", or "Viewing the timeline") and, while they have an item open,
 * offers "Go to KLO-42". Clicking an avatar opens its card, like every
 * other avatar.
 */
@Component({
  selector: 'app-presence-head',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Avatar, Icon],
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
    }
    .people {
      display: inline-flex;
      align-items: center;
    }
    .people > * + * {
      margin-inline-start: calc(var(--k-space-1) * -1);
    }
    .doing {
      color: var(--k-text-2);
      font-size: var(--k-body-sm);
      overflow-wrap: anywhere;
    }
    .more {
      margin-inline-start: var(--k-space-1);
      color: var(--k-muted);
      font-size: var(--k-body-sm);
    }
  `,
  template: `
    @if (people().length > 0) {
      <span class="people" role="group" [attr.aria-label]="label()">
        @for (p of shown(); track p.userId) {
          <app-avatar
            #avatar
            [userId]="p.userId"
            [name]="name(p.userId)"
            [email]="email(p.userId)"
            [size]="24"
          >
            <span class="doing">{{ doing(p) }}</span>
            @if (target(p); as key) {
              <button
                cardAction
                type="button"
                class="k-action"
                (click)="goTo.emit(p); avatar.closeNow()"
              >
                <app-icon name="arrowRight" />Go to {{ key }}
              </button>
            }
          </app-avatar>
        }
        @if (more() > 0) {
          <span class="more" [title]="moreNames()">+{{ more() }}</span>
        }
      </span>
    }
  `,
})
export class PresenceHead {
  /** Everyone else on the project. */
  readonly people = input.required<readonly PresenceEntryDto[]>();
  /** "Go to" was chosen for a person's item. */
  readonly goTo = output<PresenceEntryDto>();

  private readonly ctx = inject(ProjectContext);

  /** Who shows, and how many more. */
  private readonly head = computed(() => headPeople(this.people().map((p) => p.userId)));
  /** The people with an avatar. */
  protected readonly shown = computed(() => {
    const ids = new Set(this.head().shown);
    return this.people().filter((p) => ids.has(p.userId));
  });
  /** How many more there are. */
  protected readonly more = computed(() => this.head().more);
  /** Names of the people without an avatar, for the "+3" tooltip. */
  protected readonly moreNames = computed(() =>
    this.people()
      .slice(this.shown().length)
      .map((p) => this.name(p.userId))
      .join(', '),
  );
  /** The group's accessible name. */
  protected readonly label = computed(() => {
    const names = this.people().map((p) => this.name(p.userId));
    return `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} here too`;
  });

  /**
   * A person's name.
   *
   * @param userId The person.
   * @returns The name.
   */
  protected name(userId: string): string {
    return personName(this.ctx.membersById(), userId);
  }

  /**
   * A person's email, for the hover card.
   *
   * @param userId The person.
   * @returns The email, or empty.
   */
  protected email(userId: string): string {
    return this.ctx.membersById().get(userId)?.email ?? '';
  }

  /**
   * What a person is doing.
   *
   * @param entry Their presence.
   * @returns The hover card line.
   */
  protected doing(entry: PresenceEntryDto): string {
    const item = entry.itemId === null ? undefined : this.ctx.itemsById().get(entry.itemId);
    return presenceDoing(entry, this.name(entry.userId), item ?? null);
  }

  /**
   * The key of the item "Go to" opens.
   *
   * @param entry Their presence.
   * @returns E.g. "KLO-42", or null when they have no item open the viewer has.
   */
  protected target(entry: PresenceEntryDto): string | null {
    if (entry.itemId === null) return null;
    return this.ctx.itemsById().get(entry.itemId)?.key ?? null;
  }
}
