import { HttpClient } from '@angular/common/http';
import {
  Component,
  inject,
  Injectable,
  Injector,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { Router } from '@angular/router';
import type { IntroductionDto, ProjectDto } from '@kloister/shared';
import { firstValueFrom } from 'rxjs';
import { apiUrl, errorMessage } from '../../core/api';
import { AuthService } from '../../core/auth.service';
import { fetchAll } from '../../core/items-api.service';
import { ProjectsApiService } from '../../core/projects-api.service';
import { SessionStore } from '../../core/session.store';
import { dialogMotion } from '../../ui/motion';
import { tourSteps } from './tour-steps';

/** Lazy introduction launcher shared by automatic eligibility and manual Help replay. */
@Injectable({ providedIn: 'root' })
export class TourLauncher {
  private readonly dialogs = inject(MatDialog);
  private readonly store = inject(SessionStore);
  private readonly dismissed = new Set<string>();
  /**
   * Opens at most one untimed tour; delayed automatic reads cannot undo dismissal.
   * @param automatic True only for an automatic eligibility response, never manual replay.
   */
  open(automatic = false): void {
    const id = this.store.user()?.id;
    if (automatic && id !== undefined && this.dismissed.has(id)) return;
    if (this.dialogs.openDialogs.some((dialog) => dialog.componentInstance instanceof TourDialog))
      return;
    this.dialogs.open(TourDialog, {
      enterAnimationDuration: dialogMotion(),
      exitAnimationDuration: dialogMotion(),
      hasBackdrop: false,
      disableClose: true,
      width: 'var(--k-size-640px)',
      maxWidth: 'calc(100vw - var(--k-space-4))',
      maxHeight: 'var(--k-tour-max-height)',
      position: { bottom: 'var(--k-space-2)', right: 'var(--k-space-2)' },
    });
  }
  /**
   * Invalidates delayed automatic eligibility reads after successful durable dismissal.
   * @param id Account that completed or skipped this introduction.
   */
  markDismissed(id: string): void {
    this.dismissed.add(id);
  }
}

/**
 * Checks durable self-only eligibility after the normal password gate succeeds.
 * @param injector Root injection context, used only after lazy code loads.
 * @param userId Signed-in identity captured before the asynchronous read.
 * @returns Resolves after offering the tour, or leaves normal work usable on read failure.
 */
export async function offerIntroduction(injector: Injector, userId: string): Promise<void> {
  try {
    const http = injector.get(HttpClient);
    const store = injector.get(SessionStore);
    const state = await firstValueFrom(http.get<IntroductionDto>(apiUrl('me/introduction')));
    if (state.pending && store.user()?.id === userId && store.user()?.mustChangePassword === false)
      runInInjectionContext(injector, () => inject(TourLauncher).open(true));
  } catch {
    /* Eligibility can be retried at the next sign-in; normal work stays available. */
  }
}

/** Untimed, keyboard-accessible guided page visits with durable completion or Skip. */
@Component({
  selector: 'app-tour-dialog',
  imports: [MatDialogModule, MatButtonModule, MatFormFieldModule, MatSelectModule],
  styles: `
    mat-dialog-content {
      display: grid;
      gap: var(--k-space-2);
    }
    mat-form-field {
      width: 100%;
    }
  `,
  template: `<h2 mat-dialog-title tabindex="-1" aria-live="polite">
      {{ steps()[index()]?.title ?? 'Introduction' }}
    </h2>
    <mat-dialog-content>
      <p>About 2–3 minutes · no timer · Step {{ index() + 1 }} of {{ steps().length }}</p>
      <mat-form-field
        ><mat-label>Project context</mat-label
        ><mat-select [value]="selected()" (valueChange)="choose($event)"
          ><mat-option value="">Common features only</mat-option>
          @for (project of projects(); track project.id) {
            <mat-option [value]="project.id">{{ project.name }}</mat-option>
          }
        </mat-select></mat-form-field
      >
      <p aria-live="polite">{{ steps()[index()]?.text }}</p>
      @if (error()) {
        <p class="k-alert" role="alert">{{ error() }}</p>
      }</mat-dialog-content
    ><mat-dialog-actions align="end"
      ><button mat-button [disabled]="busy()" (click)="finish()">Skip</button
      ><button mat-button [disabled]="index() === 0 || busy()" (click)="move(-1)">Back</button
      ><button
        mat-flat-button
        [disabled]="busy()"
        (click)="index() + 1 === steps().length ? finish() : move(1)"
      >
        {{ index() + 1 === steps().length ? 'Finish' : 'Next' }}
      </button></mat-dialog-actions
    >`,
})
export class TourDialog {
  private readonly auth = inject(AuthService);
  private readonly launcher = inject(TourLauncher);
  private readonly api = inject(ProjectsApiService);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly store = inject(SessionStore);
  private readonly ref = inject(MatDialogRef<TourDialog>);
  /** Current accessible project choices. */
  protected readonly projects = signal<ProjectDto[]>([]);
  /** Scope choice, independent of system administration. */
  protected readonly selected = signal('');
  /** Current freshly composed brief steps. */
  protected readonly steps = signal(tourSteps(null, this.store.isAdmin()));
  /** Current step. */
  protected readonly index = signal(0);
  /** Pending navigation or dismissal. */
  protected readonly busy = signal(false);
  /** Inaccessible contexts are removed and explained. */
  protected readonly error = signal('');
  private readonly originalUser = this.store.user()?.id;
  /** Loads actual memberships without opening or creating a personal space. */
  constructor() {
    void this.load();
  }
  /**
   * Loads current memberships and chooses the current project when applicable.
   * @returns Resolves after accessible choices load.
   */
  private async load(): Promise<void> {
    this.busy.set(true);
    try {
      await this.auth.load();
      if (this.store.user()?.id !== this.originalUser || this.store.user()?.mustChangePassword) {
        this.ref.close();
        return;
      }
      this.steps.set(tourSteps(null, this.store.isAdmin()));
      const projects = await fetchAll((cursor) => this.api.list({ scope: 'mine', cursor }));
      this.projects.set(projects);
      const key = /^\/p\/([^/?#]+)/.exec(this.router.url)?.[1];
      const selected = projects.find((p) => p.key === key) ?? projects[0];
      if (selected !== undefined) await this.choose(selected.id);
      else await this.move(0);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
  /**
   * Rebuilds from the selected project's current capabilities.
   * @param id Current membership project, or common-only.
   * @returns Resolves after reauthorization.
   */
  protected async choose(id: string): Promise<void> {
    this.selected.set(id);
    this.index.set(0);
    await this.move(0);
  }
  /**
   * Rechecks identity/project permissions before visiting a permitted page.
   * @param delta Back/Next movement, or zero to refresh context.
   * @returns Resolves after navigation; lost access falls back to common steps.
   */
  protected async move(delta: number): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.load();
      if (this.store.user()?.id !== this.originalUser || this.store.user()?.mustChangePassword) {
        this.ref.close();
        return;
      }
      let project: ProjectDto | null = null;
      if (this.selected()) {
        try {
          project = await this.api.get(this.selected());
        } catch {
          this.projects.update((projects) => projects.filter((p) => p.id !== this.selected()));
          this.selected.set('');
          this.error.set('Project access changed. Continuing with common features.');
        }
      }
      const steps = tourSteps(project, this.store.isAdmin());
      this.steps.set(steps);
      this.index.set(Math.max(0, Math.min(steps.length - 1, this.index() + delta)));
      const route = steps[this.index()]?.route;
      if (route !== undefined) await this.router.navigate(route);
    } finally {
      this.busy.set(false);
    }
  }
  /**
   * Dismisses automatic eligibility durably; replay cannot re-enroll an account.
   * @returns Resolves after completion/Skip or displays a retryable failure.
   */
  protected async finish(): Promise<void> {
    this.busy.set(true);
    try {
      await firstValueFrom(this.http.put<IntroductionDto>(apiUrl('me/introduction'), {}));
      if (this.originalUser !== undefined) this.launcher.markDismissed(this.originalUser);
      this.ref.close();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}
