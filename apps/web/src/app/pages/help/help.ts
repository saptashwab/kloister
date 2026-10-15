import { Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { RouterLink } from '@angular/router';
import { SessionStore } from '../../core/session.store';
import { HELP_ARTICLES } from './help-content';
import { TourLauncher } from './tour';

/** Lazy bundled searchable how-to content; only permitted common/admin action links appear. */
@Component({
  selector: 'app-help',
  imports: [MatButtonModule, MatFormFieldModule, MatInputModule, RouterLink],
  styles: `
    article {
      margin-block: var(--k-space-6);
      scroll-margin-top: var(--k-space-6);
    }
    nav {
      display: flex;
      flex-wrap: wrap;
      gap: var(--k-space-3);
    }
    p {
      max-width: var(--k-size-640px);
      overflow-wrap: anywhere;
    }
  `,
  template: `<div class="k-page">
    <div class="k-page-head">
      <h1>Help & FAQ</h1>
      <button mat-flat-button (click)="tour.open()">Take the tour</button>
    </div>
    <mat-form-field
      ><mat-label>Search help</mat-label
      ><input matInput type="search" [value]="search()" (input)="searchInput($event)"
    /></mat-form-field>
    <nav aria-label="Help actions">
      <a routerLink="/work">My work</a><a routerLink="/notifications">Notifications</a
      ><a routerLink="/settings">Account settings</a>
      @if (store.isAdmin()) {
        <a routerLink="/admin/users">Manage users</a
        ><a routerLink="/admin/settings/backups">Server backups</a>
      }
    </nav>
    <p role="status">{{ articles().length }} topics</p>
    <nav aria-label="Help topics">
      @for (article of articles(); track article.id) {
        <a [routerLink]="[]" [fragment]="article.id">{{ article.title }}</a>
      }
    </nav>
    @for (article of articles(); track article.id) {
      <article [id]="article.id">
        <h2>{{ article.title }}</h2>
        <p>
          <strong>{{ article.role }}</strong>
        </p>
        <p>{{ article.text }}</p>
      </article>
    } @empty {
      <p>No matching topics. Try a feature name such as export, assignment or privacy.</p>
    }
  </div>`,
})
export class HelpPage {
  /**
   * Reads the search field without weakening template type checks.
   * @param event Search input event.
   */
  protected searchInput(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.search.set(event.target.value);
  }
  /** Manual replay builds from current permissions. */
  protected readonly tour = inject(TourLauncher);
  /** Independent system privileges for action links. */
  protected readonly store = inject(SessionStore);
  /** Search is local and requires no external service. */
  protected readonly search = signal('');
  /** Every query term matches title, role explanation or procedure. */
  protected readonly articles = computed(() => {
    const terms = this.search().trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return HELP_ARTICLES.filter((article) =>
      terms.every((term) =>
        `${article.title} ${article.role} ${article.text}`.toLocaleLowerCase().includes(term),
      ),
    );
  });
}
