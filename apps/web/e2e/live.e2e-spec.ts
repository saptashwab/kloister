import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';
import type { WorkItemDto } from '@kloister/shared';
import { PROJECT_KEY, signIn, USERS } from './support';

// Live updates and presence (M10) with two signed-in people in two browser
// contexts: the PM changes things and the Member's screens follow without a
// reload; an item the Member may not see never appears; an edit in progress
// is not overwritten and shows the conflict notice; field-level presence
// marks the field and card the PM works on, and the header hover card goes
// to it; the bell updates; the connection chip shows reconnecting and
// recovers.

const headers = { 'x-requested-with': 'kloister' };

/**
 * Opens a signed-in page in its own browser context.
 *
 * @param browser The browser.
 * @param email Who signs in.
 * @returns The page.
 */
async function person(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  return page;
}

/**
 * Reads JSON from the API with the page's session.
 *
 * @param request The page's request context.
 * @param path Path below `/api/v1`.
 * @returns The answer.
 */
async function read<T>(request: APIRequestContext, path: string): Promise<T> {
  return (await (await request.get(`api/v1/${path}`)).json()) as T;
}

/**
 * Creates an item with the page's session.
 *
 * @param request The page's request context.
 * @param data The item.
 * @returns The new item.
 */
async function create(request: APIRequestContext, data: object): Promise<WorkItemDto> {
  const res = await request.post(`api/v1/projects/${PROJECT_KEY}/items`, { headers, data });
  expect(res.status()).toBe(201);
  return (await res.json()) as WorkItemDto;
}

/**
 * Attaches a screenshot to the report.
 *
 * @param page The page.
 * @param name Attachment name.
 * @returns Resolves once attached.
 */
async function snap(page: Page, name: string): Promise<void> {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

test('the Member sees the PM’s changes live, never hidden items, and keeps edits in progress', async ({
  browser,
}) => {
  const pm = await person(browser, USERS.pm);
  const member = await person(browser, USERS.member);
  const buckets = await read<{ items: { id: string; name: string }[] }>(
    pm.request,
    `projects/${PROJECT_KEY}/buckets`,
  );
  const bucket = (name: string) => buckets.items.find((b) => b.name === name)?.id ?? '';
  const members = await read<{ items: { userId: string; email: string }[] }>(
    pm.request,
    `projects/${PROJECT_KEY}/members`,
  );
  const memberId = members.items.find((m) => m.email === USERS.member)?.userId ?? '';

  await member.goto(`/p/${PROJECT_KEY}`);
  const todo = member.locator('section.column[aria-label="To Do"]');
  await expect(todo).toBeVisible();

  // A hidden item first, then a visible one: once the visible one shows, the
  // hidden one has been delivered (or not) too.
  const hidden = await create(pm.request, {
    type: 'TASK',
    title: 'Live hidden item',
    bucketId: bucket('To Do'),
  });
  const item = await create(pm.request, {
    type: 'TASK',
    title: 'Live shared item',
    bucketId: bucket('To Do'),
    assigneeIds: [memberId],
  });
  await expect(todo).toContainText('Live shared item');
  await expect(member.getByText('Live hidden item')).toHaveCount(0);

  // A move by the PM lands in place, highlighted and named.
  await pm.request.post(`api/v1/projects/${PROJECT_KEY}/items/${item.id}/move`, {
    headers,
    data: { bucketId: bucket('In Progress') },
  });
  const card = member
    .locator('section.column[aria-label="In Progress"]')
    .locator('app-item-card', { hasText: 'Live shared item' });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('title', 'Moved by Pat Manager just now');
  await snap(member, 'live-board-move');

  // Presence: the Member sees the PM editing the due date of the open item.
  await member.goto(`/p/${PROJECT_KEY}/items/${item.number}`);
  await expect(member.getByRole('dialog', { name: 'Item details' })).toBeVisible();
  await pm.goto(`/p/${PROJECT_KEY}/items/${item.number}`);
  await pm.getByRole('textbox', { name: 'Due date', exact: true }).click();
  await expect(
    member.getByRole('img', { name: 'Pat Manager is editing the due date' }).first(),
  ).toBeVisible({ timeout: 15_000 });
  await snap(member, 'live-presence');

  // Presence on an item the Member cannot see never names it to them.
  await pm.goto(`/p/${PROJECT_KEY}/items/${hidden.number}`);
  await pm.getByRole('textbox', { name: 'Due date', exact: true }).click();
  await member.waitForTimeout(4_000);
  await expect(member.getByRole('img', { name: /Pat Manager is editing/ })).toHaveCount(0);
  await pm.keyboard.press('Escape');

  // Conflict: the PM changes the priority while the Member's list is open.
  await member.locator('mat-select[aria-label="Priority"]').click();
  await expect(member.getByRole('option', { name: '4 – Low' })).toBeVisible();
  await pm.request.patch(`api/v1/projects/${PROJECT_KEY}/items/${item.id}`, {
    headers,
    data: { priority: 1 },
  });
  // Give the event time to arrive while the list stays open.
  await member.waitForTimeout(1_500);
  await expect(member.getByRole('option', { name: '4 – Low' })).toBeVisible();
  await member.getByRole('option', { name: '4 – Low' }).click();
  const notice = member.getByRole('dialog', {
    name: 'Pat Manager (PM) changed this while you were editing',
  });
  await expect(notice).toBeVisible();
  await snap(member, 'live-conflict');
  await notice.getByRole('button', { name: 'Keep mine' }).click();
  await expect
    .poll(
      async () =>
        (await read<WorkItemDto>(pm.request, `projects/${PROJECT_KEY}/items/${item.id}`)).priority,
    )
    .toBe(4);

  // The timeline gains the bar when the PM plans the item.
  await member.goto(`/p/${PROJECT_KEY}/timeline`);
  const row = member.locator(`[id="row-${item.id}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('.bar')).toHaveCount(0);
  await pm.request.patch(`api/v1/projects/${PROJECT_KEY}/items/${item.id}`, {
    headers,
    data: { startDate: '2026-11-09', dueDate: '2026-11-11' },
  });
  await expect(row.locator('.bar')).toBeVisible();
  await snap(member, 'live-timeline');
  await pm.context().close();
  await member.context().close();
});

test('the Member sees where the PM works: the field, the card, the page and Go to', async ({
  browser,
}) => {
  const pm = await person(browser, USERS.pm);
  const member = await person(browser, USERS.member);
  const buckets = await read<{ items: { id: string; name: string }[] }>(
    pm.request,
    `projects/${PROJECT_KEY}/buckets`,
  );
  const members = await read<{ items: { userId: string; email: string }[] }>(
    pm.request,
    `projects/${PROJECT_KEY}/members`,
  );
  const item = await create(pm.request, {
    type: 'TASK',
    title: 'Live presence item',
    bucketId: buckets.items.find((b) => b.name === 'To Do')?.id,
    assigneeIds: [members.items.find((m) => m.email === USERS.member)?.userId ?? ''],
  });
  const editing = 'Pat Manager is editing the due date';

  // The due date field the PM works in gets the PM's outline and name tag.
  await member.goto(`/p/${PROJECT_KEY}/items/${item.number}`);
  await expect(member.getByRole('dialog', { name: 'Item details' })).toBeVisible();
  await pm.goto(`/p/${PROJECT_KEY}/items/${item.number}`);
  await pm.getByRole('textbox', { name: 'Due date', exact: true }).click();
  // Members see the plan read-only (only PMs and Leads change it), so the
  // mark is on the read-only date line rather than an editable field.
  const field = member
    .getByRole('dialog', { name: 'Item details' })
    .locator('.k-pm-strong', { has: member.getByRole('img', { name: editing }) });
  await expect(field).toBeVisible({ timeout: 15_000 });
  await expect(field.locator('app-presence-tag')).toHaveText('Pat');
  await snap(member, 'live-presence-field');

  // On the board, the card carries the outline and tag too.
  await member.goto(`/p/${PROJECT_KEY}`);
  const card = member.locator(`app-item-card[data-card="${item.id}"]`);
  await expect(card).toHaveClass(/k-pm-strong/, { timeout: 15_000 });
  // Its name tag is seen with the full sentence as tooltip; screen readers
  // hear the sentence once, from the card's small presence avatars.
  await expect(card.locator('app-presence-tag')).toHaveAttribute('title', editing);
  await expect(card.getByRole('img', { name: editing })).toHaveCount(1);
  await snap(member, 'live-presence-card');

  // The header hover card says what the PM does and goes to the item.
  await member.locator('app-presence-head').getByRole('button', { name: 'Pat Manager' }).click();
  const hover = member.getByRole('dialog', { name: 'Pat Manager' });
  await expect(hover).toContainText(`${editing} of ${item.key} · Live presence item`);
  await snap(member, 'live-presence-hover-card');
  await hover.getByRole('button', { name: `Go to ${item.key}` }).click();
  await expect(member).toHaveURL(new RegExp(`/p/${PROJECT_KEY}/items/${item.number}$`));
  await expect(member.getByRole('dialog', { name: 'Item details' })).toBeVisible();

  // Without an item open, the card names the PM's page and offers no Go to.
  await pm.goto(`/p/${PROJECT_KEY}/timeline`);
  await member.goto(`/p/${PROJECT_KEY}/backlog`);
  const pat = member.locator('app-presence-head').getByRole('button', { name: 'Pat Manager' });
  await expect(pat).toBeVisible({ timeout: 15_000 });
  // The PM's page reload ends one stream and joins with another, so the
  // avatar may be replaced while this waits; open its card again then.
  const patCard = member.getByRole('dialog', { name: 'Pat Manager' });
  await expect(async () => {
    if (!(await patCard.isVisible())) await pat.click();
    await expect(patCard).toContainText('Viewing the timeline', { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(patCard.getByRole('button', { name: /^Go to/ })).toHaveCount(0);
  await pm.context().close();
  await member.context().close();
});

test('the Member sees the rows the PM drags together on the timeline (v1.4.1)', async ({
  browser,
}) => {
  const pm = await person(browser, USERS.pm);
  const member = await person(browser, USERS.member);
  const buckets = await read<{ items: { id: string; name: string }[] }>(
    pm.request,
    `projects/${PROJECT_KEY}/buckets`,
  );
  const members = await read<{ items: { userId: string; email: string }[] }>(
    pm.request,
    `projects/${PROJECT_KEY}/members`,
  );
  const mine = members.items.find((m) => m.email === USERS.member)?.userId ?? '';
  const task = (title: string) =>
    create(pm.request, {
      type: 'TASK',
      title,
      bucketId: buckets.items.find((b) => b.name === 'To Do')?.id,
      assigneeIds: [mine],
      startDate: '2026-11-16',
      dueDate: '2026-11-18',
    });
  const first = await task('Row drag one');
  const second = await task('Row drag two');
  const still = await task('Row drag stays');

  await member.goto(`/p/${PROJECT_KEY}/timeline`);
  await expect(member.locator(`#row-${first.id}`)).toBeVisible();
  await pm.goto(`/p/${PROJECT_KEY}/timeline`);
  await pm.getByRole('checkbox', { name: `Select ${first.key}` }).click();
  await pm
    .getByRole('checkbox', { name: `Select ${second.key}` })
    .click({ modifiers: ['Control'] });
  // The PM picks both rows up by the first one's grip and holds them.
  await pm.locator(`#row-${first.id}`).hover();
  const grip = (await pm.locator(`#row-${first.id} .grip`).boundingBox())!;
  await pm.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await pm.mouse.down();
  await pm.mouse.move(grip.x + grip.width / 2, grip.y + grip.height * 3, { steps: 8 });
  await expect(pm.locator('.drag-card')).toContainText('+1 item');

  // Both rows are outlined in the PM's colour; only the first carries the tag.
  await expect(member.locator(`#row-${first.id}`)).toHaveClass(/k-pm-strong/, { timeout: 15_000 });
  await expect(member.locator(`#row-${second.id}`)).toHaveClass(/k-pm-strong/);
  await expect(member.locator(`#row-${still.id}`)).not.toHaveClass(/k-pm-strong/);
  await expect(member.locator(`#row-${first.id} .blabel app-presence-tag`)).toHaveText('Pat');
  await expect(member.locator(`#row-${second.id} app-presence-tag`)).toHaveCount(0);
  await expect(member.locator(`#row-${first.id} .bar`)).toHaveClass(/k-pm-strong/);
  await snap(member, 'live-presence-row-drag');
  await member.locator('app-presence-head').getByRole('button', { name: 'Pat Manager' }).click();
  await expect(member.getByRole('dialog', { name: 'Pat Manager' })).toContainText(
    'Pat Manager is moving 2 rows',
  );
  await snap(member, 'live-presence-row-drag-hover-card');

  // Escape puts the rows back; the outlines go once presence catches up.
  await pm.keyboard.press('Escape');
  await pm.mouse.up();
  await expect(member.locator(`#row-${second.id}`)).not.toHaveClass(/k-pm-strong/, {
    timeout: 15_000,
  });
  await pm.context().close();
  await member.context().close();
});

test('the bell updates without a reload and the chip shows a lost connection', async ({
  browser,
}) => {
  const pm = await person(browser, USERS.pm);
  const member = await person(browser, USERS.member);
  const buckets = await read<{ items: { id: string; name: string }[] }>(
    member.request,
    `projects/${PROJECT_KEY}/buckets`,
  );
  // The Member's own item: a status change by someone else notifies its creator.
  const item = await create(member.request, {
    type: 'TASK',
    title: 'Live bell item',
    bucketId: buckets.items.find((b) => b.name === 'To Do')?.id,
  });
  await member.goto(`/p/${PROJECT_KEY}`);
  await expect(member.locator('section.column[aria-label="To Do"]')).toContainText(
    'Live bell item',
  );
  const before = (await read<{ count: number }>(member.request, 'notifications/unread-count'))
    .count;
  await pm.request.patch(`api/v1/projects/${PROJECT_KEY}/items/${item.id}`, {
    headers,
    data: { status: 'IN_PROGRESS' },
  });
  // Well before the 60-second poll.
  await expect(
    member.getByRole('link', { name: `Notifications, ${before + 1} unread` }).first(),
  ).toBeVisible({ timeout: 10_000 });

  await member.context().setOffline(true);
  await expect(member.getByText('Reconnecting…')).toBeVisible({ timeout: 15_000 });
  await snap(member, 'live-reconnecting');
  await member.context().setOffline(false);
  await expect(member.getByText('Reconnecting…')).toBeHidden({ timeout: 30_000 });
  await pm.context().close();
  await member.context().close();
});
