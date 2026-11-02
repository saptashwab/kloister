import { type Browser, expect, type Page, test } from '@playwright/test';
import type {
  BucketDto,
  MemberCandidateDto,
  ProjectDto,
  SprintDto,
  UserDto,
  WorkItemDetailDto,
} from '@kloister/shared';
import { choose, signIn, USERS } from './support';

// Items in and out of the plan, the trash and item references (M12) against
// the real API: the "New items start in" bucket on the timeline, a Story's
// sprint change taking its Tasks along with one Undo, an ad-hoc item on the
// board but not on the timeline, `KEY-12` links with a preview card and
// "Referenced in", and a two-person live check of delete, Trash and restore.

const headers = { 'x-requested-with': 'kloister' };

/** A project created for one test, with helpers bound to it. */
interface Space {
  project: ProjectDto;
  buckets: BucketDto[];
  make: (data: object) => Promise<WorkItemDetailDto>;
  item: (id: string) => Promise<WorkItemDetailDto>;
}

/**
 * Creates a project with the signed-in admin as its PM.
 *
 * @param page A page signed in as the admin.
 * @param key The project key.
 * @returns The project and helpers.
 */
async function space(page: Page, key: string): Promise<Space> {
  const me = (await (await page.request.get('api/v1/me')).json()) as UserDto;
  const created = await page.request.post('api/v1/projects', {
    headers,
    data: { key, name: `Example ${key}`, pmUserIds: [me.id] },
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
  const item = async (id: string): Promise<WorkItemDetailDto> =>
    (await (
      await page.request.get(`api/v1/projects/${project.id}/items/${id}`)
    ).json()) as WorkItemDetailDto;
  return { project, buckets, make, item };
}

/**
 * Creates a sprint.
 *
 * @param page A page signed in as a PM of the project.
 * @param projectId The project.
 * @param name Sprint name.
 * @returns The sprint.
 */
async function sprint(page: Page, projectId: string, name: string): Promise<SprintDto> {
  const res = await page.request.post(`api/v1/projects/${projectId}/sprints`, {
    headers,
    data: { name, startDate: '2026-11-02', endDate: '2026-11-13' },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as SprintDto;
}

/**
 * Opens a signed-in page in its own browser context.
 *
 * @param browser The browser.
 * @param email Who signs in.
 * @returns The page.
 */
async function person(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, email);
  return page;
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

test('new rows start in the chosen bucket; Tasks follow their Story; ad hoc stays off the timeline', async ({
  page,
}) => {
  await signIn(page, USERS.admin);
  const s = await space(page, 'PLAN');
  const k = s.project.key!;
  const todo = s.buckets.find((b) => b.name === 'To Do')!;

  // A PM chooses where new items start.
  await page.goto(`/p/${k}/settings/general`);
  await choose(page, 'New items start in', 'To Do');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(async () => {
      const res = await page.request.get(`api/v1/projects/${s.project.id}`);
      return ((await res.json()) as ProjectDto).settings.newItemBucketId;
    })
    .toBe(todo.id);

  // A row typed on the timeline lands there.
  await page.goto(`/p/${k}/timeline`);
  await page.getByRole('textbox', { name: /Type a title/ }).fill('Write FAQ');
  await page.keyboard.press('Enter');
  await expect(page.locator('[role="row"]', { hasText: 'Write FAQ' })).toBeVisible();
  const list = (await (
    await page.request.get(`api/v1/projects/${s.project.id}/items?q=Write%20FAQ`)
  ).json()) as { items: WorkItemDetailDto[] };
  expect(list.items[0]?.bucketId).toBe(todo.id);

  // A Story's Tasks follow it into another sprint, and one Undo brings them back.
  const s1 = await sprint(page, s.project.id, 'Sprint 1');
  const s2 = await sprint(page, s.project.id, 'Sprint 2');
  const story = await s.make({ type: 'STORY', title: 'Checkout', sprintId: s1.id });
  const task = await s.make({ type: 'TASK', title: 'Card form', parentId: story.id });
  expect(task.sprintId).toBe(s1.id);
  await page.goto(`/p/${k}/items/${story.number}`);
  await page.getByRole('combobox', { name: 'Sprint' }).click();
  await page.getByRole('option', { name: /^Sprint 2/ }).click();
  await expect.poll(async () => (await s.item(task.id)).sprintId).toBe(s2.id);
  const toast = page.locator('.k-toast').filter({ hasText: 'Sprint saved' }).first();
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await s.item(task.id)).sprintId).toBe(s1.id);
  await expect.poll(async () => (await s.item(story.id)).sprintId).toBe(s1.id);

  // An ad-hoc item is on the board but not on the timeline.
  await s.make({ type: 'TASK', title: 'Call the vendor', adHoc: true });
  await page.goto(`/p/${k}`);
  const card = page.locator('app-item-card', { hasText: 'Call the vendor' });
  await expect(card).toBeVisible();
  await expect(card.getByText('Ad hoc')).toBeVisible();
  await snap(page, 'board-ad-hoc-card');
  await page.goto(`/p/${k}/timeline`);
  await expect(page.getByRole('grid', { name: 'Plan' })).toBeVisible();
  await expect(page.locator('[role="row"]', { hasText: 'Call the vendor' })).toHaveCount(0);
  await expect(page.getByTestId('ad-hoc-note')).toContainText('1 ad-hoc item is not in');
});

test('item keys link to the item with a preview and show up under "Referenced in"', async ({
  page,
}) => {
  await signIn(page, USERS.admin);
  const s = await space(page, 'REFS');
  const k = s.project.key!;
  const target = await s.make({ type: 'TASK', title: 'Rotate the keys' });
  const source = await s.make({ type: 'TASK', title: 'Security review' });
  const note = await page.request.post(`api/v1/projects/${s.project.id}/items/${source.id}/notes`, {
    headers,
    data: { body: `<p>Blocked on #${target.number}</p>` },
  });
  expect(note.status()).toBe(201);

  await page.goto(`/p/${k}/items/${source.number}`);
  const link = page.locator('.note-body a.k-ref', { hasText: `${k}-${target.number}` });
  await expect(link).toBeVisible();
  await link.hover();
  await expect(page.locator('.k-ref-card')).toContainText('Rotate the keys');
  await snap(page, 'reference-preview');
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/p/${k}/items/${target.number}$`));
  const referenced = page.locator('section', {
    has: page.getByRole('heading', { name: 'Referenced in' }),
  });
  await expect(referenced).toContainText('Security review');
});

test('a delete disappears for others at once, and a restore from the Trash brings it back', async ({
  browser,
}) => {
  const pm = await person(browser, USERS.admin);
  const s = await space(pm, 'LIVT');
  const k = s.project.key!;
  const candidates = (await (
    await pm.request.get(`api/v1/projects/${s.project.id}/member-candidates?q=member`)
  ).json()) as MemberCandidateDto[];
  const memberId = candidates.find((c) => c.email === USERS.member)?.id ?? '';
  const added = await pm.request.post(`api/v1/projects/${s.project.id}/members`, {
    headers,
    data: { userId: memberId, role: 'MEMBER' },
  });
  expect(added.status()).toBe(201);
  const todo = s.buckets.find((b) => b.name === 'To Do')!;
  const shared = await s.make({ type: 'TASK', title: 'Shared card', bucketId: todo.id });

  const member = await person(browser, USERS.member);
  await member.goto(`/p/${k}`);
  const column = member.locator('section.column[aria-label="To Do"]');
  await expect(column.getByText('Shared card')).toBeVisible();

  // The PM deletes it from the drawer; the Member's board drops it live.
  await pm.goto(`/p/${k}/items/${shared.number}`);
  await pm.getByRole('button', { name: 'More actions' }).click();
  await pm.getByRole('menuitem', { name: /Delete item/ }).click();
  const dialog = pm.getByRole('dialog', { name: `Delete ${k}-${shared.number}?` });
  await expect(dialog).toContainText('trash');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(pm.locator('.k-toast').filter({ hasText: 'moved to the trash' })).toBeVisible();
  await expect(column.getByText('Shared card')).toHaveCount(0);

  // Restoring from Project › Settings › Trash brings it back for the Member too.
  await pm.goto(`/p/${k}/settings/trash`);
  const batch = pm.getByTestId('trash-batch').filter({ hasText: 'Shared card' });
  await expect(batch).toContainText('Deleted');
  await snap(pm, 'trash-page');
  await batch.getByRole('button', { name: 'Restore' }).click();
  await expect(pm.getByTestId('trash-batch')).toHaveCount(0);
  await expect(column.getByText('Shared card')).toBeVisible();
  await snap(member, 'member-board-after-restore');
});
