import { Component, inject, type OnInit, signal } from '@angular/core';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { SettingsApiService } from '../../core/settings-api.service';
import { ToastService } from '../../ui/toast.service';

/**
 * Admin general settings: the "Live updates" switch (M10). On by default;
 * off, no live streams are accepted, every open stream ends, presence is
 * gone and screens behave as before live updates (changes show after a
 * reload), so a proxy that breaks streaming can be worked around without a
 * release.
 *
 * Permissions: admin route; the API refuses everyone else.
 */
@Component({
  selector: 'app-admin-general',
  host: { class: 'k-tab' },
  imports: [MatSlideToggleModule],
  template: `
    <section class="k-panel" aria-labelledby="live-title">
      <h2 id="live-title">Live updates</h2>
      <p class="lead">
        Boards, backlogs, timelines, item details and notifications update while people look at
        them, and people see who else has an item open. Switch this off if the server's proxy holds
        back live updates; screens then show changes after a reload. People who already have the app
        open notice a change of this setting when they reload.
      </p>
      @if (enabled(); as value) {
        <mat-slide-toggle
          [checked]="value === 'on'"
          [disabled]="busy()"
          (change)="save($event.checked)"
          >Live updates and presence</mat-slide-toggle
        >
      }
    </section>
  `,
})
export class AdminGeneralPage implements OnInit {
  private readonly api = inject(SettingsApiService);
  private readonly toast = inject(ToastService);

  /** The switch once loaded. */
  protected readonly enabled = signal<'on' | 'off' | null>(null);
  /** True while saving. */
  protected readonly busy = signal(false);

  /**
   * Loads the switch.
   */
  ngOnInit(): void {
    void this.api.live().then(
      (value) => this.enabled.set(value.enabled ? 'on' : 'off'),
      (error: unknown) => this.toast.error(error),
    );
  }

  /**
   * Saves the switch.
   *
   * @param enabled The new value.
   * @returns Resolves once saved.
   */
  protected async save(enabled: boolean): Promise<void> {
    this.busy.set(true);
    try {
      const saved = await this.api.saveLive({ enabled });
      this.enabled.set(saved.enabled ? 'on' : 'off');
      this.toast.show(saved.enabled ? 'Live updates switched on' : 'Live updates switched off');
    } catch (error) {
      this.toast.error(error);
      // Show the stored value again.
      const value = this.enabled();
      this.enabled.set(null);
      setTimeout(() => this.enabled.set(value));
    } finally {
      this.busy.set(false);
    }
  }
}
