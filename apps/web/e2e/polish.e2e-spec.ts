import { expect, type Page, test } from '@playwright/test';
import { ITEMS, PROJECT_KEY, signIn, USERS } from './support';

/**
 * Records stable, reduced-motion screenshots for the polish review.
 *
 * @param page Browser page.
 * @param name Screen and state.
 * @returns Resolves after attaching the viewport image.
 */
async function snap(page: Page, name: string): Promise<void> {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

/**
 * Checks page reflow independently of the internally scrolling board/tables.
 *
 * @param page Browser page.
 * @returns Resolves once the document width is checked.
 */
async function reflow(page: Page): Promise<void> {
  const size = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(size.scroll).toBeLessThanOrEqual(size.width);
}

test('shortcuts, help, palette and drawer focus paths', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signIn(page, USERS.pm);
  await page.goto(`/p/${PROJECT_KEY}`);
  await expect(page.locator('app-item-card').first()).toBeVisible();
  await page.locator('main').press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toContainText('Move the focused item');
  await snap(page, 'keyboard shortcuts');
  await help.getByRole('switch', { name: 'Enable single-key shortcuts' }).click();
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  await page.locator('main').press('?');
  await expect(help).toHaveCount(0);
  await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
  await help.getByRole('switch', { name: 'Enable single-key shortcuts' }).click();
  await page.keyboard.press('Escape');
  await page.locator('main').press('/');
  const palette = page.getByRole('dialog', { name: 'Search or jump' });
  const search = palette.getByRole('combobox');
  await search.fill('sprints');
  await expect(palette.getByRole('option')).toContainText('Sprints');
  await snap(page, 'command palette screen search');
  await search.fill(`${PROJECT_KEY}-${ITEMS.taskA}`);
  await snap(page, 'command palette item jump');
  await search.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Item details', exact: true });
  await expect(drawer.getByRole('heading', { level: 1 })).toBeVisible();
  await drawer.press('Shift+Tab');
  expect(await page.evaluate(() => document.activeElement?.closest('.d-panel') !== null)).toBe(
    true,
  );
  await drawer.press('m');
  await expect(page.getByRole('listbox', { name: 'Bucket' })).toBeVisible();
  await page.keyboard.press('Escape');
  await drawer.press('a');
  await expect(page.getByRole('listbox', { name: 'Assignees' })).toBeVisible();
  await page.keyboard.press('Escape');
  await drawer.press('l');
  await expect(page.getByRole('listbox', { name: 'Labels' })).toBeVisible();
  await page.keyboard.press('Escape');
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await page.locator('main').press('j');
  const first = await page.evaluate(() => document.activeElement?.getAttribute('href'));
  await page.keyboard.press('j');
  const next = await page.evaluate(() => document.activeElement?.getAttribute('href'));
  expect(next).not.toBe(first);
  await page.keyboard.press('k');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('href'))).toBe(first);
  await page.keyboard.press('Enter');
  await expect(drawer).toBeVisible();
  // Visibility precedes the CDK's deferred focus capture on route entry.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('.d-panel') !== null))
    .toBe(true);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.matches('app-item-card a.title'))).toBe(
    true,
  );
  await page.keyboard.press('c');
  await expect(page.getByRole('dialog', { name: 'New item', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('c / ? j k m a l');
  await expect(page.getByRole('dialog', { name: 'New item', exact: true })).toBeVisible();
  await snap(page, 'create shortcut and text entry');
  await page.keyboard.press('Escape');
});

test('tablet rail and phone menu retain names and contain focus', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signIn(page, USERS.pm);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto(`/p/${PROJECT_KEY}`);
  await expect(page.locator('app-item-card').first()).toBeVisible();
  expect(
    await page.locator('.sidebar').evaluate((el) => Math.round(el.getBoundingClientRect().width)),
  ).toBe(72);
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'My work' }),
  ).toBeVisible();
  await reflow(page);
  await snap(page, 'tablet sidebar collapsed to icons');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('button', { name: 'Account menu' }).focus();
  await page.keyboard.press('Tab');
  await expect(nav.getByRole('button', { name: 'Close menu' })).toBeFocused();
  await snap(page, 'phone menu keyboard focus');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toBeFocused();
});

test('sign-in and forced password screens reflow with accessible headings', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const mode of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: mode });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await snap(page, `sign-in, phone, ${mode}`);
    await page.setViewportSize({ width: 320, height: 844 });
    await reflow(page);
  }
  await signIn(page, USERS.pm);
  // Render the existing forced-change state without changing a credential.
  await page.route('**/api/v1/me', async (route) => {
    const response = await route.fetch();
    const user = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...user, mustChangePassword: true } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Change password', exact: true })).toBeVisible();
  await expect(page.getByText('You signed in with a temporary password.')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await reflow(page);
  await snap(page, 'forced password change, 320 pixels');
});

test('every main screen reflows at phone width and in dark mode', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signIn(page, USERS.admin);
  const me = (await (await page.request.get('api/v1/me')).json()) as { id: string };
  const screens = [
    ['projects', '/', 'Projects'],
    ['board', `/p/${PROJECT_KEY}`, 'Demo project'],
    ['backlog', `/p/${PROJECT_KEY}/backlog`, 'Demo project'],
    ['sprints', `/p/${PROJECT_KEY}/sprints`, 'Demo project'],
    ['project settings', `/p/${PROJECT_KEY}/settings`, 'Demo project'],
    ['work', `/people/${me.id}`, 'My work'],
    ['notifications', '/notifications', 'Notifications'],
    ['account settings', '/settings', 'Settings and theme'],
    ['users', '/admin/users', 'Users'],
    ['audit', '/admin/audit', 'Audit log'],
    ...['branding', 'security', 'storage', 'backups', 'logs'].map((tab) => [
      `admin ${tab}`,
      `/admin/settings/${tab}`,
      'Settings',
    ]),
    ['password', '/change-password', 'Change password'],
  ];
  const roots: Record<string, string> = {
    projects: 'app-projects',
    board: 'app-board',
    backlog: 'app-backlog',
    sprints: 'app-sprints',
    'project settings': 'app-project-settings',
    work: 'app-work',
    notifications: 'app-notifications-page',
    'account settings': 'app-account-settings',
    users: 'app-admin-users',
    audit: 'app-admin-audit',
    password: 'app-change-password',
  };
  for (const mode of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: mode });
    for (const [name, path, heading] of screens) {
      if (!path || !heading) throw new Error('Missing screen');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(path);
      const root = name?.startsWith('admin ') ? 'app-admin-' + name.slice(6) : roots[name ?? ''];
      if (!root) throw new Error('Missing screen root');
      await expect(page.locator(root)).toBeVisible();
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      await expect(page.locator('app-skeleton')).toHaveCount(0);
      await reflow(page);
      await snap(page, `${name}, phone, ${mode}`);
      if (name === 'admin branding') {
        await page.getByRole('heading', { name: 'UI font', exact: true }).scrollIntoViewIfNeeded();
        await snap(page, `font samples, phone, ${mode}`);
      }
      await page.setViewportSize({ width: 320, height: 844 });
      await reflow(page);
    }
  }
  // A 780-pixel browser at 200% zoom has the same CSS layout width as 390.
  await page.setViewportSize({ width: 390, height: 422 });
  await page.goto('/admin/settings/branding');
  await expect(page.getByRole('heading', { name: 'UI font', exact: true })).toBeVisible();
  await reflow(page);
  await snap(page, 'branding at effective 200 percent viewport');
});

test('keyboard order controls and caret mentions work without dragging', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signIn(page, USERS.pm);
  await page.goto(`/p/${PROJECT_KEY}/items/${ITEMS.taskA}`);
  const drawer = page.getByRole('dialog', { name: 'Item details', exact: true });
  const order = drawer.getByRole('combobox', { name: 'Position in bucket', exact: true });
  await order.click();
  await page.getByRole('option', { name: 'At the top', exact: true }).click();
  await expect(
    page.locator('.k-toast', { hasText: `${PROJECT_KEY}-${ITEMS.taskA} reordered` }),
  ).toBeVisible();
  await snap(page, 'keyboard card order');
  await page
    .locator('.k-toast', { hasText: `${PROJECT_KEY}-${ITEMS.taskA} reordered` })
    .getByRole('button', { name: 'Undo' })
    .click();
  const line = drawer.getByRole('textbox', { name: 'New checklist line' });
  await line.fill('Polish order first');
  await line.press('Enter');
  await expect(
    drawer.getByRole('textbox', { name: 'Checklist line Polish order first', exact: true }),
  ).toBeVisible();
  await expect(line).toHaveValue('');
  await line.fill('Polish order second');
  await line.press('Enter');
  await expect(
    drawer.getByRole('textbox', { name: 'Checklist line Polish order second', exact: true }),
  ).toBeVisible();
  await expect(line).toHaveValue('');
  await drawer.getByRole('button', { name: 'Move up: Polish order second' }).click();
  await expect(drawer.locator('app-item-checklist li').first().getByRole('textbox')).toHaveValue(
    'Polish order second',
  );
  await snap(page, 'keyboard checklist order');
  await drawer.getByRole('button', { name: 'Delete Polish order first', exact: true }).click();
  await expect(
    drawer.getByRole('textbox', { name: 'Checklist line Polish order first', exact: true }),
  ).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Delete Polish order second', exact: true }).click();
  await expect(
    drawer.getByRole('textbox', { name: 'Checklist line Polish order second', exact: true }),
  ).toHaveCount(0);
  const composer = drawer.getByRole('textbox', { name: 'New note', exact: true });
  await composer.pressSequentially('Thanks @Mi');
  const people = page.getByRole('listbox', { name: 'People' });
  await expect(people.getByRole('option', { name: 'Mia Member' })).toBeVisible();
  const area = await composer.boundingBox();
  const popup = await people.boundingBox();
  if (!area || !popup) throw new Error('Missing mention geometry');
  expect(popup.x).toBeGreaterThanOrEqual(area.x);
  expect(popup.y).toBeLessThan(area.y + area.height);
  await snap(page, 'mention list at the caret');
  await composer.press('Escape');
  await composer.press('Escape');
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await page.context().clearCookies();
  await signIn(page, USERS.viewer);
  await page.goto(`/p/${PROJECT_KEY}/items/${ITEMS.taskA}`);
  await expect(drawer.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(drawer.getByRole('combobox', { name: 'Position in bucket' })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: /Move (up|down):/ })).toHaveCount(0);
  await snap(page, 'read-only drawer without ordering controls');
});

test('theme swatches use radio navigation and admin previews restore personal themes', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signIn(page, USERS.admin);
  await page.goto('/settings');
  await page.getByRole('radio', { name: 'Use my own theme' }).check();
  const group = page.getByRole('radiogroup', { name: 'Your theme Primary colour' });
  await expect(group.locator('[tabindex="0"]')).toHaveCount(1);
  await group.getByRole('radio', { name: 'Indigo' }).press('ArrowRight');
  await expect(group.getByRole('radio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: 'Dark', exact: true }).click();
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  await expect(page.locator('.k-toast', { hasText: 'Your theme is saved' })).toBeVisible();
  await page.goto('/admin/settings/branding');
  await page.getByRole('radio', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await snap(page, 'admin default preview with personal theme');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.goto('/settings');
  await page.getByRole('radio', { name: 'Use the default theme' }).check();
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  await expect(
    page.locator('.k-toast', { hasText: 'You use the default theme again' }),
  ).toBeVisible();
});

test('a thousand-card board filters, scrolls and has a keyboard path to the last card', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signIn(page, USERS.pm);
  // Keep the real project/capabilities and replace only the paginated item
  // transport for a reproducible large-board fixture without 1,000 writes.
  const project = (await (await page.request.get(`api/v1/projects/${PROJECT_KEY}`)).json()) as {
    id: string;
  };
  const source = (await (
    await page.request.get(`api/v1/projects/${project.id}/items/${ITEMS.taskA}`)
  ).json()) as { bucketId: string };
  await page.route(`**/api/v1/projects/${project.id}/items?**`, async (route) => {
    await route.fulfill({
      json: {
        items: Array.from({ length: 1000 }, (_, i) => ({
          ...source,
          id: `large-${i}`,
          number: 10000 + i,
          key: `${PROJECT_KEY}-${10000 + i}`,
          title: `Performance card ${i + 1}`,
          position: i,
        })),
        nextCursor: null,
      },
    });
  });
  await page.goto(`/p/${PROJECT_KEY}`);
  await expect(page.locator('app-item-card')).toHaveCount(1000);
  const timings = await page.evaluate(async () => {
    const frames: number[] = [];
    let previous = performance.now();
    for (let i = 0; i < 60; i++) {
      window.scrollBy(0, 80);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const now = performance.now();
      frames.push(now - previous);
      previous = now;
    }
    return { p95: frames.sort((a, b) => a - b)[57], max: Math.max(...frames) };
  });
  await test.info().attach('large-board frame timings', {
    body: JSON.stringify(timings),
    contentType: 'application/json',
  });
  await page.getByLabel('Search cards', { exact: true }).fill('Performance card 1000');
  await expect(page.locator('app-item-card')).toHaveCount(1);
  await snap(page, 'large board filtered to last card');
  await page.getByLabel('Search cards', { exact: true }).fill('');
  await expect(page.locator('app-item-card')).toHaveCount(1000);
  await page.getByRole('link', { name: 'Performance card 1000', exact: true }).focus();
  await expect(
    page.getByRole('link', { name: 'Performance card 1000', exact: true }),
  ).toBeFocused();
  await snap(page, 'large board last card keyboard focus');
  await reflow(page);
});
