import { Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { RouterLink } from '@angular/router';
import { SessionStore } from '../../core/session.store';
import { HELP_ARTICLES, type HelpArticle } from './help-content';
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
    p,
    ol {
      max-width: var(--k-size-640px);
      overflow-wrap: anywhere;
    }
    li {
      margin-block: var(--k-space-1);
    }
    img {
      display: block;
      max-width: min(100%, var(--k-size-640px));
      height: auto;
      border: var(--k-line) solid var(--k-border);
      border-radius: var(--k-radius-md);
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
        @for (section of article.sections ?? []; track section.heading) {
          <h3>{{ section.heading }}</h3>
          @if (section.text) {
            <p>{{ section.text }}</p>
          }
          @if (section.steps) {
            <ol>
              @for (step of section.steps; track $index) {
                <li>{{ step }}</li>
              }
            </ol>
          }
          @if (section.image; as image) {
            <img [src]="image.src" [alt]="image.alt" loading="lazy" decoding="async" />
          }
        }
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
  /** Every query term matches title, role explanation, procedure or a section. */
  protected readonly articles = computed(() => {
    const terms = this.search().trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return HELP_ARTICLES.filter((article) =>
      terms.every((term) => searchable(article).includes(term)),
    );
  });
}

/**
 * All text of an article that search looks at: title, role note, summary and
 * every section's heading, paragraph and steps.
 *
 * @param article A help article.
 * @returns Lower-case searchable text.
 */
function searchable(article: HelpArticle): string {
  const sections = (article.sections ?? []).flatMap((s) => [
    s.heading,
    s.text ?? '',
    ...(s.steps ?? []),
  ]);
  return [article.title, article.role, article.text, ...sections].join(' ').toLocaleLowerCase();
}
