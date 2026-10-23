import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';
import type { ProjectDto, SnapshotPreviewDto, WorkItemDetailDto } from '@kloister/shared';
import { choose, E2E_PASSWORD, signIn, USERS } from './support';

// These integration scenarios run only in CI against the real API.
const headers = { 'x-requested-with': 'kloister' };

/**
 * Attaches actual UI evidence to the browser report.
 * @param page Current browser.
 * @param name Screenshot description.
 * @returns Resolves after the screenshot is attached.
 */
async function snap(page: Page, name: string): Promise<void> {
  await test
    .info()
    .attach(name, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
}

test('independent copy preview supports per-person and count modes, responsive layouts and fresh progress', async ({
  page,
}) => {
  await signIn(page, USERS.pm);
  await page.goto('/p/KLO/items/4');
  const drawer = page.locator('app-item-drawer');
  await expect(drawer.getByRole('heading', { level: 1 })).toBeVisible();
  await drawer.getByRole('button', { name: 'Duplicate item', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Duplicate item', exact: true });
  await expect(dialog).toBeVisible();
  await choose(page, 'Copy mode', 'One copy per person');
  await dialog.getByRole('combobox', { name: 'People (one independent copy each)' }).click();
  await page.getByRole('option', { name: 'Mia Member', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('button', { name: 'Create 1 copies', exact: true })).toBeEnabled();
  await snap(page, 'one independent copy per selected person');
  await choose(page, 'Copy mode', 'Number of copies');
  await dialog.getByLabel('Number of copies', { exact: true }).fill('2');
  await dialog.getByLabel('Title for copies', { exact: true }).fill('Independent copy preview');
  await expect(dialog.getByRole('button', { name: 'Create 2 copies', exact: true })).toBeEnabled();
  for (const [width, height, label] of [
    [390, 844, 'phone'],
    [800, 1000, 'tablet'],
  ] as const) {
    await page.setViewportSize({ width, height });
    await snap(page, `duplication preview ${label}`);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  }
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await snap(page, 'duplication preview dark reduced motion');
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && /\/items\/[^/]+\/duplicate$/.test(response.url()),
  );
  await dialog.getByRole('button', { name: 'Create 2 copies', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const copies = (await response.json()) as WorkItemDetailDto[];
  await expect(dialog).toBeHidden();
  for (const copy of copies) {
    expect(copy.status).toBe('NOT_STARTED');
    expect(copy.completedAt).toBeNull();
    expect(copy.checklist.done).toBe(0);
    await page.request.delete(`api/v1/projects/KLO/items/${copy.id}`, { headers });
  }
});

test('Viewers export filtered and all-visible snapshots, including a usable offline archive, without copy controls', async ({
  page,
}) => {
  await signIn(page, USERS.viewer);
  await page.goto('/p/KLO');
  await expect(page.locator('app-item-copy-action button')).toHaveCount(0);
  const denial = await page.request.post('api/v1/projects/KLO/items/4/duplicate', {
    headers,
    data: { copies: [{ title: 'Denied', assigneeIds: [] }] },
  });
  expect(denial.status()).toBe(403);
  await page.locator('.search input').fill('Invoice form');
  const previewResponse = page.waitForResponse((response) =>
    response.url().includes('/snapshots/preview'),
  );
  await page.getByRole('button', { name: 'Export…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export snapshot' });
  const preview = (await (await previewResponse).json()) as SnapshotPreviewDto;
  expect(preview.count).toBe(1);
  await expect(dialog).toContainText('1 items');
  await snap(page, 'Viewer filtered export preview');
  await choose(page, 'Scope', 'All visible project items');
  await expect(dialog).toContainText('All visible project items');
  await dialog.getByRole('checkbox', { name: 'Include files for offline use (ZIP)' }).check();
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download offline ZIP' }).click();
  const download = await downloaded;
  const path = await download.path();
  expect(path).not.toBeNull();
  const zip = await JSZip.loadAsync(await readFile(path ?? ''));
  expect(zip.file('snapshot.xlsx')).not.toBeNull();
  expect(zip.file('index.html')).not.toBeNull();
  expect(
    Object.keys(zip.files).some(
      (name) => name.startsWith('items/') && name.endsWith('/index.html'),
    ),
  ).toBe(true);
  await expect(dialog.getByRole('status')).toContainText('Snapshot downloaded');
  await snap(page, 'offline snapshot download result');
});

test('My work export keeps source, Done and created-item eligibility with all-eligible scope', async ({
  page,
}) => {
  await signIn(page, USERS.member);
  await page.goto('/work');
  await choose(page, 'Source', 'Projects');
  const createdSwitch = page.getByRole('switch', { name: 'Also items I created', exact: true });
  await createdSwitch.click();
  await expect(createdSwitch).toBeChecked();
  const doneSwitch = page.getByRole('switch', { name: 'Show done', exact: true });
  await doneSwitch.click();
  await expect(doneSwitch).toBeChecked();
  await page.getByRole('button', { name: 'Export…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export snapshot' });
  const response = page.waitForResponse(
    (res) => res.url().includes('/me/snapshots/preview') && res.url().includes('scope=all'),
  );
  await choose(page, 'Scope', 'All my work');
  const data = (await (await response).json()) as SnapshotPreviewDto;
  expect(data.filters).toContain('Source: Projects');
  expect(data.filters).toContain('Also items I created: Yes');
  expect(data.filters).toContain('Show done: Yes');
  expect(data.filters).toContain('No narrowing filters');
  await page.setViewportSize({ width: 800, height: 1000 });
  await snap(page, 'My work all-eligible export tablet');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
});

test('bundled FAQ searches procedures and keyboard replay reflects current Viewer permissions', async ({
  page,
}) => {
  await signIn(page, USERS.viewer);
  await page.getByRole('link', { name: 'Help & FAQ', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search help' }).fill('snapshots');
  await expect(
    page.getByRole('heading', { name: 'Excel and offline snapshots', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Boards, status and hierarchy', exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await snap(page, 'searchable FAQ phone dark');
  const replay = page.getByRole('button', { name: 'Take the tour' });
  await replay.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Step 1 of');
  for (let index = 0; index < 3; index++)
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(dialog).toContainText('Your project access is read-only');
  await snap(page, 'Viewer tour capabilities phone dark');
  await dialog.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(dialog).toContainText('Step 3 of');
  await dialog.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(dialog).toBeHidden();
});

test('new account tour follows initial password success, skips durably across browsers and replays with changed context', async ({
  page,
  browser,
}) => {
  await signIn(page, USERS.admin);
  const email = `introduction-${Date.now()}@example.org`;
  const created = await page.request.post('api/v1/admin/users', {
    headers,
    data: { email, displayName: 'Introduction newcomer' },
  });
  expect(created.status()).toBe(201);
  const user = (await created.json()) as { user: { id: string }; temporaryPassword: string };
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(user.temporaryPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Change your .+ password$/ })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('Current password', { exact: true }).fill(user.temporaryPassword);
  await page.getByLabel('New password', { exact: true }).fill(E2E_PASSWORD);
  await page.getByLabel('Repeat new password', { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Your work, together');
  await expect(dialog.getByRole('combobox', { name: 'Project context' })).toHaveText(
    'Common features only',
  );
  await snap(page, 'first introduction with no memberships');
  await dialog.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(dialog).toBeHidden();
  const context = await browser.newContext();
  const second = await context.newPage();
  try {
    await signIn(second, email);
    expect(await (await second.request.get('api/v1/me/introduction')).json()).toEqual({
      pending: false,
    });
    await expect(second.getByRole('dialog')).toHaveCount(0);
    const managerContext = await browser.newContext();
    try {
      const manager = await managerContext.newPage();
      await signIn(manager, USERS.pm);
      const project = (await (
        await manager.request.get('api/v1/projects/KLO')
      ).json()) as ProjectDto;
      expect(
        (
          await manager.request.post(`api/v1/projects/${project.id}/members`, {
            headers,
            data: { userId: user.user.id, role: 'VIEWER', visibility: 'ALL' },
          })
        ).status(),
      ).toBe(201);
      await second.goto('/help');
      await second.getByRole('button', { name: 'Take the tour' }).click();
      const replay = second.getByRole('dialog');
      await expect(replay.getByRole('combobox', { name: 'Project context' })).toHaveText(
        'Demo project',
      );
      for (let index = 0; index < 3; index++)
        await replay.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(replay).toContainText('read-only');
      expect(
        (
          await manager.request.patch(`api/v1/projects/${project.id}/members/${user.user.id}`, {
            headers,
            data: { role: 'MEMBER' },
          })
        ).status(),
      ).toBe(200);
      await replay.getByRole('button', { name: 'Back', exact: true }).click();
      await replay.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(replay).toContainText('You can create items');
      await snap(second, 'manual replay recomposed after project role change');
      await replay.getByRole('button', { name: 'Skip', exact: true }).click();
      await manager.request.delete(`api/v1/projects/${project.id}/members/${user.user.id}`, {
        headers,
      });
    } finally {
      await managerContext.close();
    }
  } finally {
    await context.close();
    await page.context().clearCookies();
    await signIn(page, USERS.admin);
    await page.request.patch(`api/v1/admin/users/${user.user.id}`, {
      headers,
      data: { isActive: false },
    });
  }
});
