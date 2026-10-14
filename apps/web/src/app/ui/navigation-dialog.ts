import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  type Injector,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import {
  MAT_DIALOG_DATA,
  MatDialog,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ProjectsNav } from '../core/projects-nav';
import { SessionStore } from '../core/session.store';
import { Shortcuts } from '../core/shortcuts';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { dialogMotion } from './motion';

/**
 * Lazy navigation and keyboard reference dialog. Search covers the caller's
 * project names and screens; an item key jumps through existing guarded
 * routes. The API remains the authority for an unknown or hidden item.
 */
@Component({
  selector: 'app-navigation-dialog',
  styles: `
    .k-command-search {
      width: 100%;
      margin-top: var(--k-space-2);
    }
    .k-command-results {
      max-height: var(--k-mention-height);
      overflow-y: auto;
      padding: var(--k-space-1);
      [role='option'] {
        padding: var(--k-space-3);
        border-radius: var(--k-radius-control);
        cursor: pointer;
        overflow-wrap: anywhere;
        &[aria-selected='true'] {
          background: var(--k-primary-soft);
          color: var(--k-primary-ink);
        }
      }
    }
    .k-shortcuts {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: var(--k-space-3);
      dd {
        margin: 0;
      }
    }
  `,
  imports: [
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSlideToggleModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ help ? 'Keyboard shortcuts' : 'Search or jump' }}</h2>
    <mat-dialog-content>
      @if (help) {
        <mat-slide-toggle [checked]="keys.enabled()" (change)="keys.setEnabled($event.checked)"
          >Enable single-key shortcuts</mat-slide-toggle
        >
        <dl class="k-shortcuts">
          @for (s of shortcuts; track s.key) {
            <dt>
              <kbd>{{ s.key }}</kbd>
            </dt>
            <dd>{{ s.action }}</dd>
          }
        </dl>
        <p class="muted">
          Single keys work outside text fields. Tab reaches all controls; item fields and reorder
          menus offer alternatives to dragging.
        </p>
      } @else {
        <mat-form-field class="k-command-search">
          <mat-label>Search projects and screens, or enter an item key</mat-label>
          <input
            matInput
            cdkFocusInitial
            [ngModel]="query()"
            (ngModelChange)="query.set($event); active.set(0)"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="command-results"
            [attr.aria-activedescendant]="results().length ? 'command-' + active() : null"
            (keydown)="keydown($event)"
          />
        </mat-form-field>
        <div
          id="command-results"
          role="listbox"
          aria-label="Destinations"
          class="k-command-results"
        >
          @for (r of results(); track r.path; let i = $index) {
            <div
              role="option"
              tabindex="-1"
              [id]="'command-' + i"
              [attr.aria-selected]="active() === i"
              (mousedown)="$event.preventDefault()"
              (click)="go(r.path)"
              (keydown.enter)="go(r.path)"
            >
              {{ r.label }}
            </div>
          } @empty {
            <p class="muted" role="status">
              No matching destinations. Try a project name or an item key.
            </p>
          }
        </div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end"
      ><button mat-button mat-dialog-close type="button">Close</button></mat-dialog-actions
    >
  `,
})
export class NavigationDialog {
  /** Browser-local keyboard preference; the dialog buttons always remain available. */
  protected readonly keys = inject(Shortcuts);
  /** Whether this is the keyboard reference. */
  protected readonly help = inject<boolean>(MAT_DIALOG_DATA);
  private readonly nav = inject(ProjectsNav);
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly ref = inject(MatDialogRef<NavigationDialog>);
  /** Search text. */
  protected readonly query = signal('');
  /** Highlighted destination. */
  protected readonly active = signal(0);
  /** Shortcut reference from DESIGN §12. */
  protected readonly shortcuts = [
    { key: 'C', action: 'Create an item in this project' },
    { key: '/', action: 'Search or jump to an item' },
    { key: 'J / K', action: 'Next / previous board card' },
    { key: 'Enter', action: 'Open the focused card' },
    { key: 'M', action: 'Move the focused item to a bucket' },
    { key: 'A', action: 'Assign the focused item' },
    { key: 'L', action: 'Change labels on the focused item' },
    { key: 'Esc', action: 'Close the drawer or a menu' },
    { key: '?', action: 'Show this reference' },
  ];
  /** Destinations filtered by the typed text; no directory or new API call. */
  protected readonly results = computed(() => {
    const query = this.query().trim().toLowerCase();
    const destinations = [
      { label: 'Projects', path: '/' },
      { label: 'Notifications', path: '/notifications' },
      { label: 'Settings and theme', path: '/settings' },
      { label: 'My work', path: `/people/${this.session.user()?.id ?? ''}` },
    ];
    if (this.session.isAdmin())
      destinations.push(
        { label: 'Users', path: '/admin/users' },
        { label: 'Admin settings', path: '/admin/settings' },
        { label: 'Audit log', path: '/admin/audit' },
      );
    for (const p of this.nav.projects()) {
      for (const [name, suffix] of [
        ['Board', ''],
        ['Backlog', '/backlog'],
        ['Sprints', '/sprints'],
        ['Settings', '/settings'],
      ]) {
        destinations.push({
          label: `${p.key} · ${p.name} · ${name}`,
          path: `/p/${p.key}${suffix}`,
        });
      }
    }
    const item = /^([a-z]{2,6})-(\d+)$/i.exec(query);
    if (item)
      return [
        {
          label: `Open ${query.toUpperCase()}`,
          path: `/p/${item[1]?.toUpperCase()}/items/${item[2]}`,
        },
      ];
    return destinations.filter((d) => d.label.toLowerCase().includes(query)).slice(0, 20);
  });

  /**
   * Moves the active option, or follows it with Enter.
   *
   * @param event The key event.
   */
  protected keydown(event: KeyboardEvent): void {
    const count = this.results().length;
    if (!count) return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? count - 1
            : (this.active() + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      this.active.set(next);
      document.getElementById(`command-${next}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const selected = this.results()[this.active()];
      if (selected) this.go(selected.path);
    }
  }

  /**
   * Closes before navigation so focus restoration cannot steal the new view's focus.
   *
   * @param path Existing guarded application route.
   */
  protected go(path: string): void {
    this.ref.afterClosed().subscribe(() => void this.router.navigateByUrl(path));
    this.ref.close();
  }
}

/**
 * Opens navigation with Material's focus trap and focus return, loaded on demand.
 *
 * @param injector Application injector.
 * @param help True to show the reference instead of search.
 * @returns Resolves after closing.
 */
export async function openNavigation(injector: Injector, help: boolean): Promise<void> {
  const ref = injector.get(MatDialog).open(NavigationDialog, {
    data: help,
    enterAnimationDuration: dialogMotion(),
    exitAnimationDuration: dialogMotion(),
    width: 'var(--k-command-width)',
    maxWidth: 'calc(100vw - var(--k-space-8))',
  });
  await firstValueFrom(ref.afterClosed());
}
