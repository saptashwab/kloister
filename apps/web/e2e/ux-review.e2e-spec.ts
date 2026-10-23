import { expect, test, type Page } from '@playwright/test';
import type { WorkItemDetailDto } from '@kloister/shared';
import { ITEMS, PROJECT_KEY, signIn, USERS } from './support';

// M8.5 screens: phone cards for wide tables, the readable audit log, the
// date picker and due time, settings tabs, the Projects list summary, the
// page-actions Export… and the branded sign-in heading.

const headers = { 'x-requested-with': 'kloister' };

/**
 * Attaches a full-page screenshot to the CI report.
 *
 * @param page Browser page.
 * @param name Attachment name.
 * @returns Resolves after attaching.
 */
async function snap(page: Page, name: string): Promise<void> {
  await test
    .info()
    .attach(name, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
}

/**
 * Reads one seeded item through the API.
 *
 * @param page Signed-in browser.
 * @param number Item number in the seeded project.
 * @returns The item.
 */
async function itemOf(page: Page, number: number): Promise<WorkItemDetailDto> {
  const res = await page.request.get(`api/v1/projects/${PROJECT_KEY}/items/${number}`);
  expect(res.status()).toBe(200);
  return (await res.json()) as WorkItemDetailDto;
}

test('sign-in names the app and wide tables become cards at phone width', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: /^Sign in to / })).toBeVisible();
  await snap(page, 'branded sign-in');
  await signIn(page, USERS.admin);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, list] of [
    ['/admin/users', 'Users'],
    ['/admin/audit', 'Audit entries'],
    ['/', 'Projects'],
  ] as const) {
    await page.goto(path);
    await expect(page.locator('app-skeleton')).toHaveCount(0);
    await expect(page.getByRole('list', { name: list, exact: true })).toBeVisible();
    await expect(page.locator('table.data')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await snap(page, `${list} as cards at phone width`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/admin/users');
  await expect(page.locator('table.data')).toBeVisible();
});

test('the audit log reads as words and records one entry per admin visit', async ({ page }) => {
  await signIn(page, USERS.admin);
  // The admin is not a member of the seeded project: opening its board reads
  // several endpoints but is recorded once for this session.
  await page.goto(`/p/${PROJECT_KEY}`);
  await expect(page.locator('section.column').first()).toBeVisible();
  await page.goto(`/p/${PROJECT_KEY}/backlog`);
  await expect(page.locator('app-skeleton')).toHaveCount(0);
  await page.goto('/admin/audit');
  await page.locator('mat-form-field', { hasText: 'Action' }).locator('mat-select').click();
  await page
    .getByRole('option', { name: 'Admin opened a project they are not a member of', exact: true })
    .click();
  await expect(page.locator('app-skeleton')).toHaveCount(0);
  const rows = page.locator('table.data tbody tr');
  await expect(rows.first()).toContainText('Admin opened a project they are not a member of');
  await expect(rows.first()).toContainText(PROJECT_KEY);
  await expect(rows.first()).toContainText('Ada Admin');
  await expect(rows.first()).not.toContainText('ADMIN_CROSS_PROJECT_ACCESS');
  // One entry per visit: no two entries for the seeded project share a session.
  const seeded = (await (await page.request.get(`api/v1/projects/${PROJECT_KEY}`)).json()) as {
    id: string;
  };
  const visits = (await (
    await page.request.get(
      `api/v1/admin/audit?action=ADMIN_CROSS_PROJECT_ACCESS&projectId=${seeded.id}`,
    )
  ).json()) as { items: { meta: { via?: string; sessionId?: string } }[] };
  // Export downloads are recorded each time, so only visit reads are counted.
  const reads = visits.items.filter(
    (e) =>
      e.meta.via?.startsWith('GET ') &&
      !/\/snapshots|\/download/.test(e.meta.via) &&
      e.meta.sessionId,
  );
  expect(reads.length).toBeGreaterThan(0);
  expect(new Set(reads.map((e) => e.meta.sessionId)).size).toBe(reads.length);
  await rows.first().getByText('Technical details').click();
  await expect(rows.first().locator('code')).toContainText('sessionId');
  await snap(page, 'readable audit log');
});

test('due dates take a time from the drawer and cards show it', async ({ page }) => {
  await signIn(page, USERS.pm);
  const before = await itemOf(page, ITEMS.taskB);
  await page.goto(`/p/${PROJECT_KEY}/items/${ITEMS.taskB}`);
  const drawer = page.getByRole('dialog', { name: 'Item details', exact: true });
  const due = drawer.getByRole('textbox', { name: 'Due date', exact: true });
  const savedDate = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().includes(`/items/`),
  );
  await due.fill('');
  await due.fill('2030-03-15');
  await due.press('Tab');
  expect((await savedDate).status()).toBe(200);
  await expect(due).toHaveValue('15 Mar 2030');
  await drawer.getByRole('button', { name: 'Add time', exact: true }).click();
  // The Material time input is a combobox with its list of times.
  const time = drawer.getByRole('combobox', { name: 'Due time', exact: true });
  const savedTime = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().includes(`/items/`),
  );
  await time.fill('17:00');
  await time.press('Tab');
  expect((await savedTime).status()).toBe(200);
  const stored = await itemOf(page, ITEMS.taskB);
  expect(stored).toMatchObject({ dueDate: '2030-03-15', dueTime: '17:00' });
  await snap(page, 'drawer due date and time');
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('app-item-card', { hasText: before.title })).toContainText('17:00');
  await snap(page, 'card with due time');
  // Put the seeded values back for other scenarios.
  const restored = await page.request.patch(`api/v1/projects/${PROJECT_KEY}/items/${ITEMS.taskB}`, {
    headers,
    data: { dueDate: before.dueDate, dueTime: before.dueTime ?? null },
  });
  expect(restored.status()).toBe(200);
});

test('settings tabs, bucket menus, header Export… and project counts', async ({ page }) => {
  await signIn(page, USERS.pm);
  await expect(page.locator('table.data').getByText('Open', { exact: true })).toBeVisible();
  await snap(page, 'projects list with counts');
  await page.goto(`/p/${PROJECT_KEY}/settings`);
  await expect(page).toHaveURL(new RegExp(`/p/${PROJECT_KEY}/settings/general$`));
  // Material's tab nav bar exposes itself as a tab list.
  const sections = page.getByRole('tablist', { name: 'Settings sections', exact: true });
  await expect(sections.getByRole('tab')).toHaveText([
    'General',
    'Members',
    'Teams',
    'Buckets',
    'Labels',
  ]);
  await sections.getByRole('tab', { name: 'Buckets', exact: true }).click();
  const actions = page.getByRole('button', { name: /^Actions for / }).first();
  await actions.focus();
  await actions.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Move up', exact: true })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Move down', exact: true })).toBeEnabled();
  await snap(page, 'bucket row actions menu');
  await page.keyboard.press('Escape');
  await page.goto(`/p/${PROJECT_KEY}`);
  const head = page.locator('app-project-shell .k-page-head');
  await expect(head.getByRole('button', { name: 'Export…', exact: true })).toBeVisible();
  await snap(page, 'export in the page header');
});
