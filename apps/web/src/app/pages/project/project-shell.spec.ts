import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { makeProject, settle } from '../../../testing/fixtures';
import { Layout } from '../../core/layout';
import { PageActions } from '../../core/page-actions';
import { ProjectContext } from '../../core/project-context';
import { RescheduleFlow } from '../../core/reschedule';
import { ProjectShellPage } from './project-shell';

describe('ProjectShellPage folding (v1.4.0)', () => {
  beforeEach(() => {
    localStorage.removeItem('k-fold');
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    TestBed.overrideComponent(ProjectShellPage, {
      set: {
        providers: [
          {
            provide: ProjectContext,
            useValue: {
              project: signal(makeProject({ key: 'KLO', name: 'Demo project' })),
              presence: signal([]),
              membersById: signal(new Map()),
              lost: signal(''),
              has: () => true,
              writable: () => true,
              open: () => Promise.resolve(),
              refresh: () => Promise.resolve(),
            },
          },
          PageActions,
          { provide: RescheduleFlow, useValue: {} },
        ],
      },
    });
  });

  afterEach(() => localStorage.removeItem('k-fold'));

  /**
   * Renders the shell; the open view's toolbar is stood in by an element
   * marked `k-page-tools`, and its registration by the shell's page actions.
   */
  async function render() {
    const fixture = TestBed.createComponent(ProjectShellPage);
    fixture.componentRef.setInput('key', 'KLO');
    fixture.debugElement.injector.get(PageActions).export.set({
      source: 'p1',
      filters: {},
      tools: true,
      activeFilters: 2,
    });
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    const tools = document.createElement('div');
    tools.className = 'k-page-tools';
    root.querySelector('mat-tab-nav-panel')?.append(tools);
    const button = (label: string) =>
      root.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    return { fixture, root, tools, button };
  }

  it('folds the header into one slim row and keeps it open again with the pin', async () => {
    const { fixture, root, button } = await render();
    expect(root.querySelector('.head h1')?.textContent).toContain('Demo project');
    button('Fold the header and toolbar')!.click();
    await settle(fixture);
    expect(TestBed.inject(Layout).folded()).toBe(true);
    expect(root.classList).toContain('k-folded');
    expect(root.querySelector('.head')).toBeNull();
    expect(root.querySelector('.slim-name')?.textContent).toContain('Demo project');
    // Icon-only actions; the active filters are a chip.
    expect(button('New item')).not.toBeNull();
    expect(button('Export…')).not.toBeNull();
    expect(root.querySelector('.fold-controls .k-chip')?.textContent).toContain('2 filters');
    button('Keep the header and toolbar open')!.click();
    await settle(fixture);
    expect(TestBed.inject(Layout).folded()).toBe(false);
    expect(root.querySelector('.head')).not.toBeNull();
  });

  it('keeps focus on the fold button as it folds and unfolds', async () => {
    const { fixture, button } = await render();
    const fold = button('Fold the header and toolbar')!;
    fold.focus();
    fold.click();
    await settle(fixture);
    // The same button, now the pin.
    expect(button('Keep the header and toolbar open')).toBe(fold);
    expect(document.activeElement).toBe(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('false');
  });

  it('moves focus to the fold button when the header it was in folds away', async () => {
    const { fixture, button } = await render();
    button('Search or jump')!.focus();
    TestBed.inject(Layout).setFolded(true);
    await settle(fixture);
    expect(document.activeElement).toBe(button('Keep the header and toolbar open'));
  });

  it('keeps the peek for Escape meant for an open list, and folds it when focus moves past', async () => {
    TestBed.inject(Layout).setFolded(true);
    const { fixture, root, button } = await render();
    button('Show the toolbar')!.click();
    await settle(fixture);
    const overlay = document.createElement('div');
    overlay.className = 'cdk-overlay-container';
    overlay.innerHTML = '<div class="cdk-overlay-pane"><div role="listbox"></div></div>';
    document.body.append(overlay);
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(fixture);
      expect(root.classList).toContain('k-peek');
    } finally {
      overlay.remove();
    }
    const outside = document.createElement('button');
    document.body.append(outside);
    try {
      outside.focus();
      await settle(fixture);
      expect(root.classList).not.toContain('k-peek');
    } finally {
      outside.remove();
    }
  });

  it('shows the toolbar over the page until a press elsewhere or Escape', async () => {
    TestBed.inject(Layout).setFolded(true);
    const { fixture, root, tools, button } = await render();
    button('Show the toolbar')!.click();
    await settle(fixture);
    expect(root.classList).toContain('k-peek');
    expect(button('Hide the toolbar')?.getAttribute('aria-expanded')).toBe('true');
    // Pressing inside the toolbar keeps it.
    tools.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await settle(fixture);
    expect(root.classList).toContain('k-peek');
    // Pressing on the page folds it again.
    root.querySelector('nav')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await settle(fixture);
    expect(root.classList).not.toContain('k-peek');
    // The filter chip opens it too; Escape folds it.
    root.querySelector<HTMLButtonElement>('.fold-controls .k-chip')!.click();
    await settle(fixture);
    expect(root.classList).toContain('k-peek');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(fixture);
    expect(root.classList).not.toContain('k-peek');
  });
});
