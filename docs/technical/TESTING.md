# Testing

Kloister is tested in five layers. The first three need no database and run on every developer
machine; database and browser tests run in CI against a disposable PostgreSQL.

| Layer               | Where                                                      | Runs with                                                 | Needs                              |
| ------------------- | ---------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------- |
| Shared unit tests   | `packages/shared/src/**/*.spec.ts`                         | `npm test` (Jest)                                         | nothing                            |
| API unit and HTTP   | `apps/api/src/**/*.spec.ts`, `apps/api/test/*.e2e-spec.ts` | `npm test` (Jest)                                         | nothing                            |
| Web unit tests      | `apps/web/src/**/*.spec.ts`                                | `npm test` (Angular unit-test builder, Vitest with jsdom) | nothing                            |
| Deployment and docs | `deploy/*.test.mjs`                                        | `npm test` (`node --test`)                                | a build; Bash for the script tests |
| Database tests      | `apps/api/test/db/*.db-spec.ts`                            | `npm run test:db -w @kloister/api`                        | PostgreSQL with migrations applied |
| Browser tests       | `apps/web/e2e/*.e2e-spec.ts`                               | `npm run test:e2e -w @kloister/web` (Playwright)          | PostgreSQL, a build, Chromium      |

## The local gate

```bash
npm ci && npm run format:check && npm run lint && npm run build && npm test
```

`npm test` runs every workspace's unit tests, then the deployment tests. On a machine without a
database, also type-check the tests that only CI runs:

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/e2e/tsconfig.json
cd apps/web && npx playwright test -c e2e/playwright.config.ts --list
```

## API tests without a database

- **Unit tests** sit next to the code. Services get a fake Prisma client
  (`apps/api/test/support/fakes.ts`: `fakePrisma()`, `fakeAudit()`, `fakeSettings()`,
  `makeUser()`, `makeProject()`, `makeConfig()`), so rules can be tested in isolation.
- **HTTP tests** in `apps/api/test/*.e2e-spec.ts` boot the whole app and send requests with
  Fastify's `inject`. They cover what is decided before any query: the CSRF and session guards,
  public routes, validation and error shapes.
- Jest runs in ESM mode (`--experimental-vm-modules`, ts-jest); `test/setup-env.ts` provides a
  configuration that never reaches a real database.

## Database tests

`apps/api/test/db/` boots the real app (`startApp()`) against `DATABASE_URL`. Each file truncates
every table (`resetDb()`), so the database must be disposable and files run one at a time. Seed
helpers in `support.ts` create users (password `PASSWORD`), projects with members and roles,
teams, buckets, items, labels, sprints, notes and attachments; `call()` sends a request with the
CSRF header and an optional session, `login()` returns a session token, `codeOf()` reads an error
code. Backups use a stand-in `pg_dump` script.

Prisma's nested creates fill relation columns from the parent; passing them again type-checks but
fails at runtime, so seed helpers leave them out.

### Adding a permission test

Every new route gets its permission matrix as a database test: one request per role, plus a
non-member and, where relevant, an administrator who is not a member and the owner of a personal
space. Assert both the status and the error code, and that a refused write changed nothing.

```ts
const cases: [Name, number][] = [
  ['pm', 201],
  ['lead', 201],
  ['member', 403],
  ['viewer', 403],
  ['outsider', 404], // not a member: the project's existence is not disclosed
  ['admin', 403], // a visiting administrator is read-only
];
for (const [name, status] of cases) {
  const res = await as(name, 'POST', `/api/v1/projects/${projectId}/holidays`, body);
  expect(res.statusCode).toBe(status);
}
```

Also cover visibility: an item outside the caller's scope must answer 404 on every route that
names it, and lists must leave it out.

M13 adds `reports.db-spec.ts`: shares under the plan setting, every report and the My work
calendar per role, and reports that never count hidden items.

## Web unit tests

Components and services are tested with Angular's `TestBed`; HTTP calls go through
`HttpTestingController` or mocked API services. Builders in `src/testing/fixtures.ts`
(`makeProject`, `makeItem`, `makeBucket`, `makeMember`, `makeSprint`) keep tests short. Use
`settle(fixture)` instead of `whenStable()` when mocked API promises must finish. Pure logic in
`core/` is tested as plain functions.

## Browser tests

Playwright tests in `apps/web/e2e/` drive Chromium against the real API and database:

- `playwright.config.ts` starts the built API and the Angular dev server (which proxies `/api`).
  The `seed` project (`seed.setup.ts`) creates the first administrator with the real CLI and the
  test data through the API; the other tests depend on it.
- `support.ts` holds the seeded users (example.org addresses), the project key, item numbers and
  helpers such as `signIn()`.
- Tests run in one worker without retries. Every test takes a screenshot; failures keep a trace.
  The HTML report is uploaded from CI as the `e2e-report` artifact.
- Each milestone adds browser tests for its new screens, including keyboard paths and phone width.

## Deployment and documentation tests

`deploy/*.test.mjs` run with Node's test runner:

- `deployment.test.mjs`: every script parses in Bash with strict error handling; configuration
  validation; the httpd template and its install and rollback handling; health checks and
  logging;
- `upgrade-helper.test.mjs`: the upgrade helper's functions with mocked system tools;
- `openapi.test.mjs`: the generated API document is complete (every operation has a summary, a
  permission, a tag and a response schema; references resolve; the worked examples match the
  schemas) and `docs/openapi.json` and `docs/technical/API.md` match the build;
- `docs.test.mjs`: the schema diagram in [DATA-MODEL.md](DATA-MODEL.md) matches `schema.prisma`,
  every model and enum is described there, and every API module is described in
  [ARCHITECTURE.md](ARCHITECTURE.md).

After changing a route, a DTO, a doc comment or the schema, run `npm run build` and `npm run docs`
and commit the regenerated files. CI skips pushes that change only Markdown or `docs/`, so a
hand-edited `API.md`, `openapi.json` or diagram is caught only by the next code push; regenerate
instead of editing them.

## CI

`.github/workflows/ci.yml` has one job on `ubuntu-latest`, triggered by pushes to `main`, pull
requests and manual runs (documentation-only changes are skipped). It uses the Node version in
`.nvmrc` and a PostgreSQL service container. In order:

1. `npm ci`, format check, build, lint, `npm test`;
2. package the release ZIP and verify it extracted;
3. apply the migrations and fail if `schema.prisma` has changes without a migration;
4. database tests;
5. a second empty database, migrations, Chromium, browser tests;
6. upload the browser report and the API's logs from the browser run.

`release.yml` runs only on `v*` tags and builds, packages and verifies the release ZIP.
