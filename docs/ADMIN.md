# Administration and recovery

Use the sidebar's administrator screens for accounts, branding/fonts/themes,
session/lockout settings, attachment limits, database backups, disk usage and logs.
Help & FAQ explains everyday permissions and offers **Take the tour** with current
project/team/admin capabilities. System administration does not grant PM rights;
cross-project reads are audited. Personal spaces remain owner-only through the API.

The audit log shows actions in words, people by name and email, projects by key and
name and entities by name or item key; filter by action, person, project and dates,
and open **Technical details** for the stored JSON. Item titles are not looked up, but
some entries store a title or name in their details when they were written. When an
administrator opens a project they are not a member of, one "Admin opened a project
they are not a member of" entry is written per visit: per administrator, project and
sign-in session, and again once the visit's last entry is 30 minutes old. Every change
(including refused attempts) and every Excel/offline or ADO file download is recorded
as its own entry. Entries are never edited afterwards. Reads that follow any such entry within 30 minutes
in the same session belong to it, so a visit's first entry can be a change or a
download rather than a read.

Personal privacy is an application access rule, not encryption. Database/file
operators, root and people with backup access can read personal data. Treat database
dumps, attachments, branding, private configuration and diagnostic material as
sensitive. Restrict access and arrange approved encrypted off-host storage.

## Process, logs and security

The API listens on loopback behind the existing HTTPS httpd origin. Secure session
cookies are scoped to `/<APP_NAME>/`; state changes require the shared CSRF header.
Keep TLS/certificate renewal, firewall policy, SELinux labels/booleans and scoped
database authentication under operator control. Never expose the backend port or
serve the data/config tree. Uploaded files are served by authenticated API routes;
public branding uses dedicated checked endpoints.

For a manual process use the app-account start/stop/status scripts from [INSTALL](INSTALL.md).
When the optional service is enabled, use systemctl. The backend must never run as
root. Daily JSON logs live in `logs/backend/backend-<date>.log` and
`logs/backups/backup-<date>.log`. Admin retention defaults to 30 days; cleanup runs
at 03:45 server time. Installation logs and early process output (`process-*.log`,
`process-service.log`) are outside that daily-file cleanup: arrange operator rotation
and retention for them. Never add credentials to log commands or shell tracing.

Session idle changes affect existing sessions; absolute timeout changes apply to
new sign-ins. Password resets preserve introduction state; they are not a way to
re-enroll users in the introduction. Temporary passwords are shown once. Check
server time/timezone since backup, due-date and cleanup schedules use server time.

## Updating the Node runtime

Node lives in `runtime/node-v<NODE_VERSION>-linux-x64` inside the installation, and
upgrades keep the installed `scripts/install.conf`, so a newer `NODE_VERSION` in a
release package never changes an existing installation. To apply a Node 24 security
release, as root:

1. Download `node-v<version>-linux-x64.tar.xz` and `SHASUMS256.txt` from
   `https://nodejs.org/dist/v<version>/` into a new mode-0700 folder, check them with
   `sha256sum --check --ignore-missing SHASUMS256.txt` and unpack the archive into
   `runtime/` with `tar -xJf … --no-same-owner`.
2. As the app account, from `backend/`, check the password library with the new
   binary: `<new node> --input-type=module -e 'import {hash} from "argon2"; await hash("probe")'`.
   Every Node 24 release shares the native module interface, so no reinstall is needed.
3. Stop the backend while `scripts/install.conf` still names the old version (the
   control scripts only signal a process started from the configured binary).
4. Keep a copy of `scripts/install.conf` outside the installation, then set the new
   `NODE_VERSION` in it.
5. Start again: with the optional service, rerun `scripts/enable-service.sh`, which
   rewrites the unit's Node path and checks health; otherwise use `start.sh` and check
   `/api/v1/health`. Remove the old runtime folder once the browser checks pass.

To go back, stop, restore the saved `install.conf` and start again.

## Live updates

Boards, backlogs, timelines, item details, My work and the notification bell update
while people look at them, and people see who else has an item open (presence). The
browser keeps one Server-Sent Events stream per tab at `/<app_name>/api/v1/events`
through the existing `ProxyPass` for `/api/`; PostgreSQL notifications on the same
database carry ids only, and every event is filtered by the viewer's visibility before
it is sent. Nothing calls an external service. The stream never extends a session: it
ends when the session ends or expires, at sign-out, password change and deactivation.
Presence is kept in API memory only; it is never stored, audited or exported, and it
cannot be hidden per person.

Admin settings › General › **Live updates** (on by default) switches streams and
presence off for everyone at once. Open streams end immediately; tabs that are already
open pick up a later switch-on when they reload. The API sends `Cache-Control:
no-cache, no-transform` and `X-Accel-Buffering: no`, so httpd's `mod_deflate` leaves the
stream alone.

Check streaming through httpd with a signed-in session cookie (copy the `sid` cookie
value from the browser's developer tools; never paste it into reports):

```bash
curl -N -H 'Cookie: sid=<session cookie>' https://<host>/<app_name>/api/v1/events
```

The stream answers at once with `retry:` and an `event: hello` line, then prints
`: heartbeat` every 25 seconds. If the first lines arrive only after a long delay or in
bursts, httpd is holding the stream back; add the fallback line below.

Fallback, only when streaming is delayed: add one line to the Kloister conf file
(`/etc/httpd/conf.d/<app_name>.conf`), before the general `ProxyPass .../api/` line, then
check the configuration and reload httpd:

```apache
ProxyPass /<app_name>/api/v1/events http://127.0.0.1:<backend_port>/api/v1/events flushpackets=on timeout=3600
```

```bash
sudo apachectl configtest
```

```bash
sudo systemctl reload httpd
```

Upgrades never change httpd configuration, so this line is always added by hand. Until
streaming works, an administrator can switch **Live updates** off under Admin settings ›
General; the app then behaves as before (changes show after a reload).

## Backups and coverage

Database backups default to enabled at **02:00 server time**, retained 14 days.
After installation verify the first scheduled success and use **Run now** to check
the real binary. Settings show results; inspect the backup log too. CI uses a stand-in
dump executable and does not validate a real PostgreSQL backup. On the owner's RHEL
VM, validate `PG_DUMP_PATH` matches the database major and test restore before relying
on the schedule. A newer server cannot be dumped with an older `pg_dump`.

The app writes `pg_dump -Fc` files as
`backups/postgres/<app_name>-<yyyymmdd-hhmmss>.dump`, renaming `.partial` only after
success. `.pgpass` is mode 0600; connection details are passed privately, not on
command lines. One app backup runs at a time. Retention deletes only this app's old
successful named dumps after a success; maintain a separate off-host copy.

A PostgreSQL dump includes work, accounts, sessions, settings and file metadata.
It **does not include**:

- `data/attachments/` (attachments and description/note inline images).
- `data/branding/` (uploaded logos/fonts).
- `config/kloister.env`, `.pgpass`, app-local runtime or operator httpd/service setup.

Back up these paths separately with restrictive modes. For a consistent complete
recovery point, stop application writes and coordinate the database dump with file
and configuration copies. An upgrade's pre-backup is also database-only. Excel
workbooks/offline archives are readable snapshots of a caller's scope, not a database
restore format; they omit hidden data, accounts and server configuration.

## Trash retention

Deleted items go to their project's trash (M12), where project members who may delete can restore
them. A job at 03:45 server time removes batches older than the retention for good, with their
notes and files; set the number of days (1–365, default 30) under Admin settings › Storage. PMs can
also delete a batch permanently from Project › Settings › Trash. Each removal is recorded in the
audit log as "Item deleted permanently". Trashed items still count toward storage quotas until
they are removed.

## Manual database validation and restore

ADO transfer records are part of PostgreSQL backups. Completed batch content has
a separate fixed 90-day retention, and unapplied incoming previews are cleared after
7 days; pending workflows, active link observations,
tombstones and compact retry receipts are preserved independently of log retention.
Do not manually delete mappings or receipts to retry an import. Project PMs use
the scoped Recovery workflow; system administration adds no transfer permission.
See [ADO transfer](ADO-EXPORT.md) for the operator acceptance drill and CSV limits.

Run as the app account in **Bash**, with the private environment loaded. For example,
substitute the real name/port and set `PGHOST=127.0.0.1`, `PGPORT`, `PGUSER`,
`PGDATABASE` and `PGPASSFILE=/app/<app_name>/config/.pgpass`. Do not put passwords
in argv. Use the selected major's absolute binaries:

```bash
/usr/pgsql-18/bin/pg_dump --format=custom --no-password --file=/private/path/check.dump
/usr/pgsql-18/bin/pg_restore --list /private/path/check.dump
```

Listing the archive verifies readability, not recoverability. The operator prepares
a separate empty app-owned recovery database and points the same private libpq
environment to it (update the private password-file entry if its name differs):

```bash
/usr/pgsql-18/bin/pg_restore --no-password --no-owner --no-privileges \
  --exit-on-error --dbname="$PGDATABASE" /private/path/check.dump
```

This restore command writes data: run it only against the intended **empty** recovery
database. Reconnect a stopped, isolated copy of the matching backend to it and check
sign-in/roles, representative project and personal tasks, history, notes and files
from the matching file backup. Do not expose this recovery copy to ordinary users.
For actual rollback follow [UPGRADE](UPGRADE.md), preserving failed state first.
Document the successful test, archive location, code version and restore procedure
in your operational runbook. Never claim a backup is validated from a success toast alone.
