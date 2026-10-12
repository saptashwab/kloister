/**
 * Jest configuration for @kloister/shared.
 *
 * The package is native ESM, so tests run with `--experimental-vm-modules`
 * (set by the `test` script) and ts-jest in ESM mode. The mapper strips the
 * `.js` suffix that NodeNext resolution requires in relative imports.
 *
 * @type {import('jest').Config}
 */
export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testRegex: '\\.spec\\.ts$',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: '<rootDir>/tsconfig.json' }],
  },
};
