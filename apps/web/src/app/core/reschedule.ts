import { HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import {
  ProjectPermission,
  type RescheduleChangeRequest,
  type RescheduleResultDto,
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
}

/**
 * Date changes with dependent moves (SPEC §6.4, docs/M9-PLAN.md §4): used by
 * the timeline, the calendars (M13) and by the item drawer of a project. With the project's
 * automatic moving on, the change applies at once; otherwise a preview that
 * moves anything else is confirmed in a dialog first. Either way the toast
 * offers Undo, which restores every changed item's dates and pins unless one
 * changed since (all or nothing, enforced by the API's version check).
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
      const plan = await this.api.reschedule(target.projectId, { mode: 'preview', changes });
      if (plan.changes.length === 0) {
        // E.g. a start typed before the predecessors allow, on an item that
        // already starts as early as it can.
        this.toast.show('Nothing changed: the dates already fit their predecessors');
        return null;
      }
      const quiet = plan.kept.length === 0 && plan.changes.every((c) => c.requested && !c.snapped);
      if (quiet) return await this.apply(target, changes, 'apply', plan);
      const { RescheduleDialog } = await import('../pages/timeline/reschedule-dialog');
      const ref = this.dialog.open<
        InstanceType<typeof RescheduleDialog>,
        RescheduleDialogData,
        RescheduleChoice
      >(RescheduleDialog, {
        data: {
          plan,
          today: dayOf(new Date()),
          canSwitch: target.canSwitch,
        },
        width: 'var(--k-size-640px)',
        maxWidth: 'calc(100vw - var(--k-space-8))',
        enterAnimationDuration: dialogMotion(),
        exitAnimationDuration: dialogMotion(),
      });
      const choice = await firstValueFrom(ref.afterClosed());
      if (choice === null || choice === undefined) return null;
      if (choice.always) {
        const updated = await this.projects.update(target.projectId, {
          settings: { autoMoveDependents: true },
        });
        if (this.ctx?.project()?.id === updated.id) this.ctx.project.set(updated);
        target.switched();
      }
      return await this.apply(target, changes, choice.move ? 'apply' : 'only', plan);
    } catch (error) {
      this.toast.error(error);
      return null;
    }
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
