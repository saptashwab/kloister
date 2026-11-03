import { sharesOf } from '../../core/shares';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ItemStatus, LabelStyle, type WorkItemDto } from '@kloister/shared';
import { dueState, dueText } from '../../core/item-changes';
import { ProjectContext } from '../../core/project-context';
import { ItemCopyAction } from '../../ui/item-copy-action';
import { PresenceAvatars } from '../../ui/live-ui';
import { Avatar } from '../../ui/avatar';
import { Icon } from '../../ui/icon';
import { LabelPill } from '../../ui/label-pill';
import { PriorityIcon, TypeIcon } from '../../ui/signals';

/**
 * One board card (SPEC §6, DESIGN §8): cover bar (cover-bar label style),
 * type, key, "Blocked", priority, title, labels, due date, checklist
 * progress and assignee avatars with their hover cards. Live updates (M10)
 * highlight it briefly after someone else changed it ("Changed by Ann just
 * now" on hover) and show who else has it open.
 *
 * The title is the card's link to the item drawer, so keyboard users reach
 * it with Tab; the board opens the drawer on clicks elsewhere on the card.
 */
@Component({
  selector: 'app-item-card',
  imports: [
    ItemCopyAction,
    PresenceAvatars,
    RouterLink,
    Avatar,
    Icon,
    LabelPill,
    PriorityIcon,
    TypeIcon,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'card',
    '[class.done]': 'done()',
    '[class.k-live-flash]': 'flash()',
    '[attr.title]': 'changedBy()',
  },
  styles: `
    :host {
      content-visibility: auto;
      contain-intrinsic-size: auto var(--k-card-estimate);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: var(--k-line) solid var(--k-border);
      border-radius: var(--k-radius-md);
      background: var(--k-surface);
      box-shadow: var(--k-rest);
      cursor: pointer;
    }
    /* Projected into the avatar's hover card, under the email. */
    .share {
      color: var(--k-muted);
      font-size: var(--k-body-sm);
    }
    :host:focus-within,
    :host(.cdk-drag-preview) {
      content-visibility: visible;
    }
    :host(.done) .title {
      color: var(--k-muted);
    }
    .cover {
      height: var(--k-size-6px);
    }
    .body {
      display: flex;
      flex-direction: column;
      gap: var(--k-size-9px);
      padding: var(--k-space-3);
    }
    .meta,
    .foot {
      display: flex;
      align-items: center;
      gap: var(--k-space-2);
      min-height: var(--k-size-22px);
    }
    .title {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      font-weight: 500;
      line-height: 1.35;
      color: var(--k-text);
      text-decoration: none;
      overflow-wrap: anywhere;
    }
    .title:hover {
      text-decoration: underline;
    }
    .labels {
      display: flex;
      flex-wrap: wrap;
      gap: var(--k-size-5px);
    }
    .check {
      display: inline-flex;
      align-items: center;
      gap: var(--k-size-6px);
      font-size: var(--k-small);
      color: var(--k-muted);
    }
    .bar {
      width: var(--k-size-34px);
      height: var(--k-space-1);
      border-radius: var(--k-focus-width);
      overflow: hidden;
      background: var(--k-border);
    }
    .bar span {
      display: block;
      height: var(--k-space-1);
      background: var(--k-primary);
    }
    .bar span.full {
      background: var(--k-success);
    }
  `,
  template: `
    @let i = item();
    @if (cover(); as colour) {
      <div class="cover" [style.background]="colour" aria-hidden="true"></div>
    }
    <div class="body">
      <div class="meta">
        <app-type-icon [type]="i.type" />
        <span class="k-key">{{ i.key }}</span>
        @if (i.status === blocked) {
          <span class="k-pill warn">Blocked</span>
        }
        @if (i.adHoc) {
          <span class="k-pill" title="Not part of the plan">Ad hoc</span>
        }
        <span class="spacer"></span>
        @if (presence().length > 0) {
          <app-presence [people]="presence()" [members]="members()" what="this card" [size]="18" />
        }
        <app-priority-icon [priority]="i.priority" /><app-item-copy-action [item]="i" />
      </div>
      <a class="title" [routerLink]="['items', i.number]" queryParamsHandling="preserve">{{
        i.title
      }}</a>
      @if (labels().length > 0) {
        <div class="labels">
          @for (label of labels(); track label.id) {
            <app-label-pill [name]="label.name" [colour]="label.colour" [labelStyle]="style()" />
          }
        </div>
      }
      @if (due() || i.checklist.total > 0 || assignees().length > 0) {
        <div class="foot">
          @if (due(); as d) {
            <span
              class="k-pill"
              [class.danger]="d.state === 'overdue'"
              [class.warn]="d.state === 'soon'"
            >
              <app-icon name="calendar" [size]="12" [stroke]="2.4" />{{ d.text }}
            </span>
          }
          @if (i.checklist.total > 0) {
            <span class="check">
              <app-icon name="checklist" [size]="13" /><span class="visually-hidden">Checklist</span
              >{{ i.checklist.done }}/{{ i.checklist.total }}
              <span class="bar" aria-hidden="true"
                ><span
                  [class.full]="i.checklist.done === i.checklist.total"
                  [style.width.%]="checkPct()"
                ></span
              ></span>
            </span>
          }
          <span class="spacer"></span>
          <span class="k-avatars">
            @for (person of assignees(); track person.id) {
              <app-avatar [userId]="person.id" [name]="person.name" [email]="person.email">
                @if (person.share !== 100) {
                  <span class="share">{{ person.share }}% of this item</span>
                }
              </app-avatar>
              @if (person.share !== 100) {
                <span class="visually-hidden">{{ person.share }}% of this item</span>
              }
            }
          </span>
        </div>
      }
    </div>
  `,
})
export class ItemCard {
  private readonly ctx = inject(ProjectContext);

  /** The item shown. */
  readonly item = input.required<WorkItemDto>();
  /** Today as `YYYY-MM-DD`, for due dates. */
  readonly today = input.required<string>();

  /** Status that shows the "Blocked" pill. */
  protected readonly blocked = ItemStatus.BLOCKED;

  /** The project's label style. */
  protected readonly style = computed(
    () => this.ctx.project()?.settings.labelStyle ?? LabelStyle.SOLID,
  );

  /** The item's labels that still exist. */
  protected readonly labels = computed(() => {
    const byId = this.ctx.labelsById();
    return this.item()
      .labelIds.map((id) => byId.get(id))
      .filter((l) => l !== undefined);
  });

  /** Colour of the cover bar (cover-bar style with at least one label), or null. */
  protected readonly cover = computed(() =>
    this.style() === LabelStyle.COVER ? (this.labels()[0]?.colour ?? null) : null,
  );

  /** Assignees with names, emails and shares (M13). */
  protected readonly assignees = computed(() => {
    const byId = this.ctx.membersById();
    return sharesOf(this.item()).map(({ userId: id, share }) => {
      const member = byId.get(id);
      return {
        id,
        name: member?.displayName ?? 'Former member',
        email: member?.email ?? '',
        share,
      };
    });
  });

  /** The due pill's text and urgency, or null. */
  protected readonly due = computed(() => {
    const state = dueState(this.item(), this.today());
    return state === null ? null : { state, text: dueText(this.item(), this.today()) };
  });

  /** Checklist progress in percent. */
  protected readonly checkPct = computed(() => {
    const { done, total } = this.item().checklist;
    return total === 0 ? 0 : Math.round((done / total) * 100);
  });

  /** True while the card is highlighted after someone else's change. */
  protected readonly flash = computed(() => this.ctx.flashing().has(this.item().id));
  /** "Changed by … just now", or null. */
  protected readonly changedBy = computed(() => {
    this.ctx.recent();
    return this.ctx.changedBy(this.item().id);
  });
  /** Other people who have this item open. */
  protected readonly presence = computed(() => this.ctx.presenceByItem().get(this.item().id) ?? []);
  /** Members by user id, for presence names. */
  protected readonly members = this.ctx.membersById;

  /** True for Done items, which are dimmed. */
  protected readonly done = computed(() => this.item().status === ItemStatus.DONE);
}
