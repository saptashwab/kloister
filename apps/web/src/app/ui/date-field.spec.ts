import { TestBed } from '@angular/core/testing';
import { settle } from '../../testing/fixtures';
import {
  AppDateAdapter,
  DATE_PLACEHOLDER,
  DateField,
  localDay,
  TIME_PANEL_CLASS,
  TimeField,
} from './date-field';

describe('AppDateAdapter', () => {
  it('reads numeric dates day first and keeps the named and ISO forms', () => {
    TestBed.configureTestingModule({ providers: [AppDateAdapter] });
    const adapter = TestBed.inject(AppDateAdapter);
    expect(adapter.parse('15/03/2030')).toEqual(localDay('2030-03-15'));
    expect(adapter.parse('6.1.2026')).toEqual(localDay('2026-01-06'));
    expect(adapter.parse('15 Mar 2030')).toEqual(localDay('2030-03-15'));
    expect(adapter.parse('2030-03-15')).toEqual(localDay('2030-03-15'));
    expect(adapter.isValid(adapter.parse('30/02/2026') as Date)).toBe(false);
    expect(adapter.parse('  ')).toBeNull();
    expect(adapter.format(localDay('2030-03-15'), 'day')).toBe('15 Mar 2030');
  });
});

describe('DateField', () => {
  async function render() {
    await TestBed.configureTestingModule({ imports: [DateField] }).compileComponents();
    const fixture = TestBed.createComponent(DateField);
    fixture.componentRef.setInput('label', 'Due date');
    await settle(fixture);
    const input = (fixture.nativeElement as HTMLElement).querySelector('input')!;
    return { fixture, input };
  }

  it('shows dd/mm/yyyy while empty and emits a typed day-first date', async () => {
    const { fixture, input } = await render();
    expect(DATE_PLACEHOLDER).toBe('dd/mm/yyyy');
    expect(input.placeholder).toBe('dd/mm/yyyy');
    const toggle = (fixture.nativeElement as HTMLElement).querySelector(
      'mat-datepicker-toggle button',
    )!;
    expect(toggle.getAttribute('aria-label')).toBe('Choose Due date');
    const emitted: (string | null)[] = [];
    fixture.componentInstance.valueChange.subscribe((v) => emitted.push(v));
    input.value = '15/03/2030';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
    input.dispatchEvent(new Event('blur'));
    await settle(fixture);
    expect(emitted).toEqual(['2030-03-15']);
    expect(input.value).toBe('15 Mar 2030');
  });
});

describe('TimeField', () => {
  it('opens its time list in a pane with the widening class', async () => {
    await TestBed.configureTestingModule({ imports: [TimeField] }).compileComponents();
    const fixture = TestBed.createComponent(TimeField);
    fixture.componentRef.setInput('label', 'Due time');
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('input')!.placeholder).toBe('hh:mm');
    const toggle = host.querySelector<HTMLButtonElement>('mat-timepicker-toggle button')!;
    expect(toggle.getAttribute('aria-label')).toBe('Choose Due time');
    toggle.click();
    await settle(fixture);
    const pane = document.querySelector(`.cdk-overlay-pane.${TIME_PANEL_CLASS}`);
    expect(pane).not.toBeNull();
    expect(pane!.textContent).toContain('23:30');
  });
});
