import { expect, type Page } from '@playwright/test';

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
 * Member), and an overdue Bug without a parent.
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
  await expect(page.getByRole('link', { name: PROJECT_KEY })).toBeVisible();
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
