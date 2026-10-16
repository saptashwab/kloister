import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';
import type { AdoProfile, WorkItemDto } from '@kloister/shared';
import { choose, signIn, USERS } from './support';

const headers = { 'X-Requested-With': 'kloister' };
async function setup(page: Page) {
  await signIn(page, USERS.pm);
  const project = (await (await page.request.get('api/v1/projects/KLO')).json()) as { id: string };
  const buckets = (await (
    await page.request.get(`api/v1/projects/${project.id}/buckets`)
  ).json()) as { items: { id: string }[] };
  const bucket = buckets.items[0].id;
  const previous = (await (
    await page.request.get(`api/v1/projects/${project.id}/ado/destination`)
  ).json()) as { revision: number } | null;
  const states = { NOT_STARTED: null, IN_PROGRESS: null, BLOCKED: null, DONE: null };
  const profile: AdoProfile = {
    process: 'Agile',
    types: { EPIC: 'Epic', FEATURE: 'Feature', STORY: 'User Story', TASK: 'Task', BUG: 'Bug' },
    reverseTypes: { Task: 'TASK' },
    states: {
      EPIC: { ...states },
      FEATURE: { ...states },
      STORY: { ...states },
      TASK: { ...states, BLOCKED: 'Active' },
      BUG: { ...states },
    },
    incomingStates: { 'Task\nNew': { status: 'NOT_STARTED', bucketId: bucket } },
    fields: {},
    dateTypes: {},
    identities: {},
    incomingIdentities: {},
    tags: {},
    iterations: {},
    iterationRoot: '',
    area: '',
    constants: [],
  };
  const saved = await page.request.put(`api/v1/projects/${project.id}/ado/destination`, {
    headers,
    data: {
      organization: 'synthetic-collection',
      remoteProject: 'synthetic-project',
      profile,
      revision: previous?.revision ?? 0,
    },
  });
  expect(saved.status()).toBe(200);
  return { project: project.id, bucket };
}
async function csvFromDownload(page: Page): Promise<string> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download reserved CSV files' }).click();
  const stream = await (await pending).createReadStream();
  if (!stream) throw new Error('Download stream missing');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const bytes: unknown = chunk;
    if (!(bytes instanceof Uint8Array)) throw new Error('Non-binary download chunk');
    chunks.push(Buffer.from(bytes));
  }
  const zip = await JSZip.loadAsync(Buffer.concat(chunks));
  const file = Object.values(zip.files).find((f) => !f.dir);
  if (!file) throw new Error('CSV archive is empty');
  return file.async('string');
}
async function upload(page: Page, csv: string): Promise<void> {
  const input = page.locator('input[type=file]');
  await expect(input).toBeEnabled();
  await input.setInputFiles({
    name: 'synthetic-return.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf8'),
  });
  await expect(page.getByRole('region', { name: 'Transfer preview', exact: true })).toHaveCount(0);
  await expect(page.getByText('synthetic-return.csv', { exact: true })).toBeVisible();
  await expect(input).toBeEnabled();
  await page.getByRole('checkbox', { name: /I confirm this file belongs/ }).check();
}

test('local starting point reserves creates, reconciles real IDs and exports post-creation intent', async ({
  page,
}, info) => {
  const { project, bucket } = await setup(page);
  const source = (await (
    await page.request.post(`api/v1/projects/${project}/items`, {
      headers,
      data: { type: 'TASK', title: 'Transfer local example', status: 'BLOCKED', bucketId: bucket },
    })
  ).json()) as WorkItemDto;
  await page.goto(`/p/KLO/ado?items=${source.id}`);
  await expect(page.getByRole('heading', { name: 'ADO transfer', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preview export CSV', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare reviewed CSV files' }).click();
  const create = await csvFromDownload(page);
  expect(create).not.toMatch(/"State"|"Assigned To"|"ID"/);
  const reference = create.match(/Kloister reference: ([a-f0-9]{64})/)?.[1];
  expect(reference).toBeTruthy();
  const stored = (await (
    await page.request.get(`api/v1/projects/${project}/ado/batches`)
  ).json()) as { items: { id: string }[] };
  expect(stored.items.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Import / reconcile CSV', exact: true }).click();
  // Return the complete generated Description footer from the independent create contract.
  const description = `<hr /><p>Kloister transfer details (generated; not structured entities)</p><p>Kloister reference: ${reference}</p>`;
  await upload(
    page,
    `ID,Work Item Type,Title,State,Description,Parent,Assigned To\r\n71001,Task,Transfer local example,New,${description},,\r\n`,
  );
  await page.getByRole('button', { name: 'Preview incoming CSV' }).click();
  await page.getByRole('button', { name: /Apply 1 reviewed rows/ }).click();
  await expect(page.getByRole('heading', { name: /Review.*APPLIED/ })).toBeVisible();
  expect(
    (
      (await (
        await page.request.get(`api/v1/projects/${project}/items/${source.id}`)
      ).json()) as WorkItemDto
    ).status,
  ).toBe('BLOCKED');
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  await page.getByRole('checkbox', { name: /I reviewed observation times/ }).check();
  await page.getByRole('button', { name: 'Preview export CSV', exact: true }).click();
  await choose(page, 'Choose status for Transfer local example', 'Use local in file');
  await page.getByRole('button', { name: 'Preview export CSV', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare reviewed CSV files' }).click();
  const update = await csvFromDownload(page);
  expect(update).toContain('"ID"');
  expect(update).toContain('"71001"');
  expect(update).toContain('"Active"');
  await info.attach('returned IDs and staged status update', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('ADO starting point needs explicit new-row and field review, preserves counts on partial repeat', async ({
  page,
}, info) => {
  const { project } = await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/p/KLO/ado');
  await page.getByRole('button', { name: 'Import / reconcile CSV', exact: true }).click();
  await choose(page, 'Incoming workflow', 'Import reviewed local changes / new rows');
  const csv = 'ID,Work Item Type,Title,State\r\n72001,Task,Remote starting example,New\r\n';
  await upload(page, csv);
  await page.getByRole('button', { name: 'Preview incoming CSV' }).click();
  await page.getByRole('checkbox', { name: /I confirm this ID is new/ }).check();
  await page.getByRole('button', { name: 'Preview incoming CSV' }).click();
  for (const field of ['title', 'type', 'status', 'bucketId'])
    await choose(page, `Choose ${field} for Remote starting example`, 'Take incoming');
  await page.getByRole('button', { name: 'Preview incoming CSV' }).click();
  await page.getByRole('button', { name: 'Apply 1 reviewed rows' }).click();
  await expect(page.getByRole('heading', { name: /Review.*APPLIED/ })).toBeVisible();
  await upload(page, csv);
  await page.getByRole('button', { name: 'Preview incoming CSV' }).click();
  await expect(page.getByRole('heading', { name: /Review.*PREVIEW/ })).toBeVisible();
  await page.getByRole('button', { name: 'Apply 1 reviewed rows' }).click();
  await expect(page.getByRole('heading', { name: /Review.*APPLIED/ })).toBeVisible();
  const results = (await (
    await page.request.get(`api/v1/projects/${project}/items?q=Remote%20starting%20example`)
  ).json()) as { items: WorkItemDto[] };
  expect(results.items).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await info.attach('phone incoming repeat with stable count', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('Viewers retain snapshots and cannot open transfer controls or API', async ({ page }) => {
  await signIn(page, USERS.viewer);
  await page.goto('/p/KLO');
  await expect(page.getByRole('link', { name: 'ADO transfer', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export…', exact: true })).toBeVisible();
  expect((await page.request.get('api/v1/projects/KLO/ado/profile')).status()).toBe(403);
  await page.goto('/p/KLO/ado');
  await expect(page.getByRole('alert')).toContainText('requires project PM or project Lead');
});
