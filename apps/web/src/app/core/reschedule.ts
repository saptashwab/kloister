import { HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import {
  type PlanEdge,
  type PreviewItem,
  previewReschedule,
  ProjectPermission,
  type RescheduleChangeRequest,
  type RescheduleResultDto,
  type WorkCalendar,
  type WorkItemDto,
} from '@kloister/shared';
import { firstValueFrom } from 'rxjs';
import { ToastService } from '../ui/toast.service';
import { dialogMotion } from '../ui/motion';
import { dayOf } from './format';
import { ItemsApiService } from './items-api.service';
import { ProjectContext } from './project-context';
import { ProjectsApiService } from './projects-api.service';
import { startText } from './timeline-logic';
import type { RescheduleChoice, RescheduleDialogData } from '../pages/timeline/reschedule-dialog';

/**
 * Where a reschedule happens: a project open in a {@link ProjectContext}, or
 * a project of the My work calendar (M13), which knows less about it.
 */
export interface RescheduleTarget {
  /** Project id. */
  projectId: string;
  /** Dependent items move without asking. */
  autoMove: boolean;
  /** The caller may switch automatic moving on (PMs). */
  canSwitch: boolean;
  /** The version (`updatedAt`) the caller saw of an item, by id or number. */
  version(item: string): { id: string; updatedAt: string } | undefined;
  /** Takes the changed items. */
  store(items: readonly WorkItemDto[]): void;
  /** Reloads after a version conflict. */
  refresh(): Promise<void>;
  /** The project now moves dependent items without asking. */
  switched(): void;
  /**
   * What a preview in the browser needs (v1.4.1); null when not known, so
   * the API previews instead. Optional.
   */
  plan?(): LocalPlan | null;
}

/** The plan as the browser knows it, for a local preview (v1.4.1). */
export interface LocalPlan {
  /** The caller's visible, non-ad-hoc items as saved (no unsaved edits). */
  items: readonly PreviewItem[];
  /** Links whose both ends are visible. */
  edges: readonly PlanEdge[];
  /** The project's working-day calendar. */
  calendar: WorkCalendar;
}

/** The note shown when an apply found the plan changed (v1.4.1). */
export const PLAN_CHANGED_NOTE = 'The plan changed meanwhile. Please check the moves again.';

/**
 * The fields a date change shows at once, before the server confirms it
 * (v1.4.1): only the date fields the change names.
 *
 * @param change The change.
 * @returns The fields to show.
 */
export function changePatch(change: RescheduleChangeRequest): Partial<WorkItemDto> {
  const patch: Partial<WorkItemDto> = {};
  if (change.startDate !== undefined) {
    patch.startDate = change.startDate;
    patch.startSecondHalf = change.startDate !== null && (change.startSecondHalf ?? false);
  } else if (change.startSecondHalf !== undefined) patch.startSecondHalf = change.startSecondHalf;
  if (change.dueDate !== undefined) {
    patch.dueDate = change.dueDate;
    patch.dueFirstHalf = change.dueDate !== null && (change.dueFirstHalf ?? false);
  } else if (change.dueFirstHalf !== undefined) patch.dueFirstHalf = change.dueFirstHalf;
  return patch;
}

/**
 * An item as a local preview sees it.
 *
 * @param item The saved item.
 * @returns The preview item.
 */
export function previewItem(item: WorkItemDto): PreviewItem {
  return {
    id: item.id,
    startDate: item.startDate,
    startSecondHalf: item.startSecondHalf,
    dueDate: item.dueDate,
    dueFirstHalf: item.dueFirstHalf,
    status: item.status,
    pin: item.startNoEarlierThan,
    editable: item.can.plan,
    ref: { id: item.id, number: item.number, key: item.key, type: item.type, title: item.title },
    version: item.updatedAt,
  };
}

/**
 * Date changes with dependent moves (SPEC §6.4, docs/M9-PLAN.md §4): used by
 * the timeline, the calendars (M13) and by the item drawer of a project. With the project's
 * automatic moving on, the change applies at once; otherwise a preview that
 * moves anything else is confirmed in a dialog first. Either way the toast
 * offers Undo, which restores every changed item's dates and pins unless one
 * changed since (all or nothing, enforced by the API's version check).
 *
 * The preview is planned in the browser when the open page knows the links
 * and calendar (v1.4.1), so the dialog opens at once; the apply sends what
 * was shown and the API plans again. When the plans differ (409) the API's
 * preview is shown, with a note that the plan changed meanwhile.
 *
 * Provided by the project shell, next to the {@link ProjectContext} it updates.
 */
@Injectable()
export class RescheduleFlow {
  /** The open project; the My work calendar has none and passes a target. */
  private readonly ctx = inject(ProjectContext, { optional: true });
  private readonly api = inject(ItemsApiService);
  private readonly projects = inject(ProjectsApiService);
  private readonly dialog = inject(MatDialog);
  private readonly toast = inject(ToastService);

  /**
   * Changes dates (or reschedules items from their predecessors when a change
   * names no date) and moves dependent items as the project is set up to.
   *
   * @param changes The requested changes.
   * @param target Where; the open project by default.
   * @returns The applied result, or null when cancelled or refused.
   */
  async change(
    changes: RescheduleChangeRequest[],
    target: RescheduleTarget | null = this.projectTarget(),
  ): Promise<RescheduleResultDto | null> {
    if (target === null || changes.length === 0) return null;
    try {
      if (target.autoMove) {
        return await this.applyWithRetry(target, changes);
      }
      let plan = this.localPreview(target, changes) ?? (await this.serverPreview(target, changes));
      let note: string | null = null;
      for (;;) {
        if (plan.changes.length === 0) {
          // E.g. a start typed before the predecessors allow, on an item that
          // already starts as early as it can.
          this.toast.show('Nothing changed: the dates already fit their predecessors');
          return null;
        }
        const quiet =
          note === null &&
          plan.kept.length === 0 &&
          plan.changes.every((c) => c.requested && !c.snapped);
        const choice = quiet ? { move: true, always: false } : await this.ask(target, plan, note);
        if (choice === null) return null;
        if (choice.always && !target.autoMove) {
          const updated = await this.projects.update(target.projectId, {
            settings: { autoMoveDependents: true },
          });
          if (this.ctx?.project()?.id === updated.id) this.ctx.project.set(updated);
          target.switched();
        }
        try {
          return await this.apply(target, changes, choice.move ? 'apply' : 'only', plan);
        } catch (error) {
          // Once: the plan changed since it was shown, so the API's plan is shown.
          if (!(error instanceof HttpErrorResponse) || error.status !== 409 || note !== null)
            throw error;
          await target.refresh();
          plan = await this.serverPreview(target, changes);
          note = PLAN_CHANGED_NOTE;
        }
      }
    } catch (error) {
      this.toast.error(error);
      return null;
    }
  }

  /**
   * Loads the confirmation dialog's code ahead of the first date change, so
   * it opens at once (v1.4.1). It stays a lazy chunk.
   *
   * @returns Resolves once loaded; a failure is left to the first real use.
   */
  async preload(): Promise<void> {
    try {
      await import('../pages/timeline/reschedule-dialog');
    } catch {
      // Offline or a new deployment; the dialog loads when needed.
    }
  }

  /**
   * Plans the change in the browser (v1.4.1) when the target knows the
   * plan and nothing needs the API: no exact pins (Undo), and every
   * requested item is a visible timeline item the caller may plan.
   *
   * @param target Where.
   * @param changes The requested changes.
   * @returns The preview, or null to ask the API.
   */
  private localPreview(
    target: RescheduleTarget,
    changes: RescheduleChangeRequest[],
  ): RescheduleResultDto | null {
    if (changes.some((c) => c.pinTo !== undefined)) return null;
    const plan = target.plan?.() ?? null;
    if (plan === null) return null;
    const byId = new Map(plan.items.map((i) => [i.id, i]));
    const resolved = changes.map((c) => ({ ...c, item: target.version(c.item)?.id ?? c.item }));
    // Ad-hoc, hidden or unplannable items: the API answers with the reason.
    if (resolved.some((c) => byId.get(c.item)?.editable !== true)) return null;
    const preview = previewReschedule(plan.items, plan.edges, resolved, plan.calendar);
    // "Nothing changed" is left to the API, in case the store is behind.
    return preview === null || preview.changes.length === 0 ? null : preview;
  }

  /**
   * Asks the API for the preview.
   *
   * @param target Where.
   * @param changes The requested changes.
   * @returns The preview.
   */
  private serverPreview(
    target: RescheduleTarget,
    changes: RescheduleChangeRequest[],
  ): Promise<RescheduleResultDto> {
    return this.api.reschedule(target.projectId, { mode: 'preview', changes });
  }

  /**
   * Shows the preview for confirmation.
   *
   * @param target Where.
   * @param plan The preview.
   * @param note A note above it, e.g. that the plan changed meanwhile.
   * @returns The choice, or null when cancelled.
   */
  private async ask(
    target: RescheduleTarget,
    plan: RescheduleResultDto,
    note: string | null,
  ): Promise<{ move: boolean; always: boolean } | null> {
    const { RescheduleDialog } = await import('../pages/timeline/reschedule-dialog');
    const ref = this.dialog.open<
      InstanceType<typeof RescheduleDialog>,
      RescheduleDialogData,
      RescheduleChoice
    >(RescheduleDialog, {
      data: { plan, today: dayOf(new Date()), canSwitch: target.canSwitch, note },
      width: 'var(--k-size-640px)',
      maxWidth: 'calc(100vw - var(--k-space-8))',
      enterAnimationDuration: dialogMotion(),
      exitAnimationDuration: dialogMotion(),
    });
    return (await firstValueFrom(ref.afterClosed())) ?? null;
  }

  /**
   * The open project as a reschedule target.
   *
   * @returns The target, or null without an open project.
   */
  private projectTarget(): RescheduleTarget | null {
    const ctx = this.ctx;
    const project = ctx?.project() ?? null;
    if (ctx === null || project === null) return null;
    return {
      projectId: project.id,
      autoMove: project.settings.autoMoveDependents,
      canSwitch: ctx.has(ProjectPermission.MANAGE_PROJECT),
      version: (ref) =>
        ctx.itemsById().get(ref) ?? ctx.items().find((i) => String(i.number) === ref),
      store: (items) => {
        for (const item of items) ctx.upsert(item);
      },
      refresh: () => ctx.refresh(),
      switched: () => undefined,
      plan: () => {
        const source = ctx.plan();
        if (source === null || !ctx.writable()) return null;
        return {
          // As saved: edits still waiting are not the current dates.
          items: ctx
            .items()
            .filter((i) => !i.adHoc)
            .map((i) => previewItem(ctx.edits.base(i.id) ?? i)),
          edges: source.edges,
          calendar: source.calendar,
        };
      },
    };
  }

  /**
   * Applies directly (automatic moving); a version conflict from an edit
   * elsewhere is retried once with fresh data.
   *
   * @param target Where.
   * @param changes The requested changes.
   * @returns The result.
   */
  private async applyWithRetry(
    target: RescheduleTarget,
    changes: RescheduleChangeRequest[],
  ): Promise<RescheduleResultDto | null> {
    try {
      return await this.apply(target, changes, 'apply', null);
    } catch (error) {
      if (!(error instanceof HttpErrorResponse) || error.status !== 409) throw error;
      await target.refresh();
      return this.apply(target, changes, 'apply', null);
    }
  }

  /**
   * Sends the change, stores the changed items and shows the toast with Undo.
   *
   * @param target Where.
   * @param changes The requested changes.
   * @param mode Apply with dependent moves, or only the requested items.
   * @param preview The preview the person confirmed, checked again by the API.
   * @returns The result.
   */
  private async apply(
    target: RescheduleTarget,
    changes: RescheduleChangeRequest[],
    mode: 'apply' | 'only',
    preview: RescheduleResultDto | null,
  ): Promise<RescheduleResultDto> {
    const expect: Record<string, string> = {};
    for (const c of preview?.changes ?? []) expect[c.item.id] = c.version;
    for (const change of changes) {
      const item = target.version(change.item);
      if (item !== undefined && expect[item.id] === undefined) expect[item.id] = item.updatedAt;
    }
    const result = await this.api.reschedule(target.projectId, {
      mode,
      changes,
      expect,
      ...(mode === 'apply' && preview !== null
        ? {
            previewed: preview.changes
              .filter((c) => !c.requested)
              .map((c) => ({ id: c.item.id, to: c.to })),
          }
        : {}),
    });
    target.store(result.items);
    if (result.changes.length === 0) {
      this.toast.show('Nothing changed: the dates already fit their predecessors');
      return result;
    }
    this.toast.show(this.message(result), () => this.undo(target, result));
    return result;
  }

  /**
   * Restores every item the change touched, with its pin.
   *
   * @param target Where.
   * @param result The applied change.
   * @returns Resolves once undone.
   */
  private async undo(target: RescheduleTarget, result: RescheduleResultDto): Promise<void> {
    try {
      const undone = await this.api.reschedule(target.projectId, {
        mode: 'only',
        changes: result.changes.map((c) => ({ item: c.item.id, ...c.from, pinTo: c.pinFrom })),
        expect: Object.fromEntries(result.items.map((i) => [i.id, i.updatedAt])),
      });
      target.store(undone.items);
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 409) {
        this.toast.show("Can't undo: an item has changed since");
        await target.refresh();
        return;
      }
      this.toast.error(error);
    }
  }

  /**
   * The toast text for an applied change.
   *
   * @param result The result.
   * @returns E.g. "WEB-11 updated · moved WEB-12, WEB-15".
   */
  private message(result: RescheduleResultDto): string {
    const requested = result.changes.filter((c) => c.requested);
    const moved = result.changes.filter((c) => !c.requested).map((c) => c.item.key);
    const snapped = requested.find((c) => c.snapped);
    const head =
      snapped !== undefined
        ? `${snapped.item.key} starts ${startText(snapped.to, dayOf(new Date()))}, after its predecessors`
        : requested.length === 1
          ? `${requested[0].item.key} updated`
          : `${requested.length} items updated`;
    const tail =
      moved.length === 0
        ? ''
        : ` · moved ${moved.slice(0, 4).join(', ')}${moved.length > 4 ? ` and ${moved.length - 4} more` : ''}`;
    const kept = result.kept.length === 0 ? '' : ` · ${result.kept.length} kept their dates`;
    return head + tail + kept;
  }
}
