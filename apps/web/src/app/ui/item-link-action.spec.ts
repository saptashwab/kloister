import { Clipboard } from '@angular/cdk/clipboard';
import { APP_BASE_HREF, Location } from '@angular/common';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { makeItem, makeProject, settle } from '../../testing/fixtures';
import { ProjectContext } from '../core/project-context';
import { ItemLinkAction, itemUrl } from './item-link-action';
import { ToastService } from './toast.service';

describe('Copy link (v1.4.0)', () => {
  /**
   * Sets up the router under an app prefix, as installed under /kloister/.
   *
   * @param key The project key, or null for the personal space.
   * @returns The copied texts and toasts.
   */
  function setup(key: string | null) {
    const copied: string[] = [];
    const toasts: string[] = [];
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: APP_BASE_HREF, useValue: '/kloister/' },
        { provide: ProjectContext, useValue: { project: signal(makeProject({ key })) } },
        { provide: Clipboard, useValue: { copy: (text: string) => copied.push(text) > 0 } },
        {
          provide: ToastService,
          useValue: { show: (t: string) => toasts.push(t), error: () => 0 },
        },
      ],
    });
    return { copied, toasts };
  }

  it('builds the absolute deep link with the app prefix', () => {
    setup('KLO');
    const url = itemUrl(
      TestBed.inject(Router),
      TestBed.inject(Location),
      'KLO',
      12,
      'https://example.org',
    );
    expect(url).toBe('https://example.org/kloister/p/KLO/items/12');
    expect(
      itemUrl(TestBed.inject(Router), TestBed.inject(Location), null, 3, 'https://example.org'),
    ).toBe('https://example.org/kloister/p/personal/items/3');
  });

  it('copies the link from the keyboard-reachable button and says so', async () => {
    const { copied, toasts } = setup('KLO');
    const fixture = TestBed.createComponent(ItemLinkAction);
    fixture.componentRef.setInput('item', makeItem(7));
    await settle(fixture);
    const button = (fixture.nativeElement as HTMLElement).querySelector('button')!;
    expect(button.getAttribute('aria-label')).toBe('Copy link');
    button.click();
    expect(copied).toEqual([`${window.location.origin}/kloister/p/KLO/items/7`]);
    expect(toasts).toEqual(['Link copied']);
  });
});
