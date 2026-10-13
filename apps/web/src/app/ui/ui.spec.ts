import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter } from '@angular/router';
import { of, Subject } from 'rxjs';
import { settle } from '../../testing/fixtures';
import { Avatar, PERSON_FILTER } from './avatar';
import { Dialogs } from './dialogs';
import { LabelPill } from './label-pill';
import { PriorityIcon } from './signals';
import { ToastService } from './toast.service';

/** Hosts an avatar under a page with a person filter. */
@Component({
  imports: [Avatar],
  providers: [{ provide: PERSON_FILTER, useExisting: FilterHost }],
  template: `<app-avatar userId="u7" name="Mia Member" email="mia@example.org" [toggle]="true" />`,
})
class FilterHost {
  readonly active = signal<string | null>(null);
  readonly toggled: string[] = [];

  toggle(userId: string): void {
    this.toggled.push(userId);
    this.active.set(this.active() === userId ? null : userId);
  }
}

/** Hosts an avatar without a person filter. */
@Component({
  imports: [Avatar],
  template: `<app-avatar userId="u7" name="Mia Member" email="mia@example.org" />`,
})
class PlainHost {}

describe('Avatar', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [provideRouter([])] }));

  it('shows initials and opens a hover card with name, email and actions', async () => {
    const fixture = TestBed.createComponent(PlainHost);
    await settle(fixture);
    const button = (fixture.nativeElement as HTMLElement).querySelector('button.k-avatar')!;
    expect(button.textContent?.trim()).toBe('MM');
    expect(button.getAttribute('aria-label')).toBe('Mia Member');
    (button as HTMLButtonElement).click();
    await settle(fixture);
    const card = document.querySelector('[role="dialog"][aria-label="Mia Member"]');
    expect(card?.textContent).toContain('mia@example.org');
    expect(card?.textContent).toContain('View all their work');
    // No person filter on this page, so no filter action.
    expect(card?.textContent).not.toContain('Filter board to this person');
    expect(card?.querySelector('a')?.getAttribute('href')).toBe('/people/u7');
  });

  it('filters the board on click where the page has a person filter', async () => {
    const fixture = TestBed.createComponent(FilterHost);
    await settle(fixture);
    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button.k-avatar',
    )!;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    button.click();
    await settle(fixture);
    expect(fixture.componentInstance.toggled).toEqual(['u7']);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.classList).toContain('active');
  });
});

describe('ToastService', () => {
  it('offers Undo and runs it when chosen', async () => {
    const action = new Subject<void>();
    const ref = { onAction: () => action, afterOpened: () => of(), afterDismissed: () => of() };
    const open = vi.fn().mockReturnValue(ref);
    TestBed.configureTestingModule({ providers: [{ provide: MatSnackBar, useValue: { open } }] });
    const toast = TestBed.inject(ToastService);
    const undo = vi.fn().mockResolvedValue(undefined);
    toast.show('KLO-1 moved to Done', undo);
    expect(open).toHaveBeenCalledWith(
      'KLO-1 moved to Done',
      'Undo',
      expect.objectContaining({ politeness: 'polite' }),
    );
    action.next();
    await Promise.resolve();
    expect(undo).toHaveBeenCalled();
  });

  it('dismisses after the delay unless the pointer is on the toast', () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    const opened = new Subject<void>();
    const ref = {
      onAction: () => of(),
      afterOpened: () => opened,
      afterDismissed: () => of(),
      dismiss,
    };
    TestBed.configureTestingModule({
      providers: [{ provide: MatSnackBar, useValue: { open: vi.fn().mockReturnValue(ref) } }],
    });
    const panel = document.createElement('div');
    panel.className = 'mat-mdc-snack-bar-container k-toast';
    document.body.append(panel);
    TestBed.inject(ToastService).show('Saved');
    opened.next();
    panel.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(20_000);
    expect(dismiss).not.toHaveBeenCalled();
    panel.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(6000);
    expect(dismiss).toHaveBeenCalled();
    panel.remove();
    vi.useRealTimers();
  });

  it('shows errors without Undo, assertively', () => {
    const open = vi.fn().mockReturnValue({
      onAction: () => of(),
      afterOpened: () => of(),
      afterDismissed: () => of(),
    });
    TestBed.configureTestingModule({ providers: [{ provide: MatSnackBar, useValue: { open } }] });
    TestBed.inject(ToastService).error('Not allowed');
    expect(open).toHaveBeenCalledWith(
      'Not allowed',
      'Dismiss',
      expect.objectContaining({ politeness: 'assertive' }),
    );
  });
});

describe('Dialogs', () => {
  it('answers true only when the confirm dialog is confirmed', async () => {
    const answers = [true, false, undefined];
    const open = vi.fn(() => ({ afterClosed: () => of(answers.shift()) }));
    TestBed.configureTestingModule({ providers: [{ provide: MatDialog, useValue: { open } }] });
    const dialogs = TestBed.inject(Dialogs);
    const question = { title: 'Delete KLO-1?', message: 'Gone for good.', confirm: 'Delete' };
    expect(await dialogs.confirm(question)).toBe(true);
    expect(await dialogs.confirm(question)).toBe(false);
    expect(await dialogs.confirm(question)).toBe(false);
  });

  it('answers the trimmed prompt value, or null when empty or cancelled', async () => {
    const answers = ['  Team A ', '   ', null];
    const open = vi.fn(() => ({ afterClosed: () => of(answers.shift()) }));
    TestBed.configureTestingModule({ providers: [{ provide: MatDialog, useValue: { open } }] });
    const dialogs = TestBed.inject(Dialogs);
    const question = { title: 'Rename', label: 'Name', confirm: 'Rename' };
    expect(await dialogs.prompt(question)).toBe('Team A');
    expect(await dialogs.prompt(question)).toBeNull();
    expect(await dialogs.prompt(question)).toBeNull();
  });
});

describe('LabelPill and PriorityIcon', () => {
  it('draws a solid label with readable text', async () => {
    const fixture = TestBed.createComponent(LabelPill);
    fixture.componentRef.setInput('name', 'customer');
    fixture.componentRef.setInput('colour', '#F76B15');
    await settle(fixture);
    const pill = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.k-label')!;
    expect(pill.textContent?.trim()).toBe('customer');
    expect(pill.dataset['style']).toBe('SOLID');
    expect(pill.style.getPropertyValue('--l-fg')).toBe('#111827');
  });

  it('names the priority for screen readers', async () => {
    const fixture = TestBed.createComponent(PriorityIcon);
    fixture.componentRef.setInput('priority', 1);
    await settle(fixture);
    const svg = (fixture.nativeElement as HTMLElement).querySelector('svg')!;
    expect(svg.getAttribute('aria-label')).toBe('Priority 1 – Highest');
  });
});
