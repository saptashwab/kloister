import { expect, test, type Page } from '@playwright/test';
import { PROJECT_KEY, signIn, USERS } from './support';

// Room for the page (v1.4.0): the sidebar shrinks to an icon rail and the
// project header and toolbar fold into one slim row, from buttons or Ctrl+\,
// remembered in the browser; a folded toolbar can be shown over the page.

/**
 * Attaches a full-page screenshot to the report.
 *
 * @param page Browser page.
 * @param name Attachment name.
 */
async function snap(page: Page, name: string): Promise<void> {
  await test
    .info()
    .attach(name, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
}

test.use({ viewport: { width: 1440, height: 900 } });

test('folds the sidebar and project toolbar, peeks at the toolbar and remembers the choice', async ({
  page,
}) => {
  await signIn(page, USERS.pm);
  await page.goto(`/p/${PROJECT_KEY}/timeline`);
  const toolbar = page.getByRole('toolbar', { name: 'Timeline' });
  await expect(toolbar).toBeVisible();
  await expect(page.locator('app-project-shell .head h1')).toBeVisible();

  // The shortcut folds both; it works with focus anywhere, including the grid.
  await page.keyboard.press('Control+Backslash');
  await expect(page.locator('.shell')).toHaveClass(/\brail\b/);
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await expect(page.locator('app-project-shell .head')).toHaveCount(0);
  await expect(page.locator('.slim-name')).toBeVisible();
  await expect(toolbar).toBeHidden();
  await snap(page, 'layout-folded');

  // Peeking shows the toolbar over the page; a press elsewhere folds it again.
  const grid = page.getByRole('grid');
  const gridTop = (await grid.boundingBox())!.y;
  await page.getByRole('button', { name: 'Show the toolbar' }).click();
  await expect(toolbar).toBeVisible();
  expect((await grid.boundingBox())!.y).toBe(gridTop);
  await toolbar.getByRole('checkbox', { name: 'Show Done' }).uncheck();
  await snap(page, 'layout-peek');
  // A press on plain text outside the toolbar.
  await page.locator('.slim-name').click();
  await expect(toolbar).toBeHidden();
  await expect(page.locator('.fold-controls .k-chip')).toHaveText(/1 filter/);

  // Remembered after a reload.
  await page.reload();
  await expect(page.locator('.slim-name')).toBeVisible();
  await expect(page.locator('.shell')).toHaveClass(/\brail\b/);

  // The pin and the sidebar button open each again.
  await page.getByRole('button', { name: 'Keep the header and toolbar open' }).click();
  await expect(page.locator('app-project-shell .head h1')).toBeVisible();
  await expect(toolbar).toBeVisible();
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(page.locator('.shell')).not.toHaveClass(/\brail\b/);
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
});
