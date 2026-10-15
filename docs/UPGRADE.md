# Upgrade and rollback

Use an owner-reviewed extracted release on the RHEL host. Do not run the installer
over an existing deployment to replace code. No tag/publication is performed by
these scripts. Keep the prior ZIP and this guide offline before starting.

## Prepare

- Announce maintenance and keep users out until acceptance passes. Save the complete
  database, attachment/inline-image tree, uploaded branding and private configuration
  as a consistent backup; preserve ownership and mode. The automatic pre-upgrade dump
  covers PostgreSQL only. Stop writes while taking the coordinated file/database copy.
- Verify restore access and free space. Archive any existing `backend.previous/` and
  `/var/www/html/<app_name>.previous/` outside the active installation before the
  next upgrade. Scripts refuse to overwrite these rollback copies.
- Compare release notes/schema and review the new `deploy/install.conf`; retain
  the installed APP_NAME, PG_MAJOR, PG_PORT, BACKEND_PORT and NODE_VERSION. Runtime,
  port or database changes are a separate operator migration, not an implicit upgrade.
- If you use the optional systemd service, leave it installed. The upgrade detects
  an active service, stops it before replacement and returns to that same mode.

From the new extracted release root, as root in **Bash**:

```bash
bash deploy/upgrade.sh
```

The script first creates a required custom-format pre-upgrade dump in
`backups/postgres/` using private libpq environment and `.pgpass`. A failed dump
aborts before stopping/replacing code. It then stops the backend, preserves
`backend.previous`, copies the new backend, runs `npm ci --omit=dev` and committed
migrations as the app account, preserves/replaces the frontend, updates control
scripts, starts and polls loopback health. It does not enable a new service or
change httpd, PostgreSQL configuration, firewall or SELinux policy. See the
timestamped `logs/install/upgrade-*.log`. A partial dump retains `.partial`; do not
treat it as a successful backup.

M6.8's migration gives pre-existing accounts `EXEMPT` introduction state, including
temporary-password accounts. New/bootstrap accounts enroll after their initial
required password change. Later resets and upgrades preserve that state. Upgrading
does not trigger a repeat tour; manual replay remains in Help & FAQ.

## If any step fails

Keep the maintenance window open. The script prints rollback guidance and keeps
the prior code; it does not pretend that schema migrations can be reversed by
copying old JavaScript. Do not repeatedly rerun over `.previous` copies. Inspect the
failure stage and decide whether to finish the new version or restore all parts.

Manual rollback, with the actual configured paths and the verified pre-upgrade dump:

1. Stop the backend (use `systemctl stop <app_name>-backend.service` if supervised;
   otherwise the app-account `stop.sh`). Confirm no Node process remains.
2. Preserve the failed backend/frontend and diagnostics elsewhere. Restore
   `backend.previous/` to `backend/` and the saved frontend to
   `/var/www/html/<app_name>/`; retain the failed files until the cause is understood.
3. Restore the pre-upgrade database into a **clean** database owned by the app role
   using the matching major's `pg_restore --no-owner --no-privileges --exit-on-error`.
   Do not restore over live or unrelated data. The operator prepares the empty
   database and selects it through a private libpq environment/PGPASSFILE.
4. Restore matching attachments, branding and private configuration from the
   coordinated backup. Keep `kloister.env` and `.pgpass` at 0600 with the app owner.
   Restore prior control scripts/config from the previous release if they changed.
5. Start in the original supervision mode and check both loopback and HTTPS prefixed
   health, sign-in, forced password gate, files and a representative board/drawer.
   Only reopen access once data and permissions have been checked.

See [ADMIN](ADMIN.md) for dump/restore commands and recovery coverage. Retain rollback
files until acceptance passes; cleanup is an explicit operator action. No automatic
database downgrade, file deletion or forced process kill is supplied.
