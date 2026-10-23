# Administration and recovery

Use the sidebar's administrator screens for accounts, branding/fonts/themes,
session/lockout settings, attachment limits, database backups, disk usage and logs.
Help & FAQ explains everyday permissions and offers **Take the tour** with current
project/team/admin capabilities. System administration does not grant PM rights;
cross-project reads are audited. Personal spaces remain owner-only through the API.

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
