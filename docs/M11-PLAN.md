# M11: technical documentation and API reference

Planning baseline: 2026-11-02. Status: approved in outline by the owner (2026-11-02); this plan adds the detail.
Starts after M10 is committed, so the documentation covers live updates.

## 1. Goals and constraints

- A public, accurate technical description of Kloister for someone who wants to understand, run, extend or
  review it: how the parts fit, how requests are authorized, the database schema, the scheduling rules, the
  live-update stream and every API route.
- A summary for a first read and detailed documents for each area, rather than one long file.
- Generated where possible, so it cannot drift: the API reference and the schema diagram come from the code
  and CI fails when they are stale.
- Tracked files follow the repository hygiene rules (no tool or vendor names; refer to "the project
  workflow"). No employer names or brands. Example data uses example.org.
- No behaviour change. The only code changes are documentation metadata on controllers and DTOs (OpenAPI
  decorators, response types) and small generator scripts.

## 2. What already exists

- `docs/openapi.json` is generated on every API build (`node dist/cli/openapi.js`) and checked by
  `deploy/openapi.test.mjs`. At planning time: 130 operations, 52 schemas; 41 operations have no response
  schema; no shared error schema, no examples; the version reads "development".
- User and operator guides: README, INSTALL, UPGRADE, ADMIN, RHEL-ACCEPTANCE, ADO-TRANSFER-GUIDE,
  ADO-EXPORT. Design: DESIGN.md. Decisions and milestone plans: DECISIONS.md, M8–M10 plans.
- Every exported symbol already has a doc comment (SPEC §11), which the documents link to rather than repeat.

## 3. Documents

All under `docs/technical/`, linked from the README's "Technical documentation" section.

| File                                | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `README.md`                         | Summary (two screens): what Kloister is technically, a component diagram, the life of a request (browser → httpd → API → guards → service → PostgreSQL → audit → live event), the main design rules (authorization in the API, 404 for hidden items, audit everything, no outbound calls), and a map of the other documents                                                                                                                                                          |
| `ARCHITECTURE.md`                   | Repository layout; API modules and their responsibilities; the Fastify/Nest setup; configuration and environment variables; sessions, CSRF header and timeouts; logging and retention; backups; the job scheduler (due-date notifications, clean-ups); build and packaging; how the web app is served under a path prefix                                                                                                                                                            |
| `SECURITY.md`                       | Accounts and password hashing; roles (system and project); visibility scopes; teams and team Leads; personal spaces; the plan setting and own unscheduled items; non-disclosure rules (404 vs 403, title-only ancestors, hidden links); `ItemsService.scoped()` and its documented exceptions; uploads and content sniffing; rich-text sanitizing and mentions; audit log and cross-project visits; live-update filtering; what is deliberately not supported (SSO, email, webhooks) |
| `DATA-MODEL.md`                     | Every table with its purpose, key columns, relations, constraints and indexes; a Mermaid ER diagram generated from `schema.prisma`; enums; the settings JSON (project and app settings) with defaults and how missing keys read; migrations policy (additive, offline diff)                                                                                                                                                                                                          |
| `SCHEDULING.md`                     | The timeline model: half-day slots, working days, holidays (instance and project), durations, pins, finish-to-start links, the planner (`planSchedule`), automatic vs confirmed moves, version and preview checks, Undo, what a Member may change, parent spans and plan totals, the Excel Timeline sheet                                                                                                                                                                            |
| `LIVE-UPDATES.md`                   | The M10 stream: events, publishing from the audited write, LISTEN/NOTIFY, fan-out and filtering, presence, client batching and deferral, reconnects, the admin switch, httpd notes                                                                                                                                                                                                                                                                                                   |
| `WEB.md`                            | Angular structure; routes; the project store and how views share it; shared UI (`ui/`), tokens and theming; dialogs and toasts; keyboard shortcuts; accessibility patterns; bundle budget and lazy loading; how to add a screen                                                                                                                                                                                                                                                      |
| `ADO-TRANSFER.md`                   | Internals of the CSV transfer: profiles, export plans, link tracking, review modes, previews and expiry, conflict rules, limits (user-facing guides stay as they are)                                                                                                                                                                                                                                                                                                                |
| `API.md`                            | Generated reference (section 4)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `TESTING.md`                        | Test layers (shared and API unit, API HTTP without a database, database tests in CI, browser tests in CI, deployment tests); fixtures and helpers; how to add a permission test; how CI is organised                                                                                                                                                                                                                                                                                 |
| `CONTRIBUTING.md` (repository root) | How to set up a development environment, the local gate, commit style, and where decisions are recorded                                                                                                                                                                                                                                                                                                                                                                              |

Diagrams use Mermaid in Markdown (rendered by GitHub); no image files to maintain.

## 4. API reference

- Complete the OpenAPI document:
  - every operation has a response schema (including 204 and file downloads), tags per area, a summary and
    the permission it needs (from `@RequireProjectPermission` and the admin guard);
  - one shared error schema (`ApiError`: status, code, message, field) referenced from 400/401/403/404/409/413;
  - request and response examples for the main routes (items, timeline reschedule, notes, sprints);
  - the session cookie and the required `x-requested-with` header as security schemes;
  - the release version from the root `package.json`;
  - the live-update stream (`text/event-stream`) and its event kinds.
- `API.md` is generated from `docs/openapi.json` by a script (`deploy/api-reference.mjs`, no new dependency):
  an introduction (authentication, errors, pagination with cursors, item references by uuid or number,
  rate and size limits), then one section per tag with each route's method, path, permission, parameters,
  request and response shapes.
- CI: the existing build regenerates `openapi.json`; a new deployment test fails when the committed
  `openapi.json` or `API.md` differs from what the build produces, and when an operation lacks a response
  schema or summary.
- No interactive Swagger UI in the app (no extra runtime library, no exposed explorer); `openapi.json` opens
  in any OpenAPI viewer, which `API.md` mentions.

## 5. Keeping documents true

- A deployment test checks that every Prisma model and enum appears in `DATA-MODEL.md`, and that every API
  module under `apps/api/src` is mentioned in `ARCHITECTURE.md`.
- The ER diagram block in `DATA-MODEL.md` is generated (`deploy/schema-diagram.mjs`) between marker comments;
  the test fails when it is stale.
- Later milestones update the documents in the same commit as the code (added to the project workflow notes).

## 6. Live updates

- M10 must be committed first. `LIVE-UPDATES.md` and the stream entry in the API reference describe M10 as
  built, including its event kinds and the audit-action mapping.

## 7. Files (expected)

- New: `docs/technical/*.md` (section 3), `CONTRIBUTING.md`, `deploy/api-reference.mjs`,
  `deploy/schema-diagram.mjs`, tests in `deploy/`.
- Changed: API controllers and DTOs (OpenAPI decorators and response types only), `apps/api/src/cli/openapi.ts`
  (version, security schemes, error schema), `README.md` (links), `docs/openapi.json` (regenerated).

## 8. Verification

- Local gate as usual; deployment tests for the generators and the stale checks.
- Independent review with fresh context: accuracy against the code (spot-check each document's claims),
  completeness (every module, table and route), hygiene (no banned names), and readability for a newcomer.
- No database or browser test changes are expected.
