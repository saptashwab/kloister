import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { E2E_PASSWORD, E2E_SERVER_DIR, PROJECT_KEY, signIn, USERS } from './support';

// M6 against the real API: a user's own theme in light and dark mode, and
// the admin settings: branding (name, logo, preset and uploaded font,
// default theme, also on the sign-in page), security, storage with disk
// usage, backups (with a stand-in pg_dump) and logs. Every test leaves
// screenshots in the HTML report for review and puts back what it changed,
// so the other specs see the default look.

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

/**
 * Signs in as the admin, who is a member of no project, and waits for the
 * shell.
 *
 * @param page The browser page.
 * @returns Resolves once signed in.
 */
async function signInAdmin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(USERS.admin);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

/**
 * Waits for a toast with this text.
 *
 * @param page The browser page.
 * @param text The toast text.
 * @returns Resolves once shown.
 */
async function toast(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.locator('.k-toast', { hasText: text }).first()).toBeVisible();
}

/**
 * Opens one admin settings tab.
 *
 * @param page The browser page.
 * @param tab The tab name.
 * @returns Resolves once open.
 */
async function openTab(page: Page, tab: string): Promise<void> {
  await page.goto('/admin/settings');
  await page.getByRole('tab', { name: tab }).click();
  await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
}

/**
 * A PNG logo drawn on a canvas in the page.
 *
 * @param page The browser page.
 * @returns The PNG bytes.
 */
async function drawLogo(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 56;
    const g = canvas.getContext('2d');
    if (g === null) throw new Error('no canvas');
    g.fillStyle = '#0F766E';
    g.beginPath();
    g.arc(28, 28, 24, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#C2410C';
    g.fillRect(64, 12, 88, 32);
    return canvas.toDataURL('image/png').split(',')[1] ?? '';
  });
  return Buffer.from(base64, 'base64');
}

/**
 * A bundled font file, uploaded as if it were the organisation's own font.
 * JetBrains Mono, so the screenshots show the change clearly.
 *
 * @returns The WOFF2 bytes.
 */
async function fontFile(): Promise<Buffer> {
  const root = resolve(dirname(test.info().config.configFile ?? ''), '../../..');
  return readFile(
    resolve(
      root,
      'node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2',
    ),
  );
}

/**
 * The UI font the page body uses.
 *
 * @param page The browser page.
 * @returns The computed font-family.
 */
function bodyFont(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).fontFamily);
}

test('a user picks their own theme and sees it in light and dark mode', async ({ page }) => {
  await signIn(page, USERS.member);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Settings and theme' }).click();
  await expect(page.getByRole('heading', { name: 'Settings and theme' })).toBeVisible();
  await page.getByRole('radio', { name: 'Use my own theme' }).check();
  await page
    .getByRole('radiogroup', { name: 'Your theme Primary colour' })
    .getByRole('radio', { name: 'Teal' })
    .click();
  await page
    .getByRole('radiogroup', { name: 'Your theme Accent colour' })
    .getByRole('radio', { name: 'Orange' })
    .click();
  await page.getByRole('radio', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByText(/Shown as #[0-9A-F]{6} .* in dark mode/).first()).toBeVisible();
  await snap(page, 'own theme, light');
  await page.getByRole('radio', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await snap(page, 'own theme, dark');
  await page.getByRole('button', { name: 'Save theme' }).click();
  await toast(page, 'Your theme is saved');

  // It stays after a reload and across pages.
  await page.goto(`/p/${PROJECT_KEY}`);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const primary = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--k-primary').trim(),
  );
  expect(primary).not.toBe('#8b93ff');
  await snap(page, 'board in the own dark theme');

  // Back to the default theme for the other tests.
  await page.goto('/settings');
  await page.getByRole('radio', { name: 'Use the default theme' }).check();
  await page.getByRole('button', { name: 'Save theme' }).click();
  await toast(page, 'You use the default theme again');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
});

test('non-admins have no admin settings', async ({ page }) => {
  await signIn(page, USERS.pm);
  await expect(page.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
  await page.goto('/admin/settings/backups');
  // The admin guard sends them back to their projects.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toHaveCount(0);
});

test('an admin brands the app with a name, logo, font and default theme', async ({ page }) => {
  await signInAdmin(page);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Settings', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: 'Branding' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await snap(page, 'branding, defaults');

  await page.getByRole('textbox', { name: 'App name' }).fill('Team Board');
  await page.getByRole('button', { name: 'Save name' }).click();
  await toast(page, 'App name saved');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('heading')).toHaveText(
    'Team Board',
  );
  await expect(page).toHaveTitle('Team Board');

  await page
    .locator('input[type="file"][accept^="image/"]')
    .setInputFiles({ name: 'team-logo.png', mimeType: 'image/png', buffer: await drawLogo(page) });
  await toast(page, 'Logo uploaded');
  await expect(page.getByAltText('Current logo')).toBeVisible();
  await expect(page.locator('.sidebar img.k-logo')).toBeVisible();

  await page.getByRole('radio', { name: 'Atkinson Hyperlegible' }).check();
  await page.getByRole('button', { name: 'Save font' }).click();
  await toast(page, 'UI font saved');
  expect(await bodyFont(page)).toContain('Atkinson Hyperlegible');
  await snap(page, 'branding with name, logo and a preset font');

  await page
    .locator('input[type="file"][accept^=".woff2"]')
    .first()
    .setInputFiles({
      name: 'Brand-Regular.woff2',
      mimeType: 'font/woff2',
      buffer: await fontFile(),
    });
  await toast(page, 'Font file uploaded');
  await expect(page.getByText('Brand-Regular.woff2')).toBeVisible();
  await page.getByRole('radio', { name: 'Uploaded font' }).check();
  await page.getByRole('button', { name: 'Save font' }).click();
  await toast(page, 'UI font saved');
  expect(await bodyFont(page)).toContain('k-uploaded-ui-font');
  // The font file comes from the app itself, checked and with nosniff.
  const font = await page.request.get('api/v1/branding/fonts/regular');
  expect(font.headers()['content-type']).toBe('font/woff2');
  expect(font.headers()['x-content-type-options']).toBe('nosniff');
  await snap(page, 'branding with an uploaded font');

  await page
    .getByRole('radiogroup', { name: 'Default theme Primary colour' })
    .getByRole('radio', { name: 'Violet' })
    .click();
  await page.getByRole('button', { name: 'Save default theme' }).click();
  await toast(page, 'Default theme saved');
  await snap(page, 'branding with a violet default theme');

  // The sign-in page shows the branding before anyone signs in.
  await page.context().clearCookies();
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Team Board' })).toBeVisible();
  await expect(page.locator('main img.k-logo')).toBeVisible();
  await expect(page).toHaveTitle('Team Board');
  expect(await bodyFont(page)).toContain('k-uploaded-ui-font');
  await snap(page, 'sign-in page with the branding');

  // Back to the defaults for the other tests.
  await signInAdmin(page);
  await openTab(page, 'Branding');
  await page.getByRole('button', { name: 'Remove logo' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove logo' }).click();
  await toast(page, 'Logo removed');
  await page.getByRole('button', { name: 'Remove', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await toast(page, 'Font file removed');
  expect(await bodyFont(page)).toContain('Figtree');
  await page.getByRole('textbox', { name: 'App name' }).fill('Kloister');
  await page.getByRole('button', { name: 'Save name' }).click();
  await toast(page, 'App name saved');
  await page
    .getByRole('radiogroup', { name: 'Default theme Primary colour' })
    .getByRole('radio', { name: 'Indigo' })
    .click();
  await page.getByRole('button', { name: 'Save default theme' }).click();
  await toast(page, 'Default theme saved');
  await expect(page).toHaveTitle('Kloister');
});

test('an admin changes the session and lockout settings', async ({ page }) => {
  await signInAdmin(page);
  await openTab(page, 'Security');
  await expect(page.getByRole('spinbutton', { name: 'Idle timeout (minutes)' })).toHaveValue('480');
  await expect(page.getByText('7 days')).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Failed sign-ins before a lockout' }).fill('6');
  await page.getByRole('button', { name: 'Save security settings' }).click();
  await toast(page, 'Security settings saved');
  await page.getByRole('spinbutton', { name: 'Absolute timeout (minutes)' }).fill('60');
  await expect(page.getByRole('alert')).toContainText('at least the idle timeout');
  await snap(page, 'security settings');
  await page.reload();
  await expect(
    page.getByRole('spinbutton', { name: 'Failed sign-ins before a lockout' }),
  ).toHaveValue('6');
  await page.getByRole('spinbutton', { name: 'Failed sign-ins before a lockout' }).fill('5');
  await page.getByRole('button', { name: 'Save security settings' }).click();
  await toast(page, 'Security settings saved');
});

test('an admin sees the disk usage and changes the attachment limits', async ({ page }) => {
  await signInAdmin(page);
  await openTab(page, 'Storage');
  const folders = page.getByRole('list', { name: 'Folders' });
  await expect(folders).toContainText('Attachments');
  await expect(folders).toContainText('Backups');
  await expect(folders).toContainText(E2E_SERVER_DIR);
  await expect(page.getByRole('list', { name: 'Disk' })).toContainText('free of');
  await page.getByRole('spinbutton', { name: 'Largest file (MB)' }).fill('30');
  await page.getByRole('spinbutton', { name: 'Personal space per user (MB)' }).fill('768');
  await page.getByRole('button', { name: 'Save limits' }).click();
  await toast(page, 'Attachment limits saved');
  await expect(page.getByRole('spinbutton', { name: 'Personal space per user (MB)' })).toHaveValue(
    '768',
  );
  await snap(page, 'storage with disk usage');
  await page.getByRole('spinbutton', { name: 'Largest file (MB)' }).fill('25');
  await page.getByRole('spinbutton', { name: 'Personal space per user (MB)' }).fill('1024');
  await page.getByRole('button', { name: 'Save limits' }).click();
  await toast(page, 'Attachment limits saved');
});

test('an admin runs a backup now and changes the schedule', async ({ page }) => {
  await signInAdmin(page);
  await openTab(page, 'Backups');
  await expect(page.getByText('No backups yet')).toBeVisible();
  await snap(page, 'backups, none yet');
  await page.getByRole('button', { name: 'Run now' }).click();
  await toast(page, /Backup finished: \S+\.dump/);
  const results = page.getByRole('table', { name: 'Last results' });
  await expect(results).toContainText('Succeeded');
  await expect(results).toContainText('Run now');
  await expect(page.getByRole('table', { name: 'Backup files' })).toContainText('.dump');
  await snap(page, 'backups after run now');

  await page.getByRole('switch', { name: 'Back up every day' }).click();
  await page.getByRole('button', { name: 'Save schedule' }).click();
  await toast(page, 'Backup schedule saved');
  await expect(page.getByText('Off', { exact: true })).toBeVisible();
  await snap(page, 'backups switched off');
  await page.getByRole('switch', { name: 'Back up every day' }).click();
  await page.getByRole('button', { name: 'Save schedule' }).click();
  await toast(page, 'Backup schedule saved');
});

test('an admin sets the log retention', async ({ page }) => {
  await signInAdmin(page);
  await openTab(page, 'Logs');
  await expect(page.getByRole('spinbutton', { name: 'Keep logs for (days)' })).toHaveValue('30');
  await page.getByRole('spinbutton', { name: 'Keep logs for (days)' }).fill('60');
  await page.getByRole('button', { name: 'Save log retention' }).click();
  await toast(page, 'Log retention saved');
  await snap(page, 'log retention');
  await page.getByRole('spinbutton', { name: 'Keep logs for (days)' }).fill('30');
  await page.getByRole('button', { name: 'Save log retention' }).click();
  await toast(page, 'Log retention saved');
});
