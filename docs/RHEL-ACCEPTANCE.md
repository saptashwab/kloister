# Owner-run RHEL acceptance

Installation/configuration execution is outside the artifact implementation scope.
The owner runs this checklist on an authorized RHEL 8.10 x86_64 VM. Local tests and
Ubuntu CI do not substitute for it. Record date, OS, release hash, Node/PostgreSQL
versions, chosen ports and evidence privately; never include passwords.

1. Snapshot the VM and record existing PostgreSQL cluster/service states, Node
   paths, firewall, SELinux and httpd configuration. Confirm the chosen new ports
   and app name do not collide. Prepare the operator prerequisites in INSTALL.
2. Run installation from the reviewed artifact in a terminal. Confirm archive
   checksum rejection with a damaged Node copy before the real install, then use
   the approved archive/checksum. Check native argon2 probe and locked dependency
   installation. If native loading fails, report it before trying a fallback.
3. Check account shell, non-root process owner, file modes and every generated
   production environment path. Verify the temporary password is absent from
   installation logs and appears only at the terminal. Confirm no automatic
   application service enablement. Existing cluster and Node state must match step 1.
4. Check loopback `/api/v1/health`, then HTTPS `/<app_name>/api/v1/health`. Open
   `/<app_name>/` and a direct drawer URL. Confirm assets/API/fonts load under the
   non-root prefix. No third-party runtime requests should be made.
5. Sign in, change the initial password, skip/complete the tour and replay it through
   Help. Create project/example tasks using the UI. Verify Viewer restrictions,
   personal owner-only access, duplication, notes/images/files and scoped snapshots.
   Test local reset behavior without automatically replaying the tour.
6. Run a real **Run now** backup, inspect its archive with `pg_restore --list`, and
   restore into a clean isolated recovery database with matching file/config copies.
   Verify the recovered app and record the scheduled 02:00 backup result too.
7. Re-run installation; confirm existing data/credentials remain and no duplicates
   or unapproved system changes occur. In a disposable VM snapshot, test a bad scoped
   httpd config: configtest must fail, prior config return and httpd remain unreloaded.
8. Exercise manual start/stop/status and stale/unrelated PID refusal. Explicitly opt
   into the service if desired, then test restart/failure recovery and reboot behavior.
9. From a separate disposable snapshot, test upgrade success, pre-dump failure before
   code replacement, migration/start/health failure and documented manual rollback
   of database/code/frontend/files/config. Previous rollback copies must never be
   silently overwritten. Confirm unrelated clusters and policy remain unchanged.
10. Report any failures with sanitized logs. Publish/tag only as a separate explicit
    owner action after deciding that acceptance is sufficient. M8 remains separate.
