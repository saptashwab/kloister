import { expect, type Locator, type Page, test } from '@playwright/test';
import { ITEMS, PROJECT_KEY, signIn, USERS } from './support';

// M5 against the real API: notes with @mention, the notifications bell and
// list, images pasted or dropped into descriptions and notes with the
// full-size viewer, and attachments (docs/DESIGN.md §7, §10, §11). Every
// test leaves screenshots in the HTML report for review. Only notes,
// attachments and descriptions are changed, which the other specs do not
// look at.

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
 * Signs out by dropping the session cookie, then signs in as someone else.
 *
 * @param page The browser page.
 * @param email The next user.
 * @returns Resolves once signed in.
 */
async function switchUser(page: Page, email: string): Promise<void> {
  await page.context().clearCookies();
  await signIn(page, email);
}

/**
 * Pastes or drops an image file into an element, as a user would: a PNG
 * drawn on a canvas in the page, or (with `fake`) SVG text claiming to be a
 * PNG, which only the API's content check can catch.
 *
 * @param target The editing area.
 * @param name File name.
 * @param how Paste or drop.
 * @param fake Send SVG bytes labelled as PNG.
 * @returns Resolves once the event is dispatched.
 */
async function giveImage(
  target: Locator,
  name: string,
  how: 'paste' | 'drop',
  fake = false,
): Promise<void> {
  await target.click();
  await target.evaluate(
    async (element, args) => {
      let blob: Blob;
      if (args.fake) {
        blob = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], { type: 'image/png' });
      } else {
        const canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = 270;
        const g = canvas.getContext('2d');
        if (g === null) throw new Error('no canvas');
        const fill = g.createLinearGradient(0, 0, 480, 270);
        fill.addColorStop(0, '#3E63DD');
        fill.addColorStop(1, '#12A594');
        g.fillStyle = fill;
        g.fillRect(0, 0, 480, 270);
        g.fillStyle = '#FFFFFF';
        g.font = 'bold 32px sans-serif';
        g.fillText(args.name, 32, 140);
        blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (b) => (b === null ? reject(new Error('no blob')) : resolve(b)),
            'image/png',
          ),
        );
      }
      const data = new DataTransfer();
      data.items.add(new File([blob], args.name, { type: 'image/png' }));
      const init = { bubbles: true, cancelable: true };
      element.dispatchEvent(
        args.how === 'paste'
          ? new ClipboardEvent('paste', { ...init, clipboardData: data })
          : new DragEvent('drop', { ...init, dataTransfer: data }),
      );
    },
    { name, how, fake },
  );
}

test('a PM mentions a Member in a note, who is notified through the bell', async ({ page }) => {
  await signIn(page, USERS.pm);
  await page.goto(`/p/${PROJECT_KEY}/items/${ITEMS.taskA}`);
  const drawer = page.locator('app-item-drawer');
  const composer = drawer.getByRole('textbox', { name: 'New note' });
  await expect(
    drawer.getByText('Type @ to mention someone, paste or drop an image.'),
  ).toBeVisible();
  await composer.click();
  await page.keyboard.type('Can you check the totals, @Mi');
  const picker = page.getByRole('listbox', { name: 'People' });
  await expect(picker.getByRole('option', { name: 'Mia Member' })).toBeVisible();
  await expect(composer).toHaveAttribute('aria-expanded', 'true');
  await snap(page, 'mention picker');
  await page.keyboard.press('Enter');
  await page.keyboard.type('please?');
  await expect(composer.locator('.k-mention')).toHaveText('@Mia Member');
  await drawer.getByRole('button', { name: 'Add note' }).click();
  await expect(page.locator('.k-toast', { hasText: 'Note added' })).toBeVisible();
  const note = drawer.getByRole('article', { name: 'Note by Pat Manager' });
  await expect(note).toContainText('Can you check the totals');
  await expect(note.locator('.k-mention')).toHaveText('@Mia Member');
  await snap(page, 'note with a mention');

  // The filters: History lists the note being added; Notes only the notes.
  await drawer.getByRole('radio', { name: 'History' }).click();
  await expect(drawer.locator('.timeline')).toContainText('added a note');
  await expect(note).toHaveCount(0);
  await drawer.getByRole('radio', { name: 'Notes' }).click();
  await expect(note).toBeVisible();
  await expect(drawer.locator('.timeline')).not.toContainText('created this');
  await snap(page, 'activity filtered to notes');

  // Mia also heard that the seeded "Invoice form" was assigned to her.
  await switchUser(page, USERS.member);
  const bell = page.getByRole('link', { name: 'Notifications, 2 unread' });
  await expect(bell).toBeVisible();
  await expect(bell.locator('.k-badge')).toHaveText('2');
  await snap(page, 'bell with unread count');
  await bell.click();
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  const entry = page.getByRole('link', { name: /Pat Manager mentioned you/ });
  await expect(entry).toContainText(`${PROJECT_KEY}-${ITEMS.taskA}`);
  await expect(entry).toContainText('Invoice form');
  await expect(page.getByRole('link', { name: /Pat Manager assigned you/ })).toBeVisible();
  await snap(page, 'notifications list');

  await entry.click();
  await expect(page).toHaveURL(new RegExp(`/p/${PROJECT_KEY}/items/${ITEMS.taskA}$`));
  await expect(page.locator('app-item-drawer')).toContainText('Can you check the totals');
  // Opening it marked it read; the assignment is still unread. The drawer's
  // scrim covers the shell, so close the drawer before using the bell.
  await page.locator('app-item-drawer').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('app-item-drawer .d-panel')).toHaveCount(0);
  await page.getByRole('link', { name: 'Notifications, 1 unread' }).click();
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByRole('link', { name: 'Notifications', exact: true })).toBeVisible();
  await page.getByRole('radio', { name: 'Unread' }).click();
  await expect(page.getByText('No unread notifications')).toBeVisible();
  await snap(page, 'no unread notifications');
});

test('images pasted or dropped into a description and a note open full size', async ({ page }) => {
  await signIn(page, USERS.pm);
  await page.goto(`/p/${PROJECT_KEY}/items/${ITEMS.bug}`);
  const drawer = page.locator('app-item-drawer');
  const description = drawer.getByRole('textbox', { name: 'Description' });
  await expect(drawer.getByText('Paste or drop PNG, JPEG, GIF or WebP images.')).toBeVisible();
  await giveImage(description, 'rounding-error.png', 'paste');
  const pasted = description.locator('img[alt="rounding-error.png"]');
  await expect(pasted).toBeVisible();
  // The image is served by the app itself, for this item only.
  await expect(pasted).toHaveAttribute(
    'src',
    /^api\/v1\/projects\/[0-9a-f-]+\/items\/[0-9a-f-]+\/images\//,
  );
  await expect.poll(() => pasted.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480);
  await drawer.getByRole('button', { name: 'Save description' }).click();
  await expect(page.locator('.k-toast', { hasText: 'Description saved' })).toBeVisible();
  await snap(page, 'pasted image in the description');

  await pasted.click();
  const viewer = page.getByRole('dialog', { name: 'rounding-error.png' });
  await expect(viewer.locator('img')).toBeVisible();
  await snap(page, 'full-size image viewer');
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);

  // Dropped into a note: shown in the note, and opened with the keyboard.
  const composer = drawer.getByRole('textbox', { name: 'New note' });
  await giveImage(composer, 'expected-total.png', 'drop');
  await expect(composer.locator('img[alt="expected-total.png"]')).toBeVisible();
  await composer.press('End');
  await page.keyboard.type('Expected total above.');
  await drawer.getByRole('button', { name: 'Add note' }).click();
  const note = drawer.getByRole('article', { name: 'Note by Pat Manager' }).first();
  const noteImage = note.locator('img[alt="expected-total.png"]');
  await expect(noteImage).toBeVisible();
  await snap(page, 'dropped image in a note');
  await noteImage.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'expected-total.png' })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(page.getByRole('dialog', { name: 'expected-total.png', exact: true })).toHaveCount(
    0,
  );
  await expect(drawer).toBeVisible();
  await expect(noteImage).toBeFocused();
});

test('only real PNG, JPEG, GIF and WebP images are accepted', async ({ page }) => {
  await signIn(page, USERS.pm);
  await page.goto(`/p/${PROJECT_KEY}/items/${ITEMS.bug}`);
  const composer = page.locator('app-item-drawer').getByRole('textbox', { name: 'New note' });
  // SVG text named and labelled as PNG: refused by the API's content check.
  await giveImage(composer, 'drawing.png', 'paste', true);
  await expect(
    page.locator('.k-toast', { hasText: 'Only PNG, JPEG, GIF and WebP images' }),
  ).toBeVisible();
  await expect(composer.locator('img')).toHaveCount(0);
  await snap(page, 'refused image');
});

test('attachments are uploaded, downloaded and deleted; Viewers only download', async ({
  page,
}) => {
  await signIn(page, USERS.pm);
  await page.goto(`/p/${PROJECT_KEY}/items/${ITEMS.bug}`);
  const files = page.locator('app-item-attachments');
  await expect(files.getByRole('button', { name: 'Attach files' })).toBeVisible();
  await files.locator('input[type="file"]').setInputFiles({
    name: 'rounding report.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Totals are rounded per line instead of per invoice.\n'),
  });
  await expect(page.locator('.k-toast', { hasText: 'rounding report.txt attached' })).toBeVisible();
  const link = files.getByRole('link', { name: 'rounding report.txt' });
  await expect(link).toBeVisible();
  await expect(page.locator('app-item-drawer .timeline')).toContainText(
    'attached “rounding report.txt”',
  );
  await snap(page, 'attachments');

  const download = page.waitForEvent('download');
  await link.click();
  expect((await download).suggestedFilename()).toBe('rounding report.txt');

  await switchUser(page, USERS.viewer);
  await page.goto(`/p/${PROJECT_KEY}/items/${ITEMS.bug}`);
  const viewerFiles = page.locator('app-item-attachments');
  await expect(viewerFiles.getByRole('link', { name: 'rounding report.txt' })).toBeVisible();
  await expect(viewerFiles.getByRole('button', { name: 'Attach files' })).toHaveCount(0);
  await expect(viewerFiles.getByRole('button', { name: /Delete attachment/ })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'New note' })).toHaveCount(0);
  await snap(page, 'viewer sees notes and attachments read-only');

  await switchUser(page, USERS.pm);
  await page.goto(`/p/${PROJECT_KEY}/items/${ITEMS.bug}`);
  await page
    .locator('app-item-attachments')
    .getByRole('button', { name: 'Delete attachment rounding report.txt' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Delete rounding report.txt?' });
  await snap(page, 'delete attachment confirmation');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('app-item-attachments')).toContainText('No attachments.');
});
