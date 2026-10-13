import { Component, computed, inject, input } from '@angular/core';
import type { WorkItemDto } from '@kloister/shared';
import { isOverdue } from '../../core/board-logic';
import { TYPE_BADGES, TYPE_LABELS } from '../../core/labels';
import { ProjectContext } from '../../core/project-context';

/**
 * Initials for an avatar, e.g. "Ann Lee" → "AL".
 *
 * @param name Display name.
 * @returns One or two capital letters.
 */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : [parts[0] ?? '?'];
  return letters.map((p) => (p ?? '?').charAt(0).toUpperCase()).join('');
}

/**
 * One board card (SPEC §6): type badge, key, title, labels, assignee
 * avatars, due date (red when overdue) and checklist progress. Display only;
 * the board handles opening and dragging.
 */
@Component({
  selector: 'app-item-card',
  host: { class: 'card' },
  styles: `
    :host {
      display: block;
      padding: 8px;
      border-radius: 8px;
      background: var(--mat-sys-surface-container-lowest);
      border: 1px solid var(--mat-sys-outline-variant);
      font-size: 0.875rem;
    }
    .top,
    .meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 8px;
    }
    .key {
      color: var(--mat-sys-on-surface-variant);
    }
    .title {
      margin: 4px 0;
      overflow-wrap: anywhere;
    }
    .avatar {
      display: inline-grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
      font-size: 0.7rem;
    }
    .overdue {
      color: var(--mat-sys-error);
      font-weight: 600;
    }
  `,
  template: `
    @let i = item();
    <div class="top">
      <span class="badge" [attr.data-type]="i.type" [title]="typeLabels[i.type]">{{
        badges[i.type]
      }}</span>
      <span class="key">{{ i.key }}</span>
    </div>
    <div class="title">{{ i.title }}</div>
    <div class="meta">
      @for (label of labels(); track label.id) {
        <span class="label" [style.border-left-color]="label.colour">{{ label.name }}</span>
      }
      @if (i.dueDate) {
        <span [class.overdue]="overdue()" [title]="overdue() ? 'Overdue' : 'Due date'">
          {{ overdue() ? 'Overdue ' : 'Due ' }}{{ i.dueDate }}
        </span>
      }
      @if (i.checklist.total > 0) {
        <span title="Checklist">☑ {{ i.checklist.done }}/{{ i.checklist.total }}</span>
      }
      @for (person of assignees(); track person.id) {
        <span class="avatar" [title]="person.name" role="img" [attr.aria-label]="person.name">{{
          person.initials
        }}</span>
      }
    </div>
  `,
})
export class ItemCard {
  private readonly ctx = inject(ProjectContext);

  /** The item shown. */
  readonly item = input.required<WorkItemDto>();
  /** Today as `YYYY-MM-DD`, for the overdue check. */
  readonly today = input.required<string>();

  /** Type badge letters. */
  protected readonly badges = TYPE_BADGES;
  /** Type names. */
  protected readonly typeLabels = TYPE_LABELS;

  /** The item's labels that still exist. */
  protected readonly labels = computed(() => {
    const byId = this.ctx.labelsById();
    return this.item()
      .labelIds.map((id) => byId.get(id))
      .filter((l) => l !== undefined);
  });

  /** Assignees with display names and initials. */
  protected readonly assignees = computed(() => {
    const byId = this.ctx.membersById();
    return this.item().assigneeIds.map((id) => {
      const name = byId.get(id)?.displayName ?? 'Former member';
      return { id, name, initials: initials(name) };
    });
  });

  /** True when the item is past due and not Done. */
  protected readonly overdue = computed(() => isOverdue(this.item(), this.today()));
}
