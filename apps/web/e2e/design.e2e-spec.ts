import { expect, type Locator, type Page, test } from '@playwright/test';
import { ITEMS, PROJECT_KEY, signIn, USERS } from './support';

// M4.5 design foundation against the real API (docs/DESIGN.md): avatar hover
// cards and the person filter, "all their work", label styles, inline
// editing with Undo, confirm dialogs, "New item", dark mode and phone width.
// Every test leaves screenshots in the HTML report for review.

/**
 * A board card by its title.
 *
 * @param page The browser page.
 * @param title Card title.
 * @returns The card.
 */
function card(page: Page, title: string): Locator {
  return page.locator('.columns .open', { hasText: title });
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

test('avatar hover card filters the board and leads to all their work', async ({ page }) => {
  await signIn(page, USERS.pm);
  await page.goto(`/p/${PROJECT_KEY}`);
  const avatar = card(page, 'Invoice form').getByRole('button', { name: 'Mia Member' });
  await avatar.hover();
  const hoverCard = page.getByRole('dialog', { name: 'Mia Member' });
  await expect(hoverCard).toContainText(USERS.member);
  await expect(hoverCard.getByRole('link', { name: 'View all their work' })).toBeVisible();
  await snap(page, 'avatar hover card');

  await hoverCard.getByRole('button', { name: 'Filter board to this person' }).click();
  await expect(page.locator('.columns')).toContainText('Invoice form');
  await expect(page.locator('.columns')).not.toContainText('Invoice PDF');
  const quick = page.getByRole('group', { name: 'Filter by person' });
  await expect(quick.getByRole('button', { name: 'Mia Member' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByText('Assignee: Mia Member')).toBeVisible();
  await snap(page, 'board filtered to one person');

  await card(page, 'Invoice form').getByRole('button', { name: 'Mia Member' }).hover();
  await page.getByRole('dialog', { name: 'Mia Member' }).getByRole('link').click();
  await expect(page).toHaveURL(/\/people\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name: 'Mia Member' })).toBeVisible();
  await expect(page.locator('app-work')).toContainText('Invoice form');
  await snap(page, 'all their work');

  await page.getByRole('link', { name: 'My work' }).click();
  await expect(page.getByRole('heading', { name: 'My work' })).toBeVisible();
  await expect(page.locator('app-work')).toContainText('Invoice PDF');
  await snap(page, 'my work');
});

test('a Viewer with nothing assigned sees an empty state', async ({ page }) => {
  await signIn(page, USERS.viewer);
  await page.getByRole('link', { name: 'My work' }).click();
  await expect(page.getByText('No matching work')).toBeVisible();
  await snap(page, 'empty my work');
});

test('inline edits in the drawer can be undone', async ({ page }) => {
  await signIn(page, USERS.pm);
  await page.goto(`/p/${PROJECT_KEY}/items/${ITEMS.taskB}`);
  const drawer = page.locator('app-item-drawer');
  const priority = drawer.getByRole('combobox', { name: 'Priority' });
  await expect(priority).toContainText('2 – High');
  await priority.click();
  await page.getByRole('option', { name: /Highest/ }).click();
  await expect(priority).toContainText('1 – Highest');
  const toast = page.locator('.k-toast', { hasText: 'Priority saved' });
  await expect(toast).toBeVisible();
  await snap(page, 'drawer inline edit with undo');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(priority).toContainText('2 – High');
  // The new toast replaces the old one, which may still be fading out.
  await expect(page.locator('.k-toast', { hasText: 'Change undone' })).toBeVisible();

  // Title edits in place.
  // The title is the heading; clicking it edits in place.
  await drawer.getByRole('heading', { level: 1 }).getByRole('button').click();
  const title = drawer.getByRole('textbox', { name: 'Title' });
  await title.fill('Invoice PDF layout');
  await title.press('Enter');
  await expect(drawer.getByRole('heading', { name: 'Invoice PDF layout' })).toBeVisible();

  // Deleting asks first, in the app's own dialog.
  await drawer.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete item' }).click();
  const dialog = page.getByRole('dialog', { name: `Delete ${PROJECT_KEY}-${ITEMS.taskB}?` });
  await expect(dialog).toContainText('cannot be undone');
  await snap(page, 'confirm dialog');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(drawer.getByRole('heading', { name: 'Invoice PDF layout' })).toBeVisible();
});

test('a PM creates an item with New item', async ({ page }) => {
  await signIn(page, USERS.pm);
  await page.goto(`/p/${PROJECT_KEY}`);
  await page.getByRole('button', { name: 'New item' }).click();
  const dialog = page.getByRole('dialog', { name: 'New item' });
  await dialog.getByLabel('Title').fill('Email receipt template');
  await snap(page, 'new item dialog');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/items\/\d+$/);
  await expect(
    page.locator('app-item-drawer').getByRole('heading', { name: 'Email receipt template' }),
  ).toBeVisible();
});

test('PMs choose the label style; boards and drawers follow it, also in dark mode', async ({
  page,
}) => {
  await signIn(page, USERS.pm);
  await page.goto(`/p/${PROJECT_KEY}/settings`);
  await expect(page.getByRole('radio', { name: /^Solid/ })).toBeChecked();
  await snap(page, 'label settings');

  for (const style of ['Tinted', 'Cover bar'] as const) {
    const radio = page.getByRole('radio', { name: new RegExp(`^${style}`) });
    await radio.check();
    await expect(radio).toBeChecked();
    await page.getByRole('tab', { name: 'Board' }).click();
    await expect(card(page, 'Total rounds wrongly')).toContainText('customer');
    await snap(page, `board, ${style.toLowerCase()} labels`);
    await page.getByRole('tab', { name: 'Settings' }).click();
  }

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('tab', { name: 'Board' }).click();
  await expect(card(page, 'Total rounds wrongly')).toBeVisible();
  await snap(page, 'board, dark mode');
  await card(page, 'Total rounds wrongly').getByRole('link').click();
  await expect(page.locator('app-item-drawer').getByRole('heading', { level: 1 })).toBeVisible();
  await snap(page, 'drawer, dark mode');

  // Back to the default for the other tests.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`/p/${PROJECT_KEY}/settings`);
  await page.getByRole('radio', { name: /^Solid/ }).check();
  await expect(page.getByRole('radio', { name: /^Solid/ })).toBeChecked();
});

test('the shell works at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, USERS.pm);
  await page.goto(`/p/${PROJECT_KEY}`);
  await expect(page.locator('section.column').first()).toBeVisible();
  await snap(page, 'board at phone width');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeInViewport();
  await snap(page, 'menu at phone width');
  await page.getByRole('button', { name: 'Close menu' }).click();
  await page.goto(`/p/${PROJECT_KEY}/items/${ITEMS.bug}`);
  await expect(page.locator('app-item-drawer').getByRole('heading', { level: 1 })).toBeVisible();
  await snap(page, 'drawer at phone width');
});
