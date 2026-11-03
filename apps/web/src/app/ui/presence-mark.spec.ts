import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { PresenceEntryDto } from '@kloister/shared';
import { makeItem, makeMember } from '../../testing/fixtures';
import { presenceVars } from '../core/colour';
import { ProjectContext } from '../core/project-context';
import { PresenceHead } from './presence-head';
import { PresenceMark, PresenceTag, TAG_FULL_MS } from './presence-mark';

// Field-level presence (DESIGN §9.1): the outline strength and colour, the
// name tag that shrinks to a bar, and the header hover card with "Go to".

const ANN = 'u-ann';
const BO = 'u-bo';

/**
 * A presence entry.
 *
 * @param overrides Fields to change.
 * @returns The entry.
 */
function entry(overrides: Partial<PresenceEntryDto> = {}): PresenceEntryDto {
  return {
    userId: ANN,
    itemId: 'i1',
    action: 'editing',
    field: 'dueDate',
    view: 'board',
    ...overrides,
  };
}

/** Hosts a marked field with its tag. */
@Component({
  imports: [PresenceMark, PresenceTag],
  template: `<div class="zone" [appPresenceMark]="who()">
    @if (who(); as p) {
      <app-presence-tag [entry]="p" />
    }
  </div>`,
})
class MarkHost {
  readonly who = signal<PresenceEntryDto | null>(null);
}

/** Hosts a cell whose people are already announced elsewhere in its row. */
@Component({
  imports: [PresenceMark, PresenceTag],
  template: `<div class="cell" [appPresenceMark]="who">
    <app-presence-tag [entry]="who" place="inside" [announce]="false" />
  </div>`,
})
class QuietHost {
  readonly who = entry();
}

/** Hosts the header avatars. */
@Component({
  imports: [PresenceHead],
  template: `<app-presence-head [people]="people()" (goTo)="chosen.push($event)" />`,
})
class HeadHost {
  readonly people = signal<PresenceEntryDto[]>([]);
  readonly chosen: PresenceEntryDto[] = [];
}

describe('presence marks', () => {
  const members = signal(
    new Map([
      [ANN, makeMember(ANN, 'Ann Lee', { email: 'ann@example.org' })],
      [BO, makeMember(BO, 'Bo Berg')],
    ]),
  );
  const items = signal(new Map([['i1', makeItem(42, { id: 'i1', title: 'Fix login' })]]));

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: ProjectContext, useValue: { membersById: members, itemsById: items } },
      ],
    });
  });

  afterEach(() => vi.useRealTimers());

  it('outlines strongly while editing and faintly while viewing, in the person colour', () => {
    const fixture = TestBed.createComponent(MarkHost);
    fixture.detectChanges();
    const zone = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.zone')!;
    expect(zone.classList).not.toContain('k-pm');
    fixture.componentInstance.who.set(entry());
    fixture.detectChanges();
    expect(zone.classList).toContain('k-pm-strong');
    expect(zone.style.getPropertyValue('--pm')).toBe(presenceVars(ANN)['--pm']);
    fixture.componentInstance.who.set(entry({ action: 'viewing', field: null }));
    fixture.detectChanges();
    expect(zone.classList).toContain('k-pm-faint');
    expect(zone.classList).not.toContain('k-pm-strong');
  });

  it('names the person, then shrinks the tag, and shows the name again for a new field', () => {
    vi.useFakeTimers();
    const fixture = TestBed.createComponent(MarkHost);
    fixture.componentInstance.who.set(entry());
    fixture.detectChanges();
    const tag = (): HTMLElement =>
      (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('app-presence-tag')!;
    expect(tag().getAttribute('role')).toBe('img');
    expect(tag().getAttribute('aria-label')).toBe('Ann Lee is editing the due date');
    expect(tag().getAttribute('title')).toBe('Ann Lee is editing the due date');
    expect(tag().textContent?.trim()).toBe('Ann');
    expect(tag().classList).not.toContain('short');
    vi.advanceTimersByTime(TAG_FULL_MS);
    fixture.detectChanges();
    expect(tag().classList).toContain('short');
    // The same field again (a new presence event) keeps it short.
    fixture.componentInstance.who.set(entry());
    fixture.detectChanges();
    expect(tag().classList).toContain('short');
    fixture.componentInstance.who.set(entry({ field: 'title' }));
    fixture.detectChanges();
    expect(tag().classList).not.toContain('short');
    expect(tag().getAttribute('aria-label')).toBe('Ann Lee is editing the title');
  });

  it('keeps the tooltip but hides a tag the row already announces', () => {
    const fixture = TestBed.createComponent(QuietHost);
    fixture.detectChanges();
    const tag = (fixture.nativeElement as HTMLElement).querySelector('app-presence-tag')!;
    expect(tag.getAttribute('title')).toBe('Ann Lee is editing the due date');
    expect(tag.getAttribute('aria-hidden')).toBe('true');
    expect(tag.getAttribute('role')).toBeNull();
    expect(tag.getAttribute('aria-label')).toBeNull();
  });

  it('says in the header hover card what each person does, with Go to only for an item', async () => {
    const fixture = TestBed.createComponent(HeadHost);
    const away = entry({ userId: BO, itemId: null, action: null, field: null, view: 'timeline' });
    fixture.componentInstance.people.set([entry(), away]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe(
      'Ann Lee, Bo Berg are here too',
    );
    const [ann, bo] = [...root.querySelectorAll<HTMLButtonElement>('button.k-avatar')];
    ann.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const card = document.querySelector<HTMLElement>('.k-popover[aria-label="Ann Lee"]')!;
    expect(card.textContent).toContain('Ann Lee is editing the due date of KLO-42 · Fix login');
    const goTo = [...card.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Go to KLO-42'),
    );
    expect(goTo).toBeDefined();
    goTo!.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.chosen).toEqual([entry()]);
    expect(document.querySelector('.k-popover[aria-label="Ann Lee"]')).toBeNull();
    bo.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const other = document.querySelector<HTMLElement>('.k-popover[aria-label="Bo Berg"]')!;
    expect(other.textContent).toContain('Viewing the timeline');
    expect(other.textContent).not.toContain('Go to');
  });
});
