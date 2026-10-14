import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';

/**
 * The API's server folder in the browser tests (`APP_DIR`): attachments,
 * branding files, backups and logs all go below it, so the storage screen
 * measures something real and nothing lands anywhere else.
 */
export const E2E_SERVER_DIR = join(tmpdir(), 'kloister-e2e-server');

/**
 * A stand-in for pg_dump that writes a small file, written by the seed
 * step. The CI runner's own pg_dump is older than the Postgres service and
 * would refuse to dump it (see docs/DECISIONS.md, M6).
 */
export const E2E_PG_DUMP = join(E2E_SERVER_DIR, 'bin', 'pg_dump');

/**
 * Password every seeded test user ends up with. These accounts exist only in
 * the throwaway CI database, so a fixed test value is enough.
 */
export const E2E_PASSWORD = 'e2e-password-not-secret-42';

/** Seeded users by role; all use {@link E2E_PASSWORD}. */
export const USERS = {
  admin: 'admin@example.org',
  pm: 'pm@example.org',
  member: 'member@example.org',
  viewer: 'viewer@example.org',
} as const;

/** Key of the seeded project. */
export const PROJECT_KEY = 'KLO';

/**
 * Item numbers of the seeded project, in creation order: an Epic, a Feature
 * and a Story under it, two Tasks under the Story (the first assigned to the
 * Member and labelled frontend, the second to the PM and labelled backend),
 * and an overdue Bug without a parent, labelled backend and customer.
 */
export const ITEMS = { epic: 1, feature: 2, story: 3, taskA: 4, taskB: 5, bug: 6 } as const;

/**
 * Signs in through the login form and waits for the project list.
 *
 * @param page The browser page.
 * @param email The user's email.
 * @returns Resolves once signed in.
 */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // The project list's key link (the sidebar link also names the project).
  await expect(page.getByRole('link', { name: PROJECT_KEY, exact: true })).toBeVisible();
}

/**
 * Picks an option of a Material select, found by its field label.
 *
 * @param page The browser page.
 * @param label The form field label.
 * @param option The option text.
 * @returns Resolves once picked.
 */
export async function choose(page: Page, label: string, option: string): Promise<void> {
  await page.locator('mat-form-field', { hasText: label }).locator('mat-select').click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
