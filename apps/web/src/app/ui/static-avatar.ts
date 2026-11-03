import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { avatarColours, initials } from '../core/colour';

/**
 * A non-interactive avatar, for places that only show who someone is (the
 * signed-in user in the sidebar, activity entries).
 */
@Component({
  selector: 'app-avatar-static',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: inline-flex' },
  template: `<span class="k-avatar" role="img" [attr.aria-label]="name()" [style]="vars()">{{
    letters()
  }}</span>`,
})
export class StaticAvatar {
  /** User id (decides the colour). */
  readonly userId = input.required<string>();
  /** Display name. */
  readonly name = input.required<string>();
  /** Size in px. */
  readonly size = input(24);

  /** Initials. */
  protected readonly letters = computed(() => initials(this.name()));
  /** Colour and size variables. */
  protected readonly vars = computed(() => {
    const c = avatarColours(this.userId());
    return { '--a-bg': c.bg, '--a-fg': c.fg, '--a-size': `${this.size()}px` };
  });
}
