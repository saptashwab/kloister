# Kloister

A self-hosted Kanban tracker for teams that need their work to stay on their own
server. Local accounts, project permissions and bundled help work without SSO,
outbound email or external services at runtime.

Kloister is MIT licensed; see [LICENSE](LICENSE). The first usable release targets
v1.0. Release artifacts are prepared by the tag workflow; publication and RHEL VM
acceptance are owner actions. RHEL 8.10 x86_64 is the production deployment target.
Local tests and Linux CI do not establish that a particular server is validated.
ADO CSV export is planned for v1.1 and is not available yet.

## Your work, in context

- Boards with configurable buckets, status rules, labels, priorities and assignees.
- Epics, Features, Stories, Tasks and Bugs; backlog hierarchy, dependencies and sprints.
- My work across your projects, plus an owner-only personal space, in list or board views.
- Project roles, visibility scopes and optional teams with team Leads.
- Descriptions, checklists, notes, mentions, attachments and pasted inline images.
- In-app notifications, same-space duplication and independent copies per person.
- Permission-scoped Excel snapshots and optional offline archives with readable files.
- Light/dark themes, configurable branding and fonts, keyboard navigation, a short
  first-login introduction and searchable Help & FAQ with **Take the tour** replay.
- Administrator-managed accounts, security settings, database backups and log retention.

![Example project board](docs/screenshots/board.png)

![Example item drawer](docs/screenshots/item-drawer.png)

Screenshots show the current application with disposable example data. The
overlapping-squares control duplicates an item. See the sidebar's **Help & FAQ**
after signing in for detailed procedures and manual tour replay.

## Choose an installation path

For production on RHEL, use [INSTALL](docs/INSTALL.md), then keep
[UPGRADE](docs/UPGRADE.md) and [ADMIN](docs/ADMIN.md) with your operational runbook.
Those scripts use the fixed `/app/<app_name>` and httpd layout. They require root
for provisioning and always run the backend as an isolated account. They are not
portable installers for other systems.

For a source checkout or manual installation, the steps below describe the same
Node/PostgreSQL application without changing that production architecture. The
commands use **Bash on Linux**, Node 24 (at least 24.11), npm 11, PostgreSQL 18 and
its matching `pg_dump`/`pg_restore` tools. Install these prerequisites through your
system's approved sources, create a dedicated login role and database owned by
that role, and arrange local password authentication before continuing. Do not
use a database superuser for the application. No container deployment is supplied.
Windows is used for source builds/unit tests; Windows/macOS production service
installation has not been validated or automated by this project.

### Get the application

Download and extract the reviewed `kloister-<version>.zip` artifact from a tagged
Release workflow run (or the owner's published release when available). It contains
`backend/`, `frontend/`, `deploy/`, documentation and licenses. No `node_modules`
are shipped. Dependency installation still needs registry access or a populated,
platform-compatible npm cache/private mirror; the Node archive alone is not a full
offline installation kit.

For source builds, clone this repository using its **Code** URL, open the checkout,
then run:

```bash
npm ci
npm run build
```

Builds generate the Prisma client and `docs/openapi.json` without connecting to a
database. OpenAPI is a build artifact, not an HTTP endpoint. To prepare the same
portable release ZIP from source, use a fresh output directory each time:

```bash
npm run build -w @kloister/web -- --base-href /__KLOISTER_BASE__/
npm run package:release -- 1.0.0 dist/release
npm run verify:release -- dist/release
```

The final command extracts the actual ZIP, installs runtime dependencies and probes
module/native loading without a database. It validates the current machine only.

### Configure and initialize

Use an absolute persistent directory outside the checkout or extracted release.
The following **Bash** example uses `$HOME/kloister-data`. Replace the database
credentials with your dedicated role's URL-encoded values. Save configuration in
a private environment file (`chmod 600`) and load it into each new shell. Never
check it into version control. The example's development mode is for loopback use;
production requires the complete configuration in [INSTALL](docs/INSTALL.md).

```bash
export NODE_ENV=development
export DATABASE_URL='postgresql://ROLE:URL_ENCODED_PASSWORD@127.0.0.1:5432/DATABASE'
export APP_DIR="$HOME/kloister-data"
export ATTACHMENTS_DIR="$APP_DIR/data/attachments"
export BRANDING_DIR="$APP_DIR/data/branding"
export BACKUP_DIR="$APP_DIR/backups/postgres"
export LOG_DIR="$APP_DIR/logs"
export PG_DUMP_PATH='/absolute/path/to/pg_dump'
export BACKEND_HOST=127.0.0.1
export BACKEND_PORT=3000
mkdir -p "$ATTACHMENTS_DIR" "$BRANDING_DIR" "$BACKUP_DIR" "$LOG_DIR"
```

For a **source checkout**, initialize the existing database and bootstrap the first
administrator. The generated temporary password appears once in the terminal:

```bash
npm run migrate:deploy -w @kloister/api
npm run create-admin -w @kloister/api -- --email admin@example.org --name Administrator
```

For an **extracted release**, from `backend/`, use:

```bash
export CHECKPOINT_DISABLE=1 SCARF_NO_ANALYTICS=true
npm ci --omit=dev
node node_modules/prisma/build/index.js migrate deploy
node dist/cli/create-admin.js --email admin@example.org --name Administrator
```

Do not redirect bootstrap output to logs. Change the temporary password at first
sign-in; newly created accounts then receive the skippable introduction. Bootstrap
does nothing if an active administrator already exists.

### Run, open, stop

For a source checkout, start the backend in one Bash terminal:

```bash
npm run start:prod -w @kloister/api
```

In another terminal, from the checkout, start the development frontend (its proxy
forwards `api/` to port 3000):

```bash
npm start -w @kloister/web -- --host 127.0.0.1
```

Open `http://localhost:4200/`. Loopback HTTP is for local evaluation only; browser
Secure-cookie handling on loopback varies. Production uses your existing HTTPS
httpd origin. Stop foreground processes with Ctrl+C, and restart using the same
environment and commands. The development frontend needs source dependencies;
an extracted release has static files only.

For an extracted release, `cd backend && node dist/main.js` starts the API using
your environment. Serve `frontend/` through an existing HTTPS web server with SPA
fallback and same-origin `/<app_name>/api/` proxying to the loopback backend.
Replace `/__KLOISTER_BASE__/` in `frontend/index.html` with `/<app_name>/` and set
`APP_NAME=<app_name>` so cookies match. See the delivered httpd template and
[INSTALL](docs/INSTALL.md) for the supported production arrangement; a bare file
URL or unrelated static server does not provide API proxying. Use foreground
Ctrl+C or your own process supervisor to stop/restart a manual installation.

PostgreSQL holds accounts, work and settings. Attachments/inline images and uploaded
branding live in the configured folders, not in database dumps. Preserve those
folders, database, configuration and credentials across rebuilds/upgrades. Default
scheduled backups cover PostgreSQL only (02:00 server time, 14-day retention);
verify an actual successful backup and test recovery. Excel/offline snapshots are
reading copies, not restorable backups. [ADMIN](docs/ADMIN.md) explains complete
backup coverage, operator access to personal data and recovery.
