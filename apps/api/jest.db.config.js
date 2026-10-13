import base from './jest.config.js';

/**
 * Jest configuration for tests against a real Postgres (`npm run test:db`).
 *
 * Run in CI against a service container after `prisma migrate deploy`;
 * `DATABASE_URL` must point at a disposable database because each test file
 * truncates every table. Files run one at a time for the same reason.
 *
 * @type {import('jest').Config}
 */
export default {
  ...base,
  roots: ['<rootDir>/test/db'],
  testRegex: '\\.db-spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/'],
  setupFiles: [],
  maxWorkers: 1,
  // Permission matrices sign in many times, and argon2 is slow by design.
  testTimeout: 30_000,
};
