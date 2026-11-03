import {
  ChangeDetectionStrategy,
  Component,
  computed,
  Directive,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import type { PresenceEntryDto } from '@kloister/shared';
import { presenceVars } from '../core/colour';
import { isStrong, personName, presenceSentence, tagName } from '../core/live-logic';
import { ProjectContext } from '../core/project-context';

/** How long a new name tag shows the name before it shrinks to a bar, in ms. */
export const TAG_FULL_MS = 3_000;

/**
 * Marks a field, cell, card or row someone else is on (DESIGN §9.1), in
 * their person colour: a strong outline while they edit, move or write a
 * note, a faint edge while they only view. The look is in `_live.scss`;
 * a name tag inside the element is an {@link PresenceTag}.
 */
@Directive({
  selector: '[appPresenceMark]',
  host: {
    '[class.k-pm]': 'entry() !== null',
    '[class.k-pm-strong]': 'strong()',
    '[class.k-pm-faint]': 'entry() !== null && !strong()',
    '[style]': 'vars()',
  },
})
export class PresenceMark {
  /** The person whose mark shows (see `leadPresence`), or none. */
  readonly appPresenceMark = input<PresenceEntryDto | null | undefined>(null);

  /** The entry, or null. */
  protected readonly entry = computed(() => this.appPresenceMark() ?? null);
  /** Strong (editing, moving, writing a note) or faint (viewing). */
  protected readonly strong = computed(() => isStrong(this.entry()?.action ?? null));
  /** The person colour's properties. */
  protected readonly vars = computed(() => {
    const entry = this.entry();
    return entry === null ? null : presenceVars(entry.userId);
  });
}

/**
 * A small name tag on the corner of a marked element, like a cursor flag
 * in shared documents (DESIGN §9.1). It shows the first name, then shrinks
 * to a coloured bar after {@link TAG_FULL_MS}; hovering it or the element,
 * or focus in the element, shows the name again. The full sentence ("Ann is
 * editing the due date") is its tooltip and accessible name.
 */
@Component({
  selector: 'app-presence-tag',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'k-pm-tag',
    role: 'img',
    '[class.short]': 'short()',
    '[class.inside]': "place() === 'inside'",
    '[style]': 'vars()',
    '[attr.aria-label]': 'sentence()',
    '[attr.title]': 'sentence()',
  },
  template: `<span class="k-pm-name" aria-hidden="true">{{ name() }}</span>`,
})
export class PresenceTag {
  /** The person and what they do. */
  readonly entry = input.required<PresenceEntryDto>();
  /** Word for a moved thing: "this card", "this bar". */
  readonly what = input('this item');
  /**
   * `outside`: above the element's top edge (drawer fields, board cards);
   * `inside`: within its top corner, for elements that clip (grid cells).
   */
  readonly place = input<'outside' | 'inside'>('outside');

  private readonly ctx = inject(ProjectContext, { optional: true });

  /** The person's full name. */
  private readonly fullName = computed(() =>
    personName(this.ctx?.membersById() ?? new Map(), this.entry().userId),
  );
  /** The first name, shown on the tag. */
  protected readonly name = computed(() => tagName(this.fullName()));
  /** "Ann is editing the due date". */
  protected readonly sentence = computed(() =>
    presenceSentence(this.entry(), this.fullName(), this.what()),
  );
  /** The person colour's properties. */
  protected readonly vars = computed(() => presenceVars(this.entry().userId));
  /** True once the tag shrank to a bar. */
  protected readonly short = signal(false);

  /** Who does what; a change shows the name again. */
  private readonly key = computed(() => {
    const e = this.entry();
    return `${e.userId}|${e.action}|${e.field}`;
  });

  /** Shows the name, then shrinks the tag, again whenever who or what changes. */
  constructor() {
    effect((onCleanup) => {
      this.key();
      this.short.set(false);
      const timer = setTimeout(() => this.short.set(true), TAG_FULL_MS);
      onCleanup(() => clearTimeout(timer));
    });
  }
}
