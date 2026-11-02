# Contributing to Kloister

Thank you for taking an interest. This guide covers setting up a development environment, the
checks every change must pass, and how changes are recorded. The technical documentation starts at
[docs/technical/README.md](docs/technical/README.md); the product rules are in [SPEC.md](SPEC.md),
which is the source of truth when anything disagrees.

## Development environment

You need:

- Node.js 24 (`.nvmrc`; at least 24.11, per `engines` in `package.json`) and npm 11;
- Git, and Bash for the deployment tests (Git Bash on Windows);
- PostgreSQL 18 only if you want to run the backend or the database and browser tests locally.

```bash
git clone https://github.com/saptashwab/kloister.git
cd kloister
npm ci
npm run build
```

To run the app against a local database, follow "Run from source" in the [README](README.md). In
short: set `DATABASE_URL` and the data folders, run `npm run migrate:deploy -w @kloister/api`,
create the first administrator with `npm run create-admin -w @kloister/api`, start the API with
`npm run start:dev -w @kloister/api` and the web app with `npm start -w @kloister/web`, then open
`http://localhost:4200/`. The Angular dev server proxies `/api` to the API on port 3000.

## The local gate

Every change must pass, from a clean install:

```bash
npm ci && npm run format:check && npm run lint && npm run build && npm test
```

`npm test` runs the unit tests of every workspace and the deployment and documentation tests in
`deploy/`. Database and browser tests need PostgreSQL; they always run in CI. Without a database,
at least type-check them:

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/e2e/tsconfig.json
```

With a disposable database (each database test file empties every table):

```bash
npm run migrate:deploy -w @kloister/api
npm run test:db -w @kloister/api
```

Never weaken a lint rule, skip a test or raise a bundle budget to get a change through. See
[TESTING.md](docs/technical/TESTING.md) for the test layers and helpers.

## Writing code

- **Authorization belongs in the API.** Every new route declares its permission and gets
  permission tests for every role, a non-member and hidden items (see
  [SECURITY.md](docs/technical/SECURITY.md) and [TESTING.md](docs/technical/TESTING.md)).
- **Doc comments.** Every exported class, function, service, guard, controller method and
  component has a doc comment explaining its purpose, parameters and permission implications;
  lint enforces it. Non-obvious logic gets a comment explaining why.
- **No hard-coded names, colours, hosts or paths.** Brand and look come from settings and design
  tokens; paths from configuration.
- **No outbound calls.** The backend must not contact other hosts at runtime.
- **Shared rules go in `packages/shared`**, so the API and the web app use the same code.
- **Migrations are additive.** Generate them offline as described in
  [DATA-MODEL.md](docs/technical/DATA-MODEL.md#migrations).
- **Deployment scripts** never change firewall, SELinux or httpd configuration beyond the one
  Kloister conf file, and comment every step.

## Keeping the documentation true

The API reference and the schema diagram are generated, and tests fail when they are stale. After
changing a route, a DTO, a doc comment that describes a route or the Prisma schema:

```bash
npm run build
npm run docs
```

and commit the regenerated `docs/openapi.json`, `docs/technical/API.md` and
`docs/technical/DATA-MODEL.md`. A new Prisma model or enum must be described in DATA-MODEL.md and
a new API module in ARCHITECTURE.md; tests check both. Update the other technical documents in the
same commit as the code they describe.

## Commits and decisions

- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`,
  `refactor:`, `chore:`, with a scope where it helps, for example
  `feat(timeline): add holidays (M9.1)`. The body summarises what changed and any decisions.
- Work is planned in milestones (SPEC §10). A milestone ends with the local gate green and one
  commit.
- When the specification leaves a choice open, pick the option closest to it and record it in
  [docs/DECISIONS.md](docs/DECISIONS.md) with the date, milestone, decision and reason. Choices
  that would change the project layout, the deployment model, the data model or a security
  behaviour are agreed with the maintainer first.
- The `version` in the root `package.json` is the next release with a `-dev` suffix between
  releases; release preparation sets the release version, which the API reference shows.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
