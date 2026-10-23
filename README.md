# Kloister

Self-hosted project tracking for teams that keep their work on their own server.
Plan on Kanban boards, organize a backlog and manage personal tasks without SSO,
outbound email or external services at runtime.

**MIT licensed · v1.0 pre-release · Production target: RHEL 8.10 x86_64**

## Features

- Configurable boards, labels, assignments, priorities, due dates and status rules.
- Epics, Features, Stories, Tasks and Bugs, with hierarchy, dependencies and sprints.
- My work across projects, private personal spaces, project roles and optional teams.
- Rich descriptions, checklists, notes, mentions, attachments and pasted images.
- Item duplication, independent copies per person, Excel snapshots and offline archives.
- In-app notifications, themes, branding, bundled fonts and keyboard navigation.
- Local accounts, access controls, audit history and scheduled database backups.
- Searchable **Help & FAQ** and a skippable introduction with **Take the tour** replay.

Kloister also moves work to and from Azure Boards with manual CSV files: setup from
a sample ADO export, Quick review by default (with Detailed review when you want every
choice), returned-ID linking and durable retry recovery. See
[ADO transfer](docs/ADO-EXPORT.md) for permissions, limits and the acceptance drill.

![Project board with example data](docs/screenshots/board.png)

![Item details with example data](docs/screenshots/item-drawer.png)

## Install on RHEL

Get `kloister-<version>.zip` from a tagged [Release workflow](https://github.com/saptashwab/kloister/actions/workflows/release.yml)
or a [published release](https://github.com/saptashwab/kloister/releases) when available.
The ZIP includes the compiled application, deployment scripts and documentation;
a GitHub source ZIP needs building first.

Prepare an HTTPS httpd site and PostgreSQL access, extract the package, then run
these commands in **Bash as root**:

```bash
vi deploy/install.conf      # App name, ports, Node version and initial admin details
bash deploy/install.sh
```

Open `https://YOUR_SERVER/<app_name>/`, sign in with the temporary password printed
in the terminal and change it. The backend runs as a dedicated non-login account.
Automatic startup is an explicit choice after installation:

```bash
bash /app/kloister/scripts/enable-service.sh   # Replace kloister if APP_NAME differs
systemctl status kloister-backend.service
```

Follow [INSTALL](docs/INSTALL.md) for prerequisites, PostgreSQL authentication,
offline Node archives, TLS/SELinux checks and manual start/stop commands.
Dependencies need registry access or a compatible npm cache/internal mirror.
The RHEL scripts are specific to that platform; VM acceptance remains to be completed.

## Run from source

The following uses **Bash on Linux** and an unprivileged account. Install Node 24
(at least 24.11), npm 11 and PostgreSQL 18 with matching backup tools. Create a
dedicated database login and a database it owns, with password authentication.
Windows source builds and unit tests are supported; Windows/macOS production
deployment is not validated or automated.

```bash
git clone https://github.com/saptashwab/kloister.git
cd kloister
npm ci
npm run build

# Replace the credentials; URL-encode special characters in the password.
export DATABASE_URL='postgresql://ROLE:PASSWORD@127.0.0.1:5432/DATABASE'
export NODE_ENV=development BACKEND_HOST=127.0.0.1 BACKEND_PORT=3000
export APP_DIR="$HOME/kloister-data"
export ATTACHMENTS_DIR="$APP_DIR/data/attachments" BRANDING_DIR="$APP_DIR/data/branding"
export BACKUP_DIR="$APP_DIR/backups/postgres" LOG_DIR="$APP_DIR/logs"
export PG_DUMP_PATH='/absolute/path/to/pg_dump'
mkdir -p "$ATTACHMENTS_DIR" "$BRANDING_DIR" "$BACKUP_DIR" "$LOG_DIR"

npm run migrate:deploy -w @kloister/api
npm run create-admin -w @kloister/api -- --email admin@example.org --name Administrator
npm run start:prod -w @kloister/api
```

Keep the environment in a private file (`chmod 600`) and load it for each backend
start. Never commit credentials or log the bootstrap password. In a second terminal
from the checkout, run `npm start -w @kloister/web -- --host 127.0.0.1` and open
`http://localhost:4200/`. This loopback setup is for evaluation; production requires
HTTPS. Stop both foreground processes with Ctrl+C; restart with the same commands.

To build a distributable ZIP, run `npm run package:release -- 1.0.0 dist/release`
after the build, using a fresh output folder. For a manual extracted-package setup,
run `npm ci --omit=dev` in `backend/`, then use
`CHECKPOINT_DISABLE=1 node node_modules/prisma/build/index.js migrate deploy`,
`node dist/cli/create-admin.js --email admin@example.org --name Administrator` and
`node dist/main.js`. Use the same environment above for evaluation; production
needs the full configuration in [INSTALL](docs/INSTALL.md). Serve `frontend/` over
HTTPS with SPA fallback and a same-origin API proxy, substitute `/__KLOISTER_BASE__/`
in `index.html` with `/<app_name>/` and set `APP_NAME` to match. The supplied httpd
template shows this arrangement.

## Operations

PostgreSQL stores accounts, work and settings. Preserve the database, configured
attachment/branding folders and private configuration across upgrades. Scheduled
backups default to **02:00 server time**, with **14-day retention**, and cover the
database only. Back up files/configuration separately and test restoration.
Excel/offline snapshots are reading copies, not restorable backups.

[Installation](docs/INSTALL.md) · [Upgrades](docs/UPGRADE.md) ·
[Administration and recovery](docs/ADMIN.md) · [MIT license](LICENSE)
