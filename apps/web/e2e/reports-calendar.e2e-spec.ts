import { type Browser, expect, type Page, test } from '@playwright/test';
import type {
  BucketDto,
  ProjectDto,
  UserDto,
  WorkItemDetailDto,
  WorkloadReportDto,
} from '@kloister/shared';
import { signIn, USERS } from './support';

// Assignee shares, reports and calendars (M13) against the real API: shares
// set inline and typed in the timeline, a workload cell listing its items,
// two people where a share and a calendar move show up live on the other
// person's reports and timeline, calendar Undo and holidays, and the phone
// agenda.

const headers = { 'x-requested-with': 'kloister' };

/** A disposable project with the administrator as PM and the Member added. */
interface Setup {
  project: ProjectDto;
  memberId: string;
  item: WorkItemDetailDto;
}

/**
 * A calendar date relative to this week's Monday (the CI clock is UTC, like
 * the server's).
 *
 * @param offset Days after Monday.
 * @returns `YYYY-MM-DD`.
 */
function weekday(offset: number): string {
  const now = new Date();
  const monday = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - ((now.getUTCDay() + 6) % 7),
    ),
  );
  monday.setUTCDate(monday.getUTCDate() + offset);
  return monday.toISOString().slice(0, 10);
}

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
 * Creates a project with the administrator as PM, adds the Member and one
 * Task this week assigned to the Member, through the API.
 *
 * @param page Signed-in administrator page.
 * @param key Unique project key.
 * @returns The project, the Member's id and the item.
 */
async function setup(page: Page, key: string): Promise<Setup> {
  const me = (await (await page.request.get('api/v1/me')).json()) as UserDto;
  const created = await page.request.post('api/v1/projects', {
    headers,
    data: { key, name: 'Example reports', pmUserIds: [me.id] },
  });
  expect(created.status()).toBe(201);
  const project = (await created.json()) as ProjectDto;
  const users = (await (await page.request.get('api/v1/admin/users?limit=100')).json()) as {
    items: UserDto[];
  };
  const memberId = users.items.find((u) => u.email === USERS.member)?.id ?? '';
  const added = await page.request.post(`api/v1/projects/${project.id}/members`, {
    headers,
    data: { userId: memberId, role: 'MEMBER' },
  });
  expect(added.ok()).toBe(true);
  const buckets = (
    (await (await page.request.get(`api/v1/projects/${project.id}/buckets`)).json()) as {
      items: BucketDto[];
    }
  ).items;
  const res = await page.request.post(`api/v1/projects/${project.id}/items`, {
    headers,
    data: {
      type: 'TASK',
      title: 'Write the guide',
      bucketId: buckets[0].id,
      startDate: weekday(0),
      dueDate: weekday(1),
      assigneeIds: [memberId],
    },
  });
  expect(res.status()).toBe(201);
  return { project, memberId, item: (await res.json()) as WorkItemDetailDto };
}

/**
 * Reads an item through the API.
 *
 * @param page Signed-in page.
 * @param s The setup.
 * @returns The item.
 */
async function itemOf(page: Page, s: Setup): Promise<WorkItemDetailDto> {
  const res = await page.request.get(`api/v1/projects/${s.project.id}/items/${s.item.id}`);
  return (await res.json()) as WorkItemDetailDto;
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

test('shares are set inline and by typing, and the Member’s workload follows live', async ({
  browser,
}) => {
  const pm = await person(browser, USERS.admin);
  const s = await setup(pm, 'RPSH');
  const k = s.project.key!;
  const member = await person(browser, USERS.member);

  // The Member watches their workload: 2 days this week at 100%.
  await member.goto(`/p/${k}/reports?view=workload`);
  const row = member.locator('tr', { has: member.getByRole('rowheader', { name: 'Mia Member' }) });
  const thisWeek = row.locator('button.r-cell').first();
  await expect(thisWeek).toContainText('2 d');

  // The PM gives the Member half of the item from the drawer's assignee list.
  await pm.goto(`/p/${k}/items/${s.item.number}`);
  await pm.getByRole('combobox', { name: 'Assignees' }).click();
  const option = pm.getByRole('option', { name: /Mia Member/ });
  await option.locator('app-share-buttons button', { hasText: '50%' }).click();
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await pm.keyboard.press('Escape');
  await expect
    .poll(async () => (await itemOf(pm, s)).assigneeShares)
    .toEqual([{ userId: s.memberId, share: 50 }]);
  await expect(pm.getByRole('button', { name: /Mia Member has 50% of the work/ })).toBeVisible();
  await snap(pm, 'shares-drawer');

  // The Member's workload changes without a reload.
  await expect(thisWeek).toContainText('1 d', { timeout: 15_000 });
  await expect(member.getByText('Updated just now')).toBeVisible();
  await thisWeek.click();
  await expect(member.locator('.r-detail')).toContainText('Write the guide');
  await expect(member.locator('.r-detail')).toContainText('2 days × 50%');
  await snap(member, 'reports-workload');

  // A badge click cycles the share (50 → 100) and Undo puts it back.
  await pm.getByRole('button', { name: /Mia Member has 50% of the work/ }).click();
  await expect.poll(async () => (await itemOf(pm, s)).assigneeShares[0]?.share).toBe(100);
  await pm.locator('.k-toast').getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await itemOf(pm, s)).assigneeShares[0]?.share).toBe(50);

  // Typing in the timeline's Who cell sets people and shares: "Mia 25".
  await pm.goto(`/p/${k}/timeline`);
  const who = pm
    .locator('[role="row"]', { has: pm.locator('.k-key', { hasText: new RegExp(`^${k}-1$`) }) })
    .locator('[role="gridcell"][id^="c-"]')
    .nth(6);
  await who.click();
  // The first letter opens the editor; the rest waits until it has focus.
  await pm.keyboard.type('M');
  await expect(who.locator('input')).toBeFocused();
  await pm.keyboard.type('ia 25');
  await pm.keyboard.press('Tab');
  await expect
    .poll(async () => (await itemOf(pm, s)).assigneeShares)
    .toEqual([{ userId: s.memberId, share: 25 }]);
  // The cell draws avatars only; the share is in its label and tooltip.
  await expect(who.getByRole('img', { name: 'Mia Member 25%' })).toHaveAttribute(
    'title',
    'Mia Member 25%',
  );
  await snap(pm, 'shares-timeline-who');

  // Every dashboard opens for the Member, with numbers from visible items only.
  for (const name of ['Overview', 'Sprint', 'Plan health']) {
    await member.getByRole('radio', { name }).click();
    await expect(member.locator('app-skeleton')).toHaveCount(0);
  }
  await snap(member, 'reports-plan-health');
  const workload = (await (
    await member.request.get(`api/v1/projects/${s.project.id}/reports/workload`)
  ).json()) as WorkloadReportDto;
  expect(workload.rows.find((r) => r.userId === s.memberId)?.cells[0]?.planned).toBe(0.5);
  await pm.context().close();
  await member.context().close();
});

test('a calendar drag keeps the duration, offers Undo and shows on the other person’s timeline', async ({
  browser,
}) => {
  const pm = await person(browser, USERS.admin);
  const s = await setup(pm, 'RPCAL');
  const k = s.project.key!;
  // A project holiday on Friday is shaded and named.
  const holiday = await pm.request.post(`api/v1/projects/${s.project.id}/holidays`, {
    headers,
    data: { name: 'Founders day', startDate: weekday(4), endDate: weekday(4) },
  });
  expect(holiday.ok()).toBe(true);
  const member = await person(browser, USERS.member);
  await member.goto(`/p/${k}/timeline`);
  const due = member
    .locator('[role="row"]', { has: member.locator('.k-key', { hasText: new RegExp(`^${k}-1$`) }) })
    .locator('[role="gridcell"][id^="c-"]')
    .nth(4);
  await expect(due).not.toBeEmpty();
  const dueBefore = (await due.textContent()) ?? '';

  await pm.goto(`/p/${k}/calendar`);
  await pm.getByRole('radio', { name: 'Week' }).click();
  await expect(pm.locator('.c-day.holiday')).toContainText('Founders day');
  const bar = pm.locator('button.c-item', { hasText: 'Write the guide' });
  await expect(bar).toBeVisible();
  // The switch shows the chosen view without a stale check mark, and bars stay one line high.
  await expect(pm.getByRole('radio', { name: 'Week' })).toBeChecked();
  await expect(pm.getByRole('radio', { name: 'Month' })).not.toBeChecked();
  await expect(pm.locator('app-calendar-view .mat-pseudo-checkbox')).toHaveCount(0);
  expect((await bar.boundingBox())?.height ?? 0).toBeLessThan(32);
  await snap(pm, 'calendar-week');

  // Drag from Tuesday (its due day) to Thursday: due moves two days, start too.
  const from = await pm.locator(`[data-day="${weekday(1)}"]`).boundingBox();
  const to = await pm.locator(`[data-day="${weekday(3)}"]`).boundingBox();
  const barBox = await bar.boundingBox();
  if (from === null || to === null || barBox === null) throw new Error('Calendar not laid out');
  const y = barBox.y + barBox.height / 2;
  await pm.mouse.move(from.x + from.width / 2, y);
  await pm.mouse.down();
  await pm.mouse.move(from.x + from.width / 2 + 20, y, { steps: 3 });
  await pm.mouse.move(to.x + to.width / 2, y, { steps: 8 });
  await pm.mouse.up();
  await expect
    .poll(async () => {
      const item = await itemOf(pm, s);
      return [item.startDate, item.dueDate];
    })
    .toEqual([weekday(2), weekday(3)]);

  // The Member's timeline shows the new due date without a reload.
  await expect(due).not.toHaveText(dueBefore, { timeout: 15_000 });
  await expect(due).toContainText(String(Number(weekday(3).slice(8))));
  await snap(member, 'calendar-move-on-timeline');

  // Undo puts both dates back.
  await pm.locator('.k-toast').getByRole('button', { name: 'Undo' }).click();
  await expect
    .poll(async () => {
      const item = await itemOf(pm, s);
      return [item.startDate, item.dueDate];
    })
    .toEqual([weekday(0), weekday(1)]);

  // Keyboard: → moves a day, Enter saves.
  await pm.locator('button.c-item', { hasText: 'Write the guide' }).focus();
  await pm.keyboard.press('ArrowRight');
  await expect(pm.getByText(/moves to .*Enter saves/)).toBeAttached();
  await pm.keyboard.press('Enter');
  await expect.poll(async () => (await itemOf(pm, s)).dueDate).toBe(weekday(2));

  // Phone width: an agenda by day.
  await pm.setViewportSize({ width: 390, height: 844 });
  await expect(pm.getByRole('list', { name: 'Agenda' })).toContainText('Write the guide');
  await snap(pm, 'calendar-phone-agenda');
  await pm.context().close();
  await member.context().close();
});

test('My work has a calendar of the Member’s own items', async ({ page }) => {
  await signIn(page, USERS.member);
  await page.goto('/work');
  await page.getByRole('radio', { name: 'Calendar' }).click();
  await expect(page.getByRole('radio', { name: 'Calendar' })).toBeChecked();
  await expect(
    page.locator('mat-button-toggle-group[aria-label="Work view"] .mat-pseudo-checkbox'),
  ).toHaveCount(0);
  await expect(page.locator('app-calendar-view')).toBeVisible();
  await expect(page.locator('app-skeleton')).toHaveCount(0);
  await snap(page, 'work-calendar');
});
