import { expect, test, type Page, type Locator } from '@playwright/test';
import type { BucketDto, ProjectDto, UserDto, WorkItemDetailDto } from '@kloister/shared';
import { choose, signIn, USERS } from './support';

const headers = { 'x-requested-with': 'kloister' };

/** Creates disposable example data through the real API, scoped to this scenario.
 * @param page Signed-in administrator browser.
 * @param key Unique project key.
 * @returns Project and its initial buckets.
 */
async function project(
  page: Page,
  key: string,
): Promise<{ project: ProjectDto; buckets: BucketDto[] }> {
  const me = (await (await page.request.get('api/v1/me')).json()) as UserDto;
  const created = await page.request.post('api/v1/projects', {
    headers,
    data: { key, name: 'Example UI checks', pmUserIds: [me.id] },
  });
  expect(created.status()).toBe(201);
  const data = (await created.json()) as ProjectDto;
  const buckets = (await (await page.request.get(`api/v1/projects/${data.id}/buckets`)).json()) as {
    items: BucketDto[];
  };
  return { project: data, buckets: buckets.items };
}

/** Drags from a card or header to an actual pointer coordinate, including scrolling.
 * @param page Browser page.
 * @param source Drag handle or card.
 * @param target Destination region.
 * @returns Resolves after releasing the pointer.
 */
async function dragTo(page: Page, source: Locator, target: Locator): Promise<void> {
  // CDK previews and closing menu backdrops can still intercept the next
  // gesture after optimistic text has already reached its destination.
  await expect(page.locator('.cdk-overlay-backdrop')).toHaveCount(0);
  await expect(page.locator('.cdk-drag-preview, .cdk-drag-placeholder')).toHaveCount(0);
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  if (!from) throw new Error('Missing drag source');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 8, { steps: 5 });
  await target.scrollIntoViewIfNeeded();
  const to = await target.boundingBox();
  if (!to) throw new Error('Missing drop target');
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 25 });
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/(?:items|buckets)\/[^/]+\/move$/.test(new URL(response.url()).pathname),
  );
  await page.mouse.up();
  await saved;
  await expect(page.locator('.cdk-drag-preview, .cdk-drag-placeholder')).toHaveCount(0);
}

/** Attaches synthetic screenshots to the CI report.
 * @param page Browser page.
 * @param name Evidence name.
 * @returns Resolves after attachment.
 */
async function snap(page: Page, name: string): Promise<void> {
  await test
    .info()
    .attach(name, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
}

test('board bucket top bars and keyboard controls persist the same order as Settings', async ({
  page,
}) => {
  await signIn(page, USERS.admin);
  const { project: p } = await project(page, 'UIBUCK');
  await page.goto(`/p/${p.key}`);
  await page.getByRole('button', { name: '+ Add bucket', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add bucket', exact: true });
  await dialog.getByLabel('Bucket name').fill('Review');
  await dialog.getByRole('button', { name: 'Add bucket', exact: true }).click();
  await page.getByRole('button', { name: 'Bucket actions for Review', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Move left', exact: true }).click();
  await expect(page.locator('section.column').nth(3)).toHaveAttribute('aria-label', 'Review');
  await dragTo(
    page,
    page.locator('section.column[aria-label="Review"] h2'),
    page.locator('section.column').first().locator('h2'),
  );
  await expect(page.locator('section.column').first()).toHaveAttribute('aria-label', 'Review');
  await page.locator('section.column[aria-label="Review"] h2 span').first().dblclick();
  const rename = page.getByRole('dialog', { name: 'Rename bucket', exact: true });
  await rename.getByLabel('Bucket name').fill('Review renamed');
  await rename.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.locator('section.column').first()).toHaveAttribute(
    'aria-label',
    'Review renamed',
  );
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Buckets', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'Name of Review renamed', exact: true }),
  ).toBeVisible();
  expect(await page.locator('input[aria-label^="Name of"]').first().inputValue()).toBe(
    'Review renamed',
  );
  await page.reload();
  expect(await page.locator('input[aria-label^="Name of"]').first().inputValue()).toBe(
    'Review renamed',
  );
  // Empty labels use a full-width row; populated labels retain their normal layout.
  const empty = page.locator('.labels-empty');
  await expect(empty).toContainText('No labels yet');
  expect((await empty.boundingBox())?.width).toBeGreaterThan(250);
  await snap(page, 'empty labels and shared bucket order');
  const archived = await page.request.post(`api/v1/projects/${p.id}/archive`, { headers });
  expect(archived.ok()).toBe(true);
  await page.goto(`/p/${p.key}`);
  await expect(page.getByRole('button', { name: '+ Add bucket', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Bucket actions for/ })).toHaveCount(0);
});

test('cards append to short, empty and long columns without column drags and roll back refusal', async ({
  page,
}) => {
  await signIn(page, USERS.admin);
  const { project: p, buckets } = await project(page, 'UIDROP');
  const made: WorkItemDetailDto[] = [];
  for (let n = 0; n < 10; n++) {
    const r = await page.request.post(`api/v1/projects/${p.id}/items`, {
      headers,
      data: {
        type: 'TASK',
        title: `Example card ${n}`,
        bucketId: n === 0 ? buckets[0].id : buckets[1].id,
      },
    });
    expect(r.status()).toBe(201);
    made.push((await r.json()) as WorkItemDetailDto);
  }
  await page.goto(`/p/${p.key}`);
  await expect(page.locator('section.column')).toHaveCount(4);
  const column = (name: string) => page.locator(`section.column[aria-label="${name}"]`);
  const card = (title: string) => page.locator('app-item-card', { hasText: title });
  const originalOrder = await page
    .locator('section.column')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label')));
  await dragTo(page, card('Example card 0'), column('In Progress').locator('.drop-tail'));
  await expect(column('In Progress')).toContainText('Example card 0');
  await dragTo(page, card('Example card 0'), column('To Do').locator('.drop-tail'));
  await expect(column('To Do').locator('app-item-card').last()).toContainText('Example card 0');
  await page.reload();
  await expect(column('To Do').locator('app-item-card').last()).toContainText('Example card 0');
  await dragTo(page, card('Example card 9'), column('To Do').locator('.drop-tail'));
  await expect(column('To Do').locator('app-item-card').last()).toContainText('Example card 9');
  await page.getByLabel('Search cards', { exact: true }).fill('Example card 0');
  await page.route('**/items/*/move', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'FORBIDDEN', message: 'Example refusal' }),
    }),
  );
  await dragTo(page, card('Example card 0'), column('Done').locator('.drop-tail'));
  await expect(page.locator('.k-toast').filter({ hasText: 'Example refusal' })).toBeVisible();
  await expect(column('To Do')).toContainText('Example card 0');
  expect(
    await page
      .locator('section.column')
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label'))),
  ).toEqual(originalOrder);
  await snap(page, 'long-column bottom drop and filtered refusal');
});

test('unified user search preserves PM chips and invalidates edited member choices', async ({
  page,
}) => {
  await signIn(page, USERS.admin);
  const picker = page.locator('app-user-picker');
  await picker.getByRole('combobox', { name: 'Project Managers', exact: true }).fill('pm@');
  await picker.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('option', { name: /pm@example.org/ }).click();
  await picker.getByRole('combobox').fill('admin@');
  await picker.getByRole('combobox').press('Enter');
  await page.getByRole('option', { name: /admin@example.org/ }).click();
  await expect(picker.locator('.picked button')).toHaveCount(2);
  await snap(page, 'multiple project managers retained across searches');
  const { project: p } = await project(page, 'UIUSER');
  await page.goto(`/p/${p.key}/settings/members`);
  const memberPicker = page.locator('app-user-picker').first();
  const input = memberPicker.getByRole('combobox', { name: 'User', exact: true });
  await input.fill('pm@');
  await input.press('Enter');
  await expect(page.getByRole('option', { name: /pm@example.org/ })).toBeVisible();
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  const add = page.getByRole('button', { name: 'Add', exact: true });
  await expect(add).toBeEnabled();
  await input.fill('changed');
  await expect(add).toBeDisabled();
  await memberPicker.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('option', { name: 'No matching users' })).toBeVisible();
  await page.keyboard.press('Escape');
  let releaseOld: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  await page.route('**/member-candidates?*', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q');
    if (q === 'old') {
      await held;
      await route.fulfill({
        json: [{ id: 'old', displayName: 'Old answer', email: 'old@example.org' }],
      });
    } else {
      await route.fulfill({
        json: [{ id: 'new', displayName: 'New answer', email: 'new@example.org' }],
      });
    }
  });
  await input.fill('old');
  const started = page.waitForRequest('**/member-candidates?q=old');
  await input.press('Enter');
  await started;
  await input.fill('new');
  await input.press('Enter');
  await expect(page.getByRole('option', { name: /New answer/ })).toBeVisible();
  const oldResponse = page.waitForResponse('**/member-candidates?q=old');
  releaseOld();
  await oldResponse;
  await expect(page.getByRole('option', { name: /New answer/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Old answer/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.unroute('**/member-candidates?*');
  const themed = await page.request.put('api/v1/me/theme', {
    headers,
    data: { mode: 'DARK', primary: '#8e44ad', accent: '#f0b429' },
  });
  expect(themed.ok()).toBe(true);
  // Buckets are on their own settings tab (M8.5); a full load also applies the theme.
  await page.goto(`/p/${p.key}/settings/buckets`);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const deleteBucket = async (name: string): Promise<void> => {
    await page.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
  };
  await deleteBucket('Backlog');
  await choose(page, 'Destination bucket', 'To Do');
  await deleteBucket('Done');
  await expect(
    page.getByRole('combobox', { name: 'Bucket receiving the cards', exact: true }),
  ).toContainText('Choose destination bucket');
  await expect(page.getByRole('button', { name: 'Delete bucket', exact: true })).toBeDisabled();
  for (const width of [390, 800]) {
    await page.setViewportSize({ width, height: 900 });
    await snap(page, `label empty state and delete destination at ${width}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.goto('/notifications');
  await expect(page.locator('.n-list')).toBeVisible();
  const head = await page.locator('.notifications-page header').boundingBox();
  const list = await page.locator('.n-list').boundingBox();
  expect(head && list && Math.abs(head.width - list.width)).toBeLessThan(2);
  await snap(page, 'aligned notification header and content');
  await page.request.delete('api/v1/me/theme', { headers });
});

test('Viewers cannot manage buckets through the UI or existing API', async ({ page }) => {
  await signIn(page, USERS.viewer);
  await page.goto('/p/KLO');
  await expect(page.getByRole('button', { name: '+ Add bucket', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Bucket actions for/ })).toHaveCount(0);
  const r = await page.request.post('api/v1/projects/KLO/buckets', {
    headers,
    data: { name: 'Denied' },
  });
  expect(r.status()).toBe(403);
  // A Viewer in an ordinary project still manages their own private space.
  await page.goto('/p/personal');
  await expect(page.getByRole('button', { name: '+ Add bucket', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Bucket actions for Backlog', exact: true }),
  ).toBeVisible();
});
