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
  const policy = await page.request.put(`api/v1/projects/${project.id}/ado/review-policy`, {
    headers,
    data: { requireDetailedReview: false },
  });
  expect(policy.status()).toBe(200);
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
  await page.getByRole('tab', { name: 'Import from ADO', exact: true }).click();
  // Return the complete generated Description footer from the independent create contract.
  const description = `<hr /><p>Kloister transfer details (generated; not structured entities)</p><p>Kloister reference: ${reference}</p>`;
  await upload(
    page,
    `ID,Work Item Type,Title,State,Description,Parent,Assigned To\r\n71001,Task,Transfer local example,New,${description},,\r\n`,
  );
  await page.getByRole('button', { name: 'Preview incoming CSV' }).click();
  await page.getByRole('button', { name: 'Apply 1 reviewed row', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Review.*Applied/ })).toBeVisible();
  expect(
    (
      (await (
        await page.request.get(`api/v1/projects/${project}/items/${source.id}`)
      ).json()) as WorkItemDto
    ).status,
  ).toBe('BLOCKED');
  // Quick review sends the intended local state without a per-field choice: ADO only holds its default.
  await page
    .getByRole('button', { name: 'Prepare the follow-up update (state and assignee)' })
    .click();
  await expect(page.getByRole('tab', { name: 'Export to ADO', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('checkbox', { name: /I reviewed observation times/ }).check();
  await page.getByRole('button', { name: 'Preview export CSV', exact: true }).click();
  await expect(page.getByText(/Sent to ADO: Status ×1/)).toBeVisible();
  await page.getByRole('button', { name: 'Prepare reviewed CSV files' }).click();
  const update = await csvFromDownload(page);
  expect(update.split('\r\n')[0]).toBe('﻿"ID","Work Item Type","Title","State"');
  expect(update).toContain('"71001"');
  expect(update).toContain('"Active"');
  await info.attach('returned IDs and staged status update', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('ADO starting point needs explicit new-row confirmation and preserves counts on repeat', async ({
  page,
}, info) => {
  const { project } = await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/p/KLO/ado');
  await page.getByRole('tab', { name: 'Import from ADO', exact: true }).click();
  await choose(page, 'Incoming workflow', 'Import reviewed local changes / new rows');
  const csv = 'ID,Work Item Type,Title,State\r\n72001,Task,Remote starting example,New\r\n';
  await upload(page, csv);
  await page.getByRole('button', { name: 'Preview incoming CSV' }).click();
  await page.getByRole('button', { name: 'Confirm all unmatched rows as new items' }).click();
  await page.getByRole('button', { name: 'Preview incoming CSV' }).click();
  // Quick review takes every value of a confirmed new row; the choices stay visible and editable.
  await expect(
    page.getByRole('combobox', { name: 'Choose Title for Remote starting example' }),
  ).toContainText('Take ADO value');
  await page.getByRole('button', { name: 'Apply 1 reviewed row', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Review.*Applied/ })).toBeVisible();
  await upload(page, csv);
  await page.getByRole('button', { name: 'Preview incoming CSV' }).click();
  await expect(page.getByRole('heading', { name: /Review.*Not applied yet/ })).toBeVisible();
  await page.getByRole('button', { name: 'Apply 1 reviewed row', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Review.*Applied/ })).toBeVisible();
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

test('PM sets up from a sample export and can require Detailed review', async ({ page }, info) => {
  await setup(page);
  await page.goto('/p/KLO/ado');
  await expect(page.getByRole('tab', { name: 'ADO transfer', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Transfer settings', exact: true }).click();
  const sample = [
    'ID,Work Item Type,Title,State,Assigned To,Tags,Target Date',
    '1,User Story,Sample story,Resolved,Example Person <person@example.org>,sample-tag,18/12/2026 05:30:00',
    '2,Task,Sample task,Active,,,',
  ].join('\r\n');
  await page.locator('input[type=file]').setInputFiles({
    name: 'ado-sample.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(sample, 'utf8'),
  });
  await expect(page.getByRole('status').filter({ hasText: 'Looks like Agile' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'ADO tag' }).last()).toHaveValue('sample-tag');
  await page.getByRole('checkbox', { name: /Require Detailed review/ }).check();
  await page.getByRole('tab', { name: 'Export to ADO', exact: true }).click();
  await expect(
    page.getByText('A project PM requires Detailed review for this project.'),
  ).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Quick review' })).toBeDisabled();
  await info.attach('sample setup and required Detailed review', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await page.getByRole('tab', { name: 'Transfer settings', exact: true }).click();
  await page.getByRole('checkbox', { name: /Require Detailed review/ }).uncheck();
  await page.getByRole('tab', { name: 'Export to ADO', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Quick review' })).toBeEnabled();
});

test('Viewers retain snapshots and cannot open transfer controls or API', async ({ page }) => {
  await signIn(page, USERS.viewer);
  await page.goto('/p/KLO');
  await expect(page.getByRole('tab', { name: 'Board', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'ADO transfer', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export…', exact: true })).toBeVisible();
  expect((await page.request.get('api/v1/projects/KLO/ado/profile')).status()).toBe(403);
  await page.goto('/p/KLO/ado');
  await expect(page.getByRole('alert')).toContainText('requires project PM or project Lead');
});

test('guide walkthrough: settings, Quick export, return, follow-up and Detailed review', async ({
  page,
}, info) => {
  // Named screenshots for docs/ADO-TRANSFER-GUIDE.md, taken with example data.
  const { project, bucket } = await setup(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  // Toasts and closing overlays are hidden and animations stopped, so each shot shows
  // only the transfer screen; maxHeight keeps long forms to their first part.
  const shot = async (name: string, maxHeight?: number): Promise<void> => {
    await expect(page.getByText('Working…')).toHaveCount(0);
    const options = {
      animations: 'disabled' as const,
      style: '.cdk-overlay-container, .k-toast { display: none !important; }',
    };
    const screen = page.locator('app-ado-transfer');
    const box = await screen.boundingBox();
    if (!box) throw new Error('Transfer screen not visible');
    await info.attach(`guide: ${name}`, {
      body:
        maxHeight === undefined
          ? await screen.screenshot(options)
          : await page.screenshot({
              ...options,
              clip: { ...box, height: Math.min(box.height, maxHeight) },
            }),
      contentType: 'image/png',
    });
  };
  const source = (await (
    await page.request.post(`api/v1/projects/${project}/items`, {
      headers,
      // The example profile maps a Task's Blocked status to Active, so the follow-up sends it.
      data: { type: 'TASK', title: 'Guide example task', status: 'BLOCKED', bucketId: bucket },
    })
  ).json()) as WorkItemDto;

  await page.goto('/p/KLO/ado');
  await page.getByRole('tab', { name: 'Transfer settings', exact: true }).click();
  const sample = [
    'ID,Work Item Type,Title,State,Assigned To,Tags,Target Date',
    '1,User Story,Sample story,Active,Example Person <person@example.org>,sample-tag,18/12/2026 05:30:00',
    '2,Task,Sample task,New,,,',
  ].join('\r\n');
  await page.locator('input[type=file]').setInputFiles({
    name: 'ado-sample.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(sample, 'utf8'),
  });
  await expect(page.getByRole('status').filter({ hasText: 'Looks like Agile' })).toBeVisible();
  await shot('01 transfer settings from a sample export', 760);

  await page.goto(`/p/KLO/ado?items=${source.id}`);
  await page.getByRole('button', { name: 'Preview export CSV', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Prepare reviewed CSV files' })).toBeVisible();
  await shot('02 quick export preview');
  await page.getByRole('button', { name: 'Prepare reviewed CSV files' }).click();
  const create = await csvFromDownload(page);
  const reference = create.match(/Kloister reference: ([a-f0-9]{64})/)?.[1];
  expect(reference).toBeTruthy();
  await shot('03 create file prepared');

  await page.getByRole('tab', { name: 'Import from ADO', exact: true }).click();
  const description = `<hr /><p>Kloister transfer details (generated; not structured entities)</p><p>Kloister reference: ${reference}</p>`;
  await upload(
    page,
    `ID,Work Item Type,Title,State,Description,Parent,Assigned To\r\n73001,Task,Guide example task,New,${description},,\r\n`,
  );
  await page.getByRole('button', { name: 'Preview incoming CSV' }).click();
  await expect(
    page.getByRole('button', { name: 'Apply 1 reviewed row', exact: true }),
  ).toBeVisible();
  await shot('04 link returned IDs, quick summary');
  await page.getByRole('button', { name: 'Apply 1 reviewed row', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Review.*Applied/ })).toBeVisible();
  await shot('05 linked, follow-up offered');
  await page
    .getByRole('button', { name: 'Prepare the follow-up update (state and assignee)' })
    .click();
  await page.getByRole('checkbox', { name: /I reviewed observation times/ }).check();
  await page.getByRole('button', { name: 'Preview export CSV', exact: true }).click();
  await expect(page.getByText(/Sent to ADO: Status ×1/)).toBeVisible();
  await shot('06 follow-up update preview');

  // The same linked item retitled on both sides: Detailed review asks which wording wins.
  const renamed = await page.request.patch(`api/v1/projects/${project}/items/${source.id}`, {
    headers,
    data: { title: 'Guide example task (Kloister wording)' },
  });
  expect(renamed.status()).toBe(200);
  await page.getByRole('tab', { name: 'Import from ADO', exact: true }).click();
  await page.getByRole('radio', { name: 'Detailed review' }).click();
  await choose(page, 'Incoming workflow', 'Import reviewed local changes / new rows');
  await upload(
    page,
    'ID,Work Item Type,Title,State\r\n73001,Task,Guide example task (ADO wording),New\r\n',
  );
  await page.getByRole('button', { name: 'Preview incoming CSV' }).click();
  await expect(page.getByRole('combobox', { name: /^Choose Title for / })).toBeVisible();
  await shot('07 detailed review of a title changed on both sides');
  await page.getByRole('radio', { name: 'Quick review' }).click();

  await page.getByRole('tab', { name: 'Transfer history', exact: true }).click();
  await shot('08 transfer history');
});
