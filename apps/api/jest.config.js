/**
 * Jest configuration for the API tests that need no database (`npm test`).
 *
 * NestJS 12 ships as native ESM, so tests run with `--experimental-vm-modules`
 * (set by the `test` script) and ts-jest in ESM mode. The mapper strips the
 * `.js` suffix that NodeNext resolution requires in relative imports.
 *
 * Unit tests live next to the code (`src/**\/*.spec.ts`); HTTP-level tests
 * that boot the whole app live in `test/` (`*.e2e-spec.ts`). Tests that need
 * Postgres live in `test/db/` and run via `jest.db.config.js` in CI.
 *
 * @type {import('jest').Config}
 */
export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '\\.(e2e-)?spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/db/'],
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: '<rootDir>/tsconfig.json' }],
  },
};
