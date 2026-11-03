import { type Browser, expect, type Page, test } from '@playwright/test';
import type { BucketDto, ProjectDto, UserDto, WorkItemDetailDto } from '@kloister/shared';
import { choose, signIn, USERS } from './support';

// Consistency fixes before v1.4.0 against the real API: report tiles open the
// backlog filtered, backlog bulk edits offer Undo, Copy link on a card and in
// the drawer, the timeline opens with today in view and draws the today line,
// and My work folds into one slim row like a project.

const headers = { 'x-requested-with': 'kloister' };

/** A disposable project with three Tasks: one Done today, one ad hoc, one planned around today. */
interface Setup {
  project: ProjectDto;
  buckets: BucketDto[];
  done: WorkItemDetailDto;
  adHoc: WorkItemDetailDto;
  planned: WorkItemDetailDto;
}

/**
 * A calendar date relative to today (the CI clock is UTC, like the server's).
 *
 * @param offset Days after today.
 * @returns `YYYY-MM-DD`.
 */
function day(offset: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset))
    .toISOString()
    .slice(0, 10);
}

/**
 * Opens a signed-in page in its own browser context, with clipboard access.
 *
 * @param browser The browser.
 * @param email Who signs in.
 * @returns The page.
 */
async function person(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await signIn(page, email);
  return page;
}

/**
 * Creates the project and its items through the API, as the administrator (its PM).
 *
 * @param page Signed-in administrator page.
 * @param key Unique project key.
 * @returns The setup.
 */
async function setup(page: Page, key: string): Promise<Setup> {
  const me = (await (await page.request.get('api/v1/me')).json()) as UserDto;
  const created = await page.request.post('api/v1/projects', {
    headers,
    data: { key, name: 'Example consistency', pmUserIds: [me.id] },
  });
  expect(created.status()).toBe(201);
  const project = (await created.json()) as ProjectDto;
  const buckets = (
    (await (await page.request.get(`api/v1/projects/${project.id}/buckets`)).json()) as {
      items: BucketDto[];
    }
  ).items;
  const item = async (data: object): Promise<WorkItemDetailDto> => {
    const res = await page.request.post(`api/v1/projects/${project.id}/items`, {
      headers,
      data: { type: 'TASK', bucketId: buckets[0].id, ...data },
    });
    expect(res.status()).toBe(201);
    return (await res.json()) as WorkItemDetailDto;
  };
  const done = await item({ title: 'Finished survey' });
  const finished = await page.request.patch(`api/v1/projects/${project.id}/items/${done.id}`, {
    headers,
    data: { status: 'DONE' },
  });
  expect(finished.ok()).toBe(true);
  const adHoc = await item({ title: 'Quick supplier call', adHoc: true });
  const planned = await item({
    title: 'Draft the handbook',
    startDate: day(-2),
    dueDate: day(5),
  });
  return { project, buckets, done, adHoc, planned };
}

/**
 * Attaches a screenshot to the CI report.
 *
 * @param page Browser page.
 * @param name Evidence name.
 * @returns Resolves after attachment.
 */
async function snap(page: Page, name: string): Promise<void> {
  await test
    .info()
    .attach(name, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
}

test.use({ viewport: { width: 1440, height: 900 } });

test('report tiles open the backlog filtered, and a bulk edit can be undone', async ({
  browser,
}) => {
  const pm = await person(browser, USERS.admin);
  const s = await setup(pm, 'CONA');
  const k = s.project.key!;

  await pm.goto(`/p/${k}/reports`);
  await pm.getByRole('link', { name: /Done in the last 14 days/ }).click();
  await expect(pm).toHaveURL(/backlog\?show=done-recent/);
  await expect(pm.getByText('Finished survey')).toBeVisible();
  await expect(pm.getByText('Quick supplier call')).toHaveCount(0);
  await expect(pm.getByText('Draft the handbook')).toHaveCount(0);

  await pm.goto(`/p/${k}/reports`);
  await pm.getByRole('link', { name: /Open ad-hoc items/ }).click();
  await expect(pm).toHaveURL(/backlog\?show=ad-hoc/);
  await expect(pm.getByText('Quick supplier call')).toBeVisible();
  await expect(pm.getByText('Finished survey')).toHaveCount(0);
  await snap(pm, 'backlog-show-ad-hoc');

  // Move the shown item to another bucket, then put it back with Undo.
  await pm.getByRole('checkbox', { name: 'Select all shown' }).first().check();
  await choose(pm, 'Set bucket', s.buckets[1].name);
  // A fading toast may still be in the page, so match the one with the text.
  const toast = pm.locator('mat-snack-bar-container', { hasText: '1 item updated' });
  await expect(toast).toBeVisible();
  const itemUrl = `api/v1/projects/${s.project.id}/items/${s.adHoc.id}`;
  await expect
    .poll(
      async () => ((await (await pm.request.get(itemUrl)).json()) as WorkItemDetailDto).bucketId,
    )
    .toBe(s.buckets[1].id);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(
    pm.locator('mat-snack-bar-container', { hasText: 'Change undone' }).last(),
  ).toBeVisible();
  await expect
    .poll(
      async () => ((await (await pm.request.get(itemUrl)).json()) as WorkItemDetailDto).bucketId,
    )
    .toBe(s.buckets[0].id);
});

test('Copy link copies the item’s own address from a card and from the drawer', async ({
  browser,
}) => {
  const pm = await person(browser, USERS.admin);
  const s = await setup(pm, 'CONB');
  const k = s.project.key!;
  const expected = (number: number) => new URL(`/p/${k}/items/${number}`, pm.url()).href;

  await pm.goto(`/p/${k}`);
  const card = pm.locator('app-item-card', { hasText: 'Draft the handbook' });
  await card.getByRole('button', { name: 'Copy link' }).click();
  await expect(
    pm.locator('mat-snack-bar-container', { hasText: 'Link copied' }).last(),
  ).toBeVisible();
  expect(await pm.evaluate(() => navigator.clipboard.readText())).toBe(expected(s.planned.number));

  // From the drawer opened on the backlog, the link is still the item's own.
  await pm.goto(`/p/${k}/backlog/items/${s.adHoc.number}`);
  const drawer = pm.getByRole('dialog');
  await drawer.getByRole('button', { name: 'Copy link' }).focus();
  await pm.keyboard.press('Enter');
  await expect(
    pm.locator('mat-snack-bar-container', { hasText: 'Link copied' }).last(),
  ).toBeVisible();
  expect(await pm.evaluate(() => navigator.clipboard.readText())).toBe(expected(s.adHoc.number));
});

test('the timeline opens with today in view and draws the today line', async ({ browser }) => {
  const pm = await person(browser, USERS.admin);
  const s = await setup(pm, 'CONC');
  await pm.goto(`/p/${s.project.key}/timeline`);
  const mark = pm.getByRole('img', { name: /^Today, / });
  await expect(mark).toBeInViewport();
  await expect(pm.locator('app-timeline .layer .today')).toBeAttached();
  await snap(pm, 'timeline-today');
});

test('My work folds into one slim row, peeks at its filters and counts them', async ({
  browser,
}) => {
  const member = await person(browser, USERS.member);
  await member.goto('/work');
  const filters = member.getByRole('group', { name: 'Work views and filters' });
  await expect(filters).toBeVisible();
  const fold = member.getByRole('button', { name: 'Fold the header and filters' });
  await fold.click();
  await expect(member.locator('app-work .slim-name')).toHaveText('My work');
  await expect(filters).toBeHidden();
  // The same button, now the pin, kept focus.
  await expect(
    member.getByRole('button', { name: 'Keep the header and filters open' }),
  ).toBeFocused();

  await member.getByRole('button', { name: 'Show the toolbar' }).click();
  await expect(filters).toBeVisible();
  await choose(member, 'Type', 'Task');
  await member.keyboard.press('Escape');
  await expect(filters).toBeHidden();
  await expect(member.locator('app-work .fold-controls .k-chip')).toHaveText(/1 filter/);
  await snap(member, 'my-work-folded');

  await member.getByRole('button', { name: 'Keep the header and filters open' }).click();
  await expect(member.getByRole('heading', { name: 'My work' })).toBeVisible();
  await expect(filters).toBeVisible();
});
