import { HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import {
  ProjectPermission,
  type RescheduleChangeRequest,
  type RescheduleResultDto,
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
 * Date changes with dependent moves (SPEC §6.4, docs/M9-PLAN.md §4): used by
 * the timeline and by the item drawer of a project. With the project's
 * automatic moving on, the change applies at once; otherwise a preview that
 * moves anything else is confirmed in a dialog first. Either way the toast
 * offers Undo, which restores every changed item's dates and pins unless one
 * changed since (all or nothing, enforced by the API's version check).
 *
 * Provided by the project shell, next to the {@link ProjectContext} it updates.
 */
@Injectable()
export class RescheduleFlow {
  private readonly ctx = inject(ProjectContext);
  private readonly api = inject(ItemsApiService);
  private readonly projects = inject(ProjectsApiService);
  private readonly dialog = inject(MatDialog);
  private readonly toast = inject(ToastService);

  /**
   * Changes dates (or reschedules items from their predecessors when a change
   * names no date) and moves dependent items as the project is set up to.
   *
   * @param changes The requested changes.
   * @returns The applied result, or null when cancelled or refused.
   */
  async change(changes: RescheduleChangeRequest[]): Promise<RescheduleResultDto | null> {
    const project = this.ctx.project();
    if (project === null || changes.length === 0) return null;
    try {
      if (project.settings.autoMoveDependents) {
        return await this.applyWithRetry(changes);
      }
      const plan = await this.api.reschedule(project.id, { mode: 'preview', changes });
      if (plan.changes.length === 0) {
        // E.g. a start typed before the predecessors allow, on an item that
        // already starts as early as it can.
        this.toast.show('Nothing changed: the dates already fit their predecessors');
        return null;
      }
      const quiet = plan.kept.length === 0 && plan.changes.every((c) => c.requested && !c.snapped);
      if (quiet) return await this.apply(changes, 'apply', plan);
      const { RescheduleDialog } = await import('../pages/timeline/reschedule-dialog');
      const ref = this.dialog.open<
        InstanceType<typeof RescheduleDialog>,
        RescheduleDialogData,
        RescheduleChoice
      >(RescheduleDialog, {
        data: {
          plan,
          today: dayOf(new Date()),
          canSwitch: this.ctx.has(ProjectPermission.MANAGE_PROJECT),
        },
        width: 'var(--k-size-640px)',
        maxWidth: 'calc(100vw - var(--k-space-8))',
        enterAnimationDuration: dialogMotion(),
        exitAnimationDuration: dialogMotion(),
      });
      const choice = await firstValueFrom(ref.afterClosed());
      if (choice === null || choice === undefined) return null;
      if (choice.always) {
        const updated = await this.projects.update(project.id, {
          settings: { autoMoveDependents: true },
        });
        this.ctx.project.set(updated);
      }
      return await this.apply(changes, choice.move ? 'apply' : 'only', plan);
    } catch (error) {
      this.toast.error(error);
      return null;
    }
  }

  /**
   * Applies directly (automatic moving); a version conflict from an edit
   * elsewhere is retried once with fresh data.
   *
   * @param changes The requested changes.
   * @returns The result.
   */
  private async applyWithRetry(
    changes: RescheduleChangeRequest[],
  ): Promise<RescheduleResultDto | null> {
    try {
      return await this.apply(changes, 'apply', null);
    } catch (error) {
      if (!(error instanceof HttpErrorResponse) || error.status !== 409) throw error;
      await this.ctx.refresh();
      return this.apply(changes, 'apply', null);
    }
  }

  /**
   * Sends the change, stores the changed items and shows the toast with Undo.
   *
   * @param changes The requested changes.
   * @param mode Apply with dependent moves, or only the requested items.
   * @param preview The preview the person confirmed, checked again by the API.
   * @returns The result.
   */
  private async apply(
    changes: RescheduleChangeRequest[],
    mode: 'apply' | 'only',
    preview: RescheduleResultDto | null,
  ): Promise<RescheduleResultDto> {
    const project = this.ctx.project()!;
    const byId = this.ctx.itemsById();
    const expect: Record<string, string> = {};
    for (const c of preview?.changes ?? []) expect[c.item.id] = c.version;
    for (const change of changes) {
      const item =
        byId.get(change.item) ?? this.ctx.items().find((i) => String(i.number) === change.item);
      if (item !== undefined && expect[item.id] === undefined) expect[item.id] = item.updatedAt;
    }
    const result = await this.api.reschedule(project.id, {
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
    for (const item of result.items) this.ctx.upsert(item);
    if (result.changes.length === 0) {
      this.toast.show('Nothing changed: the dates already fit their predecessors');
      return result;
    }
    this.toast.show(this.message(result), () => this.undo(result));
    return result;
  }

  /**
   * Restores every item the change touched, with its pin.
   *
   * @param result The applied change.
   * @returns Resolves once undone.
   */
  private async undo(result: RescheduleResultDto): Promise<void> {
    const project = this.ctx.project();
    if (project === null) return;
    try {
      const undone = await this.api.reschedule(project.id, {
        mode: 'only',
        changes: result.changes.map((c) => ({ item: c.item.id, ...c.from, pinTo: c.pinFrom })),
        expect: Object.fromEntries(result.items.map((i) => [i.id, i.updatedAt])),
      });
      for (const item of undone.items) this.ctx.upsert(item);
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 409) {
        this.toast.show("Can't undo: an item has changed since");
        await this.ctx.refresh();
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
