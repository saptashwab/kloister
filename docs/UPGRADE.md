# Upgrade and rollback

Use an owner-reviewed extracted release on the RHEL host. Do not run the installer
over an existing deployment to replace code. No tag/publication is performed by
these scripts. Keep the prior ZIP and this guide offline before starting.

## Recommended: the guided upgrade helper

`deploy/upgrade-helper.sh` wraps the steps below into one command with a tested backup and
a matching rollback. It never changes firewall, SELinux, httpd configuration, PostgreSQL
clusters or the Node runtime, never installs packages and never deletes earlier backups.

1. Extract the new release ZIP outside `/app/<app_name>`, for example
   `/root/kloister-1.2.0/`. You do not need to copy `install.conf`: the helper uses the
   installed `scripts/install.conf` and keeps the package default as
   `deploy/install.conf.package`.
2. If the dependency install has to compile native modules on your host, provide the build
   tools you use. `sudo -E` keeps exported variables such as `CC`, `CXX` and `PYTHON`, but
   sudo replaces `PATH`, so a gcc-toolset enabled only through `PATH` must either be given as
   full paths (for example `CC=/opt/rh/gcc-toolset-12/root/usr/bin/gcc`) or enabled in a root
   shell (`sudo -i`, then `source /opt/rh/gcc-toolset-12/enable`) before running the helper
   without `sudo`. The helper prints the variables and tools it finds, builds against the
   installed Node runtime's headers (no download) and never installs build tools.
3. Run, as root, from anywhere:

   ```bash
   sudo -E bash /root/kloister-1.2.0/deploy/upgrade-helper.sh upgrade /root/kloister-1.2.0 kloister https://your-host
   ```

   The application name defaults to `kloister`; the HTTPS origin (no path) is optional and
   adds a check through your existing httpd. The check verifies the certificate strictly, so leave the origin
   out on hosts with a self-signed certificate and open the health URL in a browser instead.

What it does, in order (each step is printed; details go to a private log under
`/var/tmp/kloister-upgrade-helper.*`):

1. Checks the installation, the new release, its version (it must be newer) and free
   space, and lists earlier upgrade leftovers (old `/var/backups/<app_name>-before-*`
   folders, held copies and recovery databases). Those are kept; delete them yourself
   once you no longer need them.
2. Installs the new release's dependencies into `backend.next` **while the current
   version keeps running**, and checks the password-hashing module loads. If this fails
   (for example missing build tools), nothing has been stopped or changed.
3. Asks you to type `UPGRADE`, then stops the backend and records whether it ran as the
   systemd service or manually.
4. Backs up the database (custom-format dump); archives `/app/<app_name>`, the web folder,
   an earlier `.previous` web folder, the httpd conf file and the service unit into
   `/var/backups/<app_name>-before-<version>-<time>.*`; restores the dump into a separate,
   locked recovery database and compares row counts; then writes checksums.
5. Removes the earlier `backend.previous` and `<app_name>.previous` folders, which are now
   inside the verified archives, so the shipped upgrade can keep its own rollback copy.
6. Runs `deploy/upgrade.sh` with the staged dependencies (code swap, migrations, frontend,
   control scripts), restarts in the recorded mode and checks health.

On success it prints the backup folder and the exact rollback command. On failure it
prints **the failed step**, the private log and what to do next:

- before the backend was stopped: nothing changed, the current version still runs;
- after stopping but before any code changed: the command to start the current version;
- after the upgrade began: the exact rollback command, for example
  `sudo bash /root/kloister-1.2.0/deploy/upgrade-helper.sh rollback /var/backups/kloister-before-1.2.0-20261024-101500.Ab12Cd`.

Rollback asks you to type `ROLLBACK`, keeps the upgraded database and files as held copies
(`<app_name>_held_*`, `/app/<app_name>.held-*`, `/var/www/html/<app_name>.held-*` and, if
present, `/var/www/html/<app_name>.previous.held-*`),
switches to the tested recovery database, restores the archived files, compares row counts
and starts the restored version. Writes made after the upgrade stay in the held copies;
they are not merged back. A backup can drive one rollback; a partly finished rollback
stops with instructions instead of being rerun blindly.

Keep users out until you have checked HTTPS, sign-in, boards, permissions and files in a
browser, or rolled back.

## Manual upgrade

The sections below describe the shipped `deploy/upgrade.sh` on its own, for operators who
take their own coordinated backup.

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

M8 adds destination/link/batch/row tables through an additive migration; it does not
reset work or change database major, deployment layout, ports or server policy.
Transfer mappings, pending intent and retry receipts are in the database backup.
Keep the coordinated pre-upgrade backup and run the disposable acceptance drill in
[ADO transfer](ADO-EXPORT.md) before transferring production work. Completed transfer
content expires after 90 days and unapplied previews after 7 days; active links,
tombstones and pending state remain. The M8.1 upgrade adds two columns with defaults
and changes no other data.

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
