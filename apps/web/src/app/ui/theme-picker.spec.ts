import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DEFAULT_THEME, type ThemeDto, ThemeMode } from '@kloister/shared';
import { settle } from '../../testing/fixtures';
import { ThemePicker } from './theme-picker';

/** Hosts the picker with two-way binding. */
@Component({
  imports: [ThemePicker],
  template: `<app-theme-picker label="Test theme" [(value)]="theme" />`,
})
class Host {
  /** The bound theme. */
  readonly theme = signal<ThemeDto>(DEFAULT_THEME);
}

describe('ThemePicker', () => {
  it('keeps one tab stop per swatch group and wraps arrow selection', async () => {
    const fixture = TestBed.createComponent(Host);
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    const group = root.querySelector('[aria-label="Test theme Primary colour"]')!;
    const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1);
    radios[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await settle(fixture);
    expect(radios.at(-1)?.getAttribute('aria-checked')).toBe('true');
    expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1);
    radios.at(-1)?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await settle(fixture);
    expect(radios[0]?.getAttribute('aria-checked')).toBe('true');
    fixture.componentInstance.theme.set({ ...DEFAULT_THEME, primary: '#ABCDEF' });
    await settle(fixture);
    expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1);
  });
  it('picks mode, swatches and custom colours, and explains the shown shades', async () => {
    const fixture = TestBed.createComponent(Host);
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    const host = fixture.componentInstance;

    root.querySelectorAll<HTMLButtonElement>('mat-button-toggle button')[1]?.click();
    root
      .querySelector<HTMLButtonElement>(
        '[aria-label="Test theme Accent colour"] [aria-label="Teal"]',
      )
      ?.click();
    await settle(fixture);
    expect(host.theme()).toEqual({ ...DEFAULT_THEME, mode: ThemeMode.LIGHT, accent: '#0F766E' });
    expect(
      root
        .querySelector('[aria-label="Test theme Accent colour"] [aria-label="Teal"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');

    const custom = root.querySelector<HTMLInputElement>('input[type="color"]') as HTMLInputElement;
    custom.value = '#ffff00';
    custom.dispatchEvent(new Event('change'));
    await settle(fixture);
    expect(host.theme().primary).toBe('#FFFF00');
    // Yellow text would be unreadable on light backgrounds: a darker shade is shown.
    expect(root.querySelector('.note')?.textContent).toMatch(
      /^Shown as #[0-9A-F]{6} \(\d+\.\d:1\) in light mode, so text reaches at least 4\.5:1/,
    );
  });
});
