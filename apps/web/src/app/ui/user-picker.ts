import {
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  model,
  signal,
  viewChild,
} from '@angular/core';
import { MatAutocompleteModule, MatAutocompleteTrigger } from '@angular/material/autocomplete';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { MemberCandidateDto } from '@kloister/shared';
import { errorMessage } from '../core/api';

/** Search-and-select field. Its caller supplies an authorized directory or local member search. */
@Component({
  selector: 'app-user-picker',
  imports: [MatAutocompleteModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  styles: `
    :host {
      display: block;
      min-width: 0;
      max-width: 100%;
    }
    .row {
      align-items: baseline;
    }
    mat-form-field {
      width: var(--k-size-288px);
      max-width: 100%;
    }
    .picked {
      display: flex;
      flex-wrap: wrap;
      gap: var(--k-space-1);
    }
  `,
  template: `
    <div class="picked" aria-label="Selected users">
      @for (user of selected(); track user.id) {
        <button
          type="button"
          class="k-chip"
          (click)="remove(user.id)"
          [attr.aria-label]="'Remove ' + user.displayName"
        >
          {{ user.displayName }} ×
        </button>
      }
    </div>
    <div class="row">
      <mat-form-field appearance="outline">
        <mat-label>{{ label() }}</mat-label>
        <input
          matInput
          #field
          [value]="text()"
          [matAutocomplete]="results"
          (input)="edit(field.value)"
          (keydown.enter)="enter($event)"
        />
        <mat-autocomplete
          #results="matAutocomplete"
          [displayWith]="displayChoice"
          (optionSelected)="choose($event.option.value); field.value = ''"
        >
          @for (user of options(); track user.id) {
            <mat-option [value]="user">{{ user.displayName }} ({{ user.email }})</mat-option>
          }
          @if (searched() && options().length === 0) {
            <mat-option disabled>No matching users</mat-option>
          }
        </mat-autocomplete>
      </mat-form-field>
      <button mat-button type="button" (click)="search(); field.focus()">Search</button>
      @if (text()) {
        <button mat-button type="button" (click)="edit('')">Clear</button>
      }
    </div>
    <span role="status">{{ loading() ? 'Searching users…' : '' }}</span>
    @if (error()) {
      <p class="k-alert" role="alert">{{ error() }}</p>
    }
  `,
})
export class UserPicker {
  /** Accessible field name. */
  readonly label = input('User');
  /** Multiple selections retain their chips across searches. */
  readonly multiple = input(false);
  /** Authorized search supplied by the page; never inferred from a system role here. */
  readonly searchUsers = input.required<(q: string) => Promise<MemberCandidateDto[]>>();
  /** Committed identities; free text is never a selection. */
  readonly selected = model<MemberCandidateDto[]>([]);
  protected readonly text = signal('');
  protected readonly options = signal<MemberCandidateDto[]>([]);
  protected readonly searched = signal(false);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  /** Committed users are represented by chips, not object text in the search input. */
  protected readonly displayChoice = (): string => '';
  private readonly trigger = viewChild(MatAutocompleteTrigger);
  private run = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => ++this.run);
    // Changing the scoped search source invalidates outstanding responses too.
    effect(() => {
      this.searchUsers();
      this.edit('');
    });
  }

  /** Invalidates outdated answers and single selection when the query changes.
   * @param value Typed search text.
   */
  protected edit(value: string): void {
    ++this.run;
    this.text.set(value);
    this.options.set([]);
    this.searched.set(false);
    this.loading.set(false);
    this.error.set('');
    if (!this.multiple()) this.selected.set([]);
  }

  /** Searches on Enter unless Material is committing a highlighted option.
   * @param event Keyboard event.
   */
  protected enter(event: Event): void {
    const committed = event.defaultPrevented;
    event.preventDefault();
    if (!committed && !this.trigger()?.activeOption) void this.search();
  }

  /** Loads only the latest query's answers.
   * @returns Resolves when this search finishes.
   */
  protected async search(): Promise<void> {
    const run = ++this.run;
    this.loading.set(true);
    this.error.set('');
    this.options.set([]);
    this.searched.set(false);
    try {
      const found = await this.searchUsers()(this.text().trim());
      if (run !== this.run) return;
      this.options.set(found.filter((u) => !this.selected().some((s) => s.id === u.id)));
      this.searched.set(true);
      // Render the options before opening the panel, including empty results.
      setTimeout(() => {
        if (run === this.run) this.trigger()?.openPanel();
      });
    } catch (error) {
      if (run === this.run) this.error.set(errorMessage(error));
    } finally {
      if (run === this.run) this.loading.set(false);
    }
  }

  /** Commits only an identity from the current results.
   * @param user Chosen result.
   */
  protected choose(user: MemberCandidateDto): void {
    if (!this.options().some((u) => u.id === user.id)) return;
    ++this.run;
    this.selected.set(this.multiple() ? [...this.selected(), user] : [user]);
    this.text.set('');
    this.options.set([]);
    this.searched.set(false);
  }

  /** Removes a committed identity.
   * @param id User id.
   */
  protected remove(id: string): void {
    this.selected.update((list) => list.filter((u) => u.id !== id));
  }
}
