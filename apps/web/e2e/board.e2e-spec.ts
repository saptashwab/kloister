import { expect, type Locator, type Page, test } from '@playwright/test';
import { choose, ITEMS, PROJECT_KEY, signIn, USERS } from './support';

// M4 screens against the real API: board, item drawer, backlog, sprints and
// settings, for a PM, a Member limited to their own items, and a Viewer.
// Every test leaves a screenshot in the HTML report.

/**
 * A board column by bucket (or other group) name.
 *
 * @param page The browser page.
 * @param name Column heading.
 * @returns The column.
 */
function column(page: Page, name: string): Locator {
  return page.locator(`section.column[aria-label="${name}"]`);
}

/**
 * Drags a card into another column the way a user does, in small mouse
 * steps so the CDK drag-drop recognises the drag.
 *
 * @param page The browser page.
 * @param card The card.
 * @param target The target column.
 * @returns Resolves once dropped.
 */
async function drag(page: Page, card: Locator, target: Locator): Promise<void> {
  const from = await card.boundingBox();
  const to = await target.locator('.list').boundingBox();
  if (from === null || to === null) throw new Error('card or column not visible');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + 20, { steps: 20 });
  await page.mouse.up();
}

/**
 * Attaches a full-page screenshot to the report.
 *
 * @param page The browser page.
 * @param name Attachment name.
 * @returns Resolves once attached.
 */
async function snap(page: Page, name: string): Promise<void> {
  await test.info().attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

test('a PM works the board and the item drawer', async ({ page }) => {
  await signIn(page, USERS.pm);
  await page.getByRole('link', { name: PROJECT_KEY }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${PROJECT_KEY}$`));
  for (const name of ['Backlog', 'To Do', 'In Progress', 'Done']) {
    await expect(column(page, name)).toBeVisible();
  }
  await expect(column(page, 'Backlog')).toContainText('Overdue');
  await snap(page, 'board');

  // Quick-add puts the card at the top of the column it was typed into.
  const quickAdd = column(page, 'To Do').locator('input.quick-add');
  await quickAdd.fill('Write release notes');
  await quickAdd.press('Enter');
  const card = column(page, 'To Do').locator('.open', { hasText: 'Write release notes' });
  await expect(card).toBeVisible();

  // Dropping it into In Progress runs that bucket's entry rule on the server.
  await drag(page, card, column(page, 'In Progress'));
  const moved = column(page, 'In Progress').locator('.open', { hasText: 'Write release notes' });
  await expect(moved).toBeVisible();

  await moved.click();
  await expect(page).toHaveURL(/\/items\/\d+$/);
  const drawer = page.locator('app-item-drawer');
  await expect(
    drawer.locator('mat-form-field', { hasText: 'Status' }).locator('mat-select'),
  ).toContainText('In progress');

  const line = drawer.getByLabel('New checklist line');
  await line.fill('Draft the notes');
  await line.press('Enter');
  await expect(drawer.getByRole('heading', { name: 'Checklist 0/1' })).toBeVisible();
  await drawer.getByRole('checkbox', { name: 'Done: Draft the notes' }).check();
  await expect(drawer.getByRole('heading', { name: 'Checklist 1/1' })).toBeVisible();
  await expect(drawer).toContainText('moved the card from To Do to In Progress');
  await snap(page, 'item drawer');

  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${PROJECT_KEY}$`));
  await expect(moved).toContainText('1/1');
});

test('a PM bulk-edits the backlog and opens the sprint board', async ({ page }) => {
  await signIn(page, USERS.pm);
  await page.goto(`/p/${PROJECT_KEY}/backlog`);
  const rows = page.locator('tbody tr');
  await expect(rows.first()).toContainText('Checkout');
  await expect(page.locator('tbody')).toContainText('Payments');
  await expect(page.locator('tbody')).toContainText('Pay by invoice');

  await page.getByRole('checkbox', { name: `Select ${PROJECT_KEY}-${ITEMS.taskA}` }).check();
  await page.getByRole('checkbox', { name: `Select ${PROJECT_KEY}-${ITEMS.taskB}` }).check();
  await choose(page, 'Set sprint', 'Sprint 1');
  await expect(page.getByRole('status')).toContainText('2 updated');
  await snap(page, 'backlog after bulk edit');

  await page.getByRole('tab', { name: 'Sprints' }).click();
  await expect(page.locator('table')).toContainText('Sprint 1');
  await page.getByRole('link', { name: 'Sprint board' }).click();
  await expect(page.getByText('Sprint board: Sprint 1')).toBeVisible();
  await expect(page.locator('.columns')).toContainText('Invoice form');
  await expect(page.locator('.columns')).not.toContainText('Total rounds wrongly');
  await snap(page, 'sprint board');

  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByText('Status moves cards')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add bucket' })).toBeVisible();
  await snap(page, 'settings');
});

test('a Member limited to own items sees hidden ancestors as titles only', async ({ page }) => {
  await signIn(page, USERS.member);
  await page.goto(`/p/${PROJECT_KEY}`);
  await expect(page.locator('.columns')).toContainText('Invoice form');
  await expect(page.locator('.columns')).not.toContainText('Invoice PDF');
  await expect(page.locator('.columns')).not.toContainText('Total rounds wrongly');

  await page.locator('.open', { hasText: 'Invoice form' }).click();
  const crumbs = page.locator('nav.crumbs');
  await expect(crumbs).toContainText('Checkout');
  await expect(crumbs).toContainText('Pay by invoice');
  await expect(crumbs.locator('a')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete item' })).toHaveCount(0);
  await snap(page, 'member drawer');

  // Items outside the scope are 404 even by direct link.
  await page.goto(`/p/${PROJECT_KEY}/items/${ITEMS.taskB}`);
  await expect(page.locator('app-item-drawer [role=alert]')).toBeVisible();

  await page.goto(`/p/${PROJECT_KEY}/backlog`);
  const epicRow = page.locator('tbody tr', { hasText: 'Checkout' });
  await expect(epicRow.locator('.ghost')).toBeVisible();
  await expect(epicRow.getByRole('checkbox')).toHaveCount(0);
  await snap(page, 'member backlog');
});

test('a Viewer gets a read-only board and drawer', async ({ page }) => {
  await signIn(page, USERS.viewer);
  await page.goto(`/p/${PROJECT_KEY}`);
  await expect(page.locator('.columns')).toContainText('Invoice PDF');
  await expect(page.locator('input.quick-add')).toHaveCount(0);
  await expect(page.locator('.cdk-drag-disabled').first()).toBeVisible();

  await page.goto(`/p/${PROJECT_KEY}/items/${ITEMS.taskB}`);
  const drawer = page.locator('app-item-drawer');
  await expect(drawer.getByRole('heading', { name: 'Invoice PDF' })).toBeVisible();
  await expect(drawer.locator('mat-select[aria-disabled="false"]')).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'Delete item' })).toHaveCount(0);
  await snap(page, 'viewer drawer');
});
