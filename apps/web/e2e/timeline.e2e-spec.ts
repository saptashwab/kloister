import { expect, test, type Page } from '@playwright/test';
import type { BucketDto, ProjectDto, UserDto, WorkItemDetailDto } from '@kloister/shared';
import { signIn, USERS } from './support';

// The project timeline (SPEC §6.4, M9) against the real API: grid editing,
// automatic and confirmed dependent moves, selection, keyboard use, links to
// the drawer and board, Viewer limits and phone/dark screenshots.

const headers = { 'x-requested-with': 'kloister' };

/** Example plan: an Epic with three tasks, the second and third after the first. */
interface Plan {
  project: ProjectDto;
  ids: Record<'epic' | 'draft' | 'review' | 'launch', WorkItemDetailDto>;
}

/**
 * Creates a disposable project and plan through the API.
 *
 * @param page Signed-in administrator page.
 * @param key Unique project key.
 * @returns The project and items.
 */
async function seedPlan(page: Page, key: string): Promise<Plan> {
  const me = (await (await page.request.get('api/v1/me')).json()) as UserDto;
  const created = await page.request.post('api/v1/projects', {
    headers,
    data: { key, name: 'Example timeline', pmUserIds: [me.id] },
  });
  expect(created.status()).toBe(201);
  const project = (await created.json()) as ProjectDto;
  const buckets = (
    (await (await page.request.get(`api/v1/projects/${project.id}/buckets`)).json()) as {
      items: BucketDto[];
    }
  ).items;
  const make = async (data: object): Promise<WorkItemDetailDto> => {
    const res = await page.request.post(`api/v1/projects/${project.id}/items`, { headers, data });
    expect(res.status()).toBe(201);
    return (await res.json()) as WorkItemDetailDto;
  };
  const epic = await make({ type: 'EPIC', title: 'Relaunch the website' });
  const task = (title: string, startDate: string, dueDate: string) =>
    make({ type: 'TASK', title, parentId: epic.id, bucketId: buckets[0].id, startDate, dueDate });
  const draft = await task('Draft copy', '2026-11-02', '2026-11-04');
  const review = await task('Editorial review', '2026-11-05', '2026-11-06');
  const launch = await task('Launch', '2026-11-09', '2026-11-09');
  for (const [blocked, blocking] of [
    [review, draft],
    [launch, review],
  ] as const) {
    const res = await page.request.post(
      `api/v1/projects/${project.id}/items/${blocked.id}/dependencies`,
      { headers, data: { blockingItemId: blocking.id } },
    );
    expect(res.ok()).toBe(true);
  }
  return { project, ids: { epic, draft, review, launch } };
}

/**
 * Reads an item's dates through the API.
 *
 * @param page Signed-in page.
 * @param plan The plan.
 * @param item The item.
 * @returns Start and due.
 */
async function datesOf(page: Page, plan: Plan, item: WorkItemDetailDto) {
  const res = await page.request.get(`api/v1/projects/${plan.project.id}/items/${item.id}`);
  const body = (await res.json()) as WorkItemDetailDto;
  return { start: body.startDate, due: body.dueDate };
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

/**
 * The grid cell of a row and column header.
 *
 * @param page Browser page.
 * @param key Item key.
 * @param column Column index among the grid columns (0 = key).
 * @returns The cell.
 */
function cell(page: Page, key: string, column: number) {
  return page
    .locator('[role="row"]', { has: page.locator('.k-key', { hasText: new RegExp(`^${key}$`) }) })
    .locator('[role="gridcell"][id^="c-"]')
    .nth(column);
}

test('plans by typing, moves dependent items automatically and undoes exactly', async ({
  page,
}) => {
  await signIn(page, USERS.admin);
  const plan = await seedPlan(page, 'TLAUTO');
  const k = plan.project.key!;
  await page.goto(`/p/${k}/timeline`);
  await expect(page.getByRole('grid', { name: 'Plan' })).toBeVisible();
  await expect(page.getByText('Dependent items move automatically')).toBeVisible();
  // Summary row: the Epic spans its tasks (2 Nov – 9 Nov: 6 working days).
  await expect(cell(page, `${k}-1`, 3)).toHaveText('6');
  await snap(page, 'timeline-desktop-light');

  // Typing a longer duration for Draft copy pushes Review and Launch later.
  const days = cell(page, `${k}-2`, 3);
  await days.click();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('5');
  await page.keyboard.press('Tab');
  const toast = page.locator('.k-toast').filter({ hasText: 'moved' }).first();
  await expect(toast).toContainText(`moved ${k}-3, ${k}-4`);
  await expect
    .poll(() => datesOf(page, plan, plan.ids.review))
    // Draft now ends on Friday 6 Nov, so Review starts Monday and keeps 2 days.
    .toEqual({
      start: '2026-11-09',
      due: '2026-11-10',
    });
  await snap(page, 'timeline-after-auto-move');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect
    .poll(() => datesOf(page, plan, plan.ids.review))
    .toEqual({
      start: '2026-11-05',
      due: '2026-11-06',
    });

  // A new row typed into the add field becomes an ordinary item.
  await page.getByRole('textbox', { name: /Type a title|New row under/ }).fill('Write FAQ');
  await page.keyboard.press('Enter');
  await expect(page.locator('[role="row"]', { hasText: 'Write FAQ' })).toBeVisible();
  await page.goto(`/p/${k}/backlog`);
  await expect(page.getByText('Write FAQ')).toBeVisible();
});

test('asks before moving on existing projects and lets a PM switch to automatic', async ({
  page,
}) => {
  await signIn(page, USERS.admin);
  const plan = await seedPlan(page, 'TLASK');
  const k = plan.project.key!;
  const off = await page.request.patch(`api/v1/projects/${plan.project.id}`, {
    headers,
    data: { settings: { autoMoveDependents: false } },
  });
  expect(off.ok()).toBe(true);
  await page.goto(`/p/${k}/timeline`);
  await expect(page.getByText('Dependent moves are confirmed')).toBeVisible();
  const due = cell(page, `${k}-2`, 4);
  await due.click();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('5 Nov 2026');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: /Move 2 dependent items/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Always move dependent items in this project')).toBeVisible();
  await snap(page, 'timeline-confirm-dialog');
  await dialog.getByText('Always move dependent items in this project').click();
  await dialog.getByRole('button', { name: 'Move 2 items' }).click();
  await expect(page.getByText('Dependent items move automatically')).toBeVisible();
  await expect
    .poll(() => datesOf(page, plan, plan.ids.launch))
    // Draft ends Thu 5 Nov, so Review moves to Fri 6 – Mon 9 Nov and Launch to Tue 10 Nov.
    .toEqual({
      start: '2026-11-10',
      due: '2026-11-10',
    });
});

test('selects rows for bulk status, moves a bar by keyboard and links to the board', async ({
  page,
}) => {
  await signIn(page, USERS.admin);
  const plan = await seedPlan(page, 'TLBULK');
  const k = plan.project.key!;
  await page.goto(`/p/${k}/timeline`);
  await page.getByRole('checkbox', { name: `Select ${k}-2` }).click();
  await page.getByRole('checkbox', { name: `Select ${k}-4` }).click({ modifiers: ['Control'] });
  const bar = page.getByRole('region', { name: 'Selected rows' });
  await expect(bar).toContainText('2 selected');
  await bar.locator('mat-form-field', { hasText: 'Set status' }).locator('mat-select').click();
  await page.getByRole('option', { name: 'In progress', exact: true }).click();
  await expect(page.getByText('2 updated, 0 already set, 0 skipped, 0 refused.')).toBeVisible();

  // Keyboard on a bar: Shift+Right twice adds a day to Launch; Enter saves.
  const launchBar = page.getByRole('button', { name: new RegExp(`^${k}-4 Launch`) });
  await launchBar.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Enter');
  await expect
    .poll(() => datesOf(page, plan, plan.ids.launch))
    .toEqual({
      start: '2026-11-09',
      due: '2026-11-10',
    });

  // The key opens the drawer; it links to the board card.
  await cell(page, `${k}-3`, 0).getByRole('link').click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Show on board' }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${k}/items/3`));
});

test('Viewers read the timeline without editing; phones get a list; dark mode reads', async ({
  page,
}) => {
  await signIn(page, USERS.viewer);
  await page.goto('/p/KLO/timeline');
  await expect(page.getByRole('grid', { name: 'Plan' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /Type a title/ })).toHaveCount(0);
  await expect(page.locator('.bar .edge')).toHaveCount(0);
  await page.emulateMedia({ colorScheme: 'dark' });
  await snap(page, 'timeline-viewer-dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('Bars are shown on wider screens.')).toBeVisible();
  await snap(page, 'timeline-phone');
});
