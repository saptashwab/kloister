import { expect, type Locator, type Page, test } from '@playwright/test';
import type { ProjectDto, WorkItemDetailDto, UserWorkDto } from '@kloister/shared';
import { choose, signIn, USERS } from './support';

// Real API/browser coverage runs only in CI. Personal test items are removed
// afterwards; the owner's space itself is deliberately retained.

/**
 * Attaches the current screen to the CI report.
 * @param page Browser page.
 * @param name Screenshot name.
 * @returns Resolves after attachment.
 */
async function snap(page: Page, name: string): Promise<void> {
  await test
    .info()
    .attach(name, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
}

/**
 * Drags a work card between status columns using the CDK's pointer path.
 * @param page Browser page.
 * @param card Editable card.
 * @param target Destination list.
 * @returns Resolves after the pointer is released.
 */
async function dragStatus(page: Page, card: Locator, target: Locator): Promise<void> {
  const from = await card.boundingBox();
  const to = await target.boundingBox();
  if (from === null || to === null) throw new Error('Status card or list is not visible');
  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + 30, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + 20, { steps: 20 });
  await page.mouse.up();
}

/**
 * Creates one private task in the signed-in caller's space.
 * @param page Signed-in browser.
 * @param title Task title.
 * @returns The private project and task.
 */
async function personalTask(
  page: Page,
  title: string,
): Promise<{ project: ProjectDto; item: WorkItemDetailDto }> {
  const headers = { 'x-requested-with': 'kloister' };
  const ensured = await page.request.post('api/v1/me/personal', { headers });
  expect(ensured.status()).toBe(200);
  const project = (await ensured.json()) as ProjectDto;
  const buckets = (await (
    await page.request.get(`api/v1/projects/${project.id}/buckets`)
  ).json()) as { items: { id: string }[] };
  const created = await page.request.post(`api/v1/projects/${project.id}/items`, {
    headers,
    data: { title, type: 'TASK', bucketId: buckets.items[0]?.id },
  });
  expect(created.status()).toBe(201);
  return { project, item: (await created.json()) as WorkItemDetailDto };
}

/**
 * Removes only the task created by the current test.
 * @param page Signed-in owner.
 * @param projectId Its space.
 * @param itemId Task id.
 * @returns Resolves after the authorized delete.
 */
async function removeTask(page: Page, projectId: string, itemId: string): Promise<void> {
  const removed = await page.request.delete(`api/v1/projects/${projectId}/items/${itemId}`, {
    headers: { 'x-requested-with': 'kloister' },
  });
  expect(removed.status()).toBe(204);
}

test('My work shares list/board filters, shows personal tasks, and changes status by keyboard', async ({
  page,
}) => {
  await signIn(page, USERS.member);
  const { project, item } = await personalTask(page, 'Private training for work views');
  try {
    const buckets = (await (
      await page.request.get(`api/v1/projects/${project.id}/buckets`)
    ).json()) as { items: { id: string; name: string }[] };
    const doing = buckets.items.find((b) => b.name === 'In Progress');
    expect(doing).toBeDefined();
    expect(
      (
        await page.request.patch(`api/v1/projects/${project.id}`, {
          headers: { 'x-requested-with': 'kloister' },
          data: { settings: { statusToBucket: { IN_PROGRESS: doing?.id } } },
        })
      ).status(),
    ).toBe(200);
    await page.getByRole('link', { name: 'My work', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'My work', exact: true })).toBeVisible();
    await expect(page.locator('app-work')).toContainText('Invoice form');
    await expect(page.locator('app-work')).toContainText(item.title);
    await expect(page.locator('app-work')).not.toContainText('Invoice PDF');
    await expect(page.getByRole('heading', { name: 'No date', exact: true })).toBeVisible();
    await snap(page, 'my work list, project and personal work');
    await page.getByRole('switch', { name: 'Group by project' }).click();
    await expect(page.getByRole('heading', { name: 'Personal', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Demo project', exact: true })).toBeVisible();
    await snap(page, 'my work grouped by project');
    await choose(page, 'Source', 'Personal');
    await expect(page.locator('app-work')).not.toContainText('Invoice form');
    await page.getByRole('radio', { name: 'Board', exact: true }).click();
    const status = page.getByRole('combobox', { name: `Status for ${item.title}`, exact: true });
    await status.focus();
    await status.press('Enter');
    const savedStatus = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response.url().includes(`/projects/${project.id}/items/${item.id}`),
    );
    await page.getByRole('option', { name: 'In progress', exact: true }).click();
    expect((await savedStatus).status()).toBe(200);
    const progress = page.locator('.column', {
      has: page.getByRole('heading', { name: /In progress/ }),
    });
    await expect(progress).toContainText(item.title);
    await snap(page, 'personal work status board, keyboard status edit');
    const stored = (await (
      await page.request.get(`api/v1/projects/${project.id}/items/${item.id}`)
    ).json()) as WorkItemDetailDto;
    expect(stored.status).toBe('IN_PROGRESS');
    expect(stored.bucketId).toBe(doing?.id);
    await page
      .locator('.k-toast', { hasText: `${item.key} · In progress` })
      .getByRole('button', { name: 'Undo', exact: true })
      .click();
    await expect(
      page.locator('.column', { has: page.getByRole('heading', { name: /Not started/ }) }),
    ).toContainText(item.title);
    const blocked = page.locator('.column', {
      has: page.getByRole('heading', { name: /Blocked/ }),
    });
    await dragStatus(
      page,
      page.locator('article.card', { hasText: item.title }),
      blocked.locator('.list'),
    );
    await expect(blocked).toContainText(item.title);
    await snap(page, 'work status drag applies the ordinary edit endpoint');
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await page.getByRole('switch', { name: 'Also items I created' }).click();
    await snap(page, 'work with created items included');
  } finally {
    await removeTask(page, project.id, item.id);
  }
});

test('all their work keeps project Viewers read-only in both views', async ({ page }) => {
  await signIn(page, USERS.viewer);
  const members = (await (await page.request.get('api/v1/projects/KLO/members')).json()) as {
    items: { email: string; userId: string }[];
  };
  const member = members.items.find((m) => m.email === USERS.member);
  expect(member).toBeDefined();
  await page.goto(`/people/${member?.userId}`);
  await expect(page.getByRole('heading', { name: 'Mia Member', exact: true })).toBeVisible();
  await expect(page.locator('app-work')).toContainText('Invoice form');
  await snap(page, 'Viewer all their work list');
  await page.getByRole('radio', { name: 'Board', exact: true }).click();
  await expect(
    page.locator('app-work').getByRole('combobox', { name: /^Status for / }),
  ).toHaveCount(0);
  await expect(page.locator('article.card').first()).toHaveClass(/cdk-drag-disabled/);
  await snap(page, 'Viewer all their work board without edit controls');
});

test('personal board, backlog, sprints, settings and drawer omit collaboration controls', async ({
  page,
}) => {
  await signIn(page, USERS.viewer);
  const { project, item } = await personalTask(page, 'Private reimbursement');
  try {
    await page.getByRole('link', { name: 'Personal space', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Personal', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New item', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Assignee', exact: true })).toHaveCount(0);
    await snap(page, 'personal board, Viewer has owner rights');
    await page.goto(`/p/personal/items/${item.number}`);
    const drawer = page.locator('app-item-drawer');
    await expect(drawer.getByRole('heading', { name: item.title, exact: true })).toBeVisible();
    await expect(drawer).toContainText(`#${item.number}`);
    await expect(drawer.getByRole('combobox', { name: 'Assignees', exact: true })).toHaveCount(0);
    await expect(drawer).not.toContainText('Type @ to mention someone');
    await snap(page, 'personal drawer without assignment or mentions');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    for (const tab of ['Backlog', 'Sprints', 'Settings']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await expect(page.locator('app-skeleton')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Personal', exact: true })).toBeVisible();
      if (tab === 'Settings') {
        await expect(page.getByText('Members', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
        await expect(page.getByText('Teams', { exact: true })).toHaveCount(0);
      }
      await snap(page, `personal ${tab.toLowerCase()}`);
    }
  } finally {
    await removeTask(page, project.id, item.id);
  }
});

test('another user and an administrator cannot open or list private work', async ({ page }) => {
  await signIn(page, USERS.member);
  const { project, item } = await personalTask(page, 'Private task never shared');
  const ownerId = project.ownerId;
  try {
    for (const user of [USERS.pm, USERS.admin]) {
      await signIn(page, user);
      expect((await page.request.get(`api/v1/projects/${project.id}`)).status()).toBe(404);
      expect(
        (await page.request.get(`api/v1/projects/${project.id}/items/${item.id}`)).status(),
      ).toBe(404);
      const work = (await (
        await page.request.get(`api/v1/users/${ownerId}/work?includeCreated=true&includeDone=true`)
      ).json()) as UserWorkDto;
      expect(work.items.some((i) => i.personal)).toBe(false);
      await page.goto(`/p/${project.id}/items/${item.number}`);
      await expect(page.getByRole('alert')).toContainText('Project not found');
      await expect(page.locator('main')).not.toContainText(item.title);
      await snap(page, `${user === USERS.admin ? 'admin' : 'other user'} private route denial`);
      await page.goto(`/people/${ownerId}`);
      await expect(page.getByRole('heading', { name: 'Mia Member', exact: true })).toBeVisible();
      await expect(page.locator('app-work')).not.toContainText(item.title);
      await expect(page.getByRole('combobox', { name: 'Source', exact: true })).toHaveCount(0);
      await page.getByRole('radio', { name: 'Board', exact: true }).click();
      await snap(page, 'all their work status board, private items excluded');
    }
  } finally {
    await signIn(page, USERS.member);
    await removeTask(page, project.id, item.id);
  }
});

test('new work and personal screens reflow on phones/tablets in dark mode with reduced motion', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await signIn(page, USERS.member);
  const { project, item } = await personalTask(page, 'Private task at narrow widths');
  try {
    for (const width of [320, 768]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of [
        '/work',
        '/p/personal',
        '/p/personal/backlog',
        '/p/personal/sprints',
        '/p/personal/settings',
      ]) {
        await page.goto(path);
        await expect(
          page.getByRole('heading', {
            name: path === '/work' ? 'My work' : 'Personal',
            exact: true,
          }),
        ).toBeVisible();
        await expect(page.locator('app-skeleton')).toHaveCount(0);
        await expect(page.locator('main')).toBeVisible();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await snap(page, `${path} dark ${width}`);
        if (path === '/work') {
          await page.getByRole('radio', { name: 'Board', exact: true }).click();
          await expect(
            page.getByRole('region', { name: 'Work status board', exact: true }),
          ).toBeVisible();
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ).toBe(true);
          await snap(page, `work status board dark ${width}`);
        }
      }
    }
  } finally {
    await removeTask(page, project.id, item.id);
  }
});

test('empty personal space and filtered work offer clear recovery paths', async ({ page }) => {
  await signIn(page, USERS.viewer);
  await page.goto('/p/personal');
  await expect(page.locator('app-skeleton')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New item', exact: true })).toBeVisible();
  await snap(page, 'empty personal board');
  await page.goto('/work');
  await expect(page.getByText('No matching work', { exact: true })).toBeVisible();
  await page.getByRole('radio', { name: 'Board', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clear filters', exact: true })).toBeVisible();
  await snap(page, 'empty work status view');
});
