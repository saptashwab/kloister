import type { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  type ActivatedRouteSnapshot,
  provideRouter,
  Router,
  withComponentInputBinding,
  withRouterConfig,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { makeProject } from '../testing/fixtures';
import { routes } from './app.routes';
import { ItemsApiService } from './core/items-api.service';
import { ProjectsApiService } from './core/projects-api.service';
import { SessionStore } from './core/session.store';
import { BacklogPage } from './pages/backlog/backlog';
import { BoardPage } from './pages/board/board';
import { ItemDrawer } from './pages/item-drawer/item-drawer';
import { ProjectSettingsPage } from './pages/project-settings/project-settings';
import { SprintsPage } from './pages/sprints/sprints';

/**
 * Follows the first child down to the deepest activated route.
 *
 * @param route The root snapshot.
 * @returns The leaf snapshot.
 */
function leaf(route: ActivatedRouteSnapshot): ActivatedRouteSnapshot {
  let current = route;
  while (current.firstChild !== null) current = current.firstChild;
  return current;
}

describe('project routes', () => {
  beforeEach(async () => {
    // Every call answers with empty data; the tests only look at routing.
    const empty = () => Promise.resolve({ items: [], nextCursor: null });
    await TestBed.configureTestingModule({
      providers: [
        provideRouter(
          routes,
          withComponentInputBinding(),
          withRouterConfig({ paramsInheritanceStrategy: 'always' }),
        ),
        {
          provide: ProjectsApiService,
          useValue: { get: () => Promise.resolve(makeProject()), members: empty, teams: empty },
        },
        {
          provide: ItemsApiService,
          useValue: new Proxy(
            {},
            {
              get: () => () => Promise.resolve([]),
            },
          ),
        },
      ],
    }).compileComponents();
    TestBed.inject(SessionStore).set({
      id: 'u1',
      email: 'ann@example.org',
      displayName: 'Ann',
      systemRole: 'USER',
      mustChangePassword: false,
      isActive: true,
      lastLoginAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it.each<[string, Type<unknown>, Record<string, string>]>([
    ['/p/KLO', BoardPage, {}],
    ['/p/KLO/items/42', ItemDrawer, { key: 'KLO', number: '42' }],
    ['/p/KLO/backlog', BacklogPage, {}],
    ['/p/KLO/backlog/items/7', ItemDrawer, { key: 'KLO', number: '7' }],
    ['/p/KLO/sprints', SprintsPage, {}],
    ['/p/KLO/settings/members', ProjectSettingsPage, { key: 'KLO', section: 'members' }],
  ])('%s', async (url, component, params) => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    const router = TestBed.inject(Router);
    expect(router.url).toBe(url);
    const snapshot = router.routerState.snapshot.root;
    // Below the board and backlog, the leaf is the empty "no drawer" route.
    expect(collect(snapshot).map((r) => r.component)).toContain(component);
    expect(leaf(snapshot).params).toMatchObject(params);
  });

  it('opens the first settings tab from the old settings link (M8.5)', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/p/KLO/settings');
    expect(TestBed.inject(Router).url).toBe('/p/KLO/settings/general');
  });
});

/**
 * Lists every snapshot on the first-child chain.
 *
 * @param route The root snapshot.
 * @returns The chain.
 */
function collect(route: ActivatedRouteSnapshot): ActivatedRouteSnapshot[] {
  const chain: ActivatedRouteSnapshot[] = [];
  let current: ActivatedRouteSnapshot | null = route;
  while (current !== null) {
    chain.push(current);
    current = current.firstChild;
  }
  return chain;
}
