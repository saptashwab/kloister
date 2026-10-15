# RHEL installation

Production target: RHEL 8.10 x86_64, an existing HTTPS httpd origin, PGDG PostgreSQL
18 by default and app-local Node 24. Scripts require Bash and root for provision;
the backend always runs as the named non-login account. Installation execution and
server acceptance are the owner's responsibility. No RHEL VM execution is claimed
by the local build or CI. Do not publish a tag/release until you have reviewed the
artifact and chosen to do so.

## Before running

1. Download/extract the reviewed ZIP into a root-controlled directory. Keep it out
   of the web root; untrusted users must not be able to edit its Bash config/scripts.
2. Review `deploy/install.conf`: `APP_NAME` (new account/database/URL segment),
   `PG_MAJOR`, `PG_PORT`, exact `NODE_VERSION`, `BACKEND_PORT`, `ADMIN_EMAIL`,
   `ADMIN_NAME`. The supplied PostgreSQL port 5433 avoids the common existing 5432
   cluster; confirm both configured ports are free. Configuration is trusted Bash.
3. Install/configure httpd, TLS, proxy modules, curl, tar/xz, util-linux (`flock`,
   `runuser`), coreutils, iproute (`ss`) and certificate trust. The scripts do not
   create a virtual host, install certificates or change existing server settings.
   Allow at least 5 GB free space plus your data/backup capacity.
4. For a supplied PGDG major, provision its cluster/service and verify local peer
   access for the `postgres` OS account at `PG_PORT`. The installer never initializes,
   starts, restarts or changes an existing major's cluster. If binaries are absent,
   it installs that PGDG major and initializes only its new default data directory;
   an existing directory or occupied port causes refusal. Other majors stay intact.
5. Arrange loopback password access for this application's role/database in the
   selected cluster's `pg_hba.conf` (SCRAM recommended). PGDG defaults may use ident;
   a rejected password connection stops migrations. The installer does not broaden
   existing database authentication. The operator reviews any scoped HBA rule and
   reloads PostgreSQL; never use trust or an application superuser to bypass this.
6. Registry dependencies need network access or a prepared compatible npm cache or
   internal registry. `npm ci --omit=dev` runs as the app account; make its cache or
   registry configuration accessible to that account. Dependency install hooks may
   need network at installation time. Runtime makes no external service calls.

For offline Node, put `node-v<NODE_VERSION>-linux-x64.tar.xz` and its trusted
official `SHASUMS256.txt` beside `backend/` and `deploy/`. Obtain/verify the checksum
list through your approved channel. Otherwise both files are downloaded from
nodejs.org over HTTPS. The exact archive SHA256 is checked before unpacking into
`/app/<app_name>/runtime/`; existing system Node is untouched. Node 24 is required;
the config pins a complete version rather than following a moving download URL.

## Install

From the extracted release root in an interactive **Bash** root terminal:

```bash
bash deploy/install.sh
```

The script checks EL8/x86_64, creates the isolated account/tree, prepares Node and
the selected PostgreSQL major, creates a random-password database role/database,
installs locked runtime packages as the app account and applies committed migrations.
It probes the native argon2 binary before startup. If the probe fails on RHEL 8,
stop and report it for the SPEC-approved `@node-rs/argon2` fallback; this artifact
does not claim native RHEL compatibility before the owner runs the probe.

It copies only static frontend files to `/var/www/html/<app_name>`, substitutes the
base href and writes only `/etc/httpd/conf.d/<app_name>.conf`. `apachectl configtest`
must pass before reload. A failure restores the prior file (or removes a new file),
prints the diagnostic and leaves the running httpd configuration untouched. Existing
TLS/virtual hosts are inherited. A SELinux warning prints
`setsebool -P httpd_can_network_connect on`; the operator decides whether to execute
it. File labels, other SELinux policy and firewall changes are also operator-only.

The initial administrator's temporary password is printed directly to the controlling
terminal once, outside installation logs. An interactive terminal is required. Open
your existing **HTTPS** origin at `/<app_name>/`, sign in and change that password.
The introduction follows; Help & FAQ can replay it later. No real example data is
created by the installer or tour.

## Files, credentials and process control

`/app/<app_name>/config/kloister.env` and `.pgpass` are owned by the application
account, mode 0600, inside a root-owned mode-0750 config directory. The generated
environment includes `NODE_ENV=production`, `APP_NAME`, `APP_DIR`, `BACKEND_HOST`,
`BACKEND_PORT`, `DATABASE_URL`, `ATTACHMENTS_DIR`, `BRANDING_DIR`, `BACKUP_DIR`,
`LOG_DIR`, `PG_DUMP_PATH` and `PGPASSFILE`. Optional `LOG_LEVEL` defaults to info.
Data, backup, log and run directories are app-owned mode 0750. Scripts and runtime
are root-owned. Nothing under data/config/backups is served as static web content.

Root can invoke the account-only control scripts, using the configured name:

```bash
runuser -u kloister -- bash /app/kloister/scripts/status.sh
runuser -u kloister -- bash /app/kloister/scripts/stop.sh
runuser -u kloister -- bash /app/kloister/scripts/start.sh
```

They use `run/backend.pid`, reject unrelated PIDs and serialize start/stop with a
lock. Output before the logger exists goes to `logs/backend/process-<date>.log`.
Daily application logs are separate JSON lines. These scripts do not auto-enable
an application service. For explicit boot supervision, run as root:

```bash
bash /app/kloister/scripts/enable-service.sh
systemctl status kloister-backend.service
```

Thereafter use `systemctl start|stop|restart kloister-backend.service` so its restart
policy cannot race a manual stop. systemd captures early output in
`logs/backend/process-service.log`. Check status and health after service activation.

## Retry and acceptance

Action labels and safe command diagnostics go to `logs/install/`. Never enable shell
tracing or paste private environment files into reports. A completed installer rerun
reuses credentials/code and safely rechecks setup; use `upgrade.sh` for new code.
It refuses unrelated existing accounts, symlinked targets and overlapping rollback
copies. Partial failures retain evidence rather than deleting data. If SQL creation
was interrupted after credentials were written, an operator checks the role/database
with `psql` as postgres, creates the missing app-owned objects using the stored
password privately, then retries. Never remove config and regenerate a password for
an existing database blindly. If frontend replacement already happened, inspect and
archive its `.previous` copy before retrying. Existing database auth/service failures
require operator repair; no other cluster is modified to make the install succeed.

Run [RHEL acceptance](RHEL-ACCEPTANCE.md) before use. Check loopback health and then
the HTTPS prefixed health endpoint; only the latter verifies httpd/SELinux routing.
Validate real `pg_dump` and restore, native password hashing, non-root execution,
existing cluster/Node preservation, permissions and rerun/upgrade failure handling.
Read [ADMIN](ADMIN.md) for complete backup coverage and [UPGRADE](UPGRADE.md) before
replacing code. The shipped OpenAPI document describes implemented routes only;
it is never hosted automatically in production.
