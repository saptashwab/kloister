#!/usr/bin/env bash
set -euo pipefail

# Validate the extracted payload and managed installation before creating a backup.
RELEASE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source "$RELEASE/deploy/common.sh"
source "$RELEASE/deploy/install.conf"
require_root
validate_config
check_payload
[[ -f $APP_DIR/config/installed && ! -L $APP_DIR && ! -L $APP_DIR/backend ]] || fail 'A completed managed install is required'
[[ ! -e $APP_DIR/backend.previous && ! -e /var/www/html/$APP_NAME.previous ]] || fail 'Archive previous rollback copies before upgrading'
[[ -x $NODE_DIR/bin/node ]] || fail 'Keep NODE_VERSION unchanged; runtime upgrades require operator planning'
open_log upgrade
check_installed_config

# Always print manual rollback guidance on failure. Database migrations are not
# assumed reversible; do not automatically restart old code against a new schema.
trap 'finish_log "$?" upgrade' EXIT
action 'Creating required pre-upgrade database backup'
backup="$APP_DIR/backups/postgres/$APP_NAME-$(date +%Y%m%d-%H%M%S).dump"
[[ ! -e $backup && ! -e $backup.partial ]] || fail 'Backup timestamp already exists; retry later'
# Read libpq variables in the app account using Node URL parsing; no secret argv.
as_app node --input-type=module -e '
  import {spawnSync} from "node:child_process";
  const u=new URL(process.env.DATABASE_URL);
  const env={PATH:process.env.PATH,PGHOST:u.hostname,PGPORT:u.port||"5432",PGUSER:decodeURIComponent(u.username),PGDATABASE:decodeURIComponent(u.pathname.slice(1)),PGPASSFILE:process.env.PGPASSFILE};
  if(u.searchParams.has("sslmode"))env.PGSSLMODE=u.searchParams.get("sslmode");
  const r=spawnSync(process.env.PG_DUMP_PATH,["--format=custom","--no-password","--file="+process.argv[1]],{env,stdio:"inherit"});
  process.exit(r.status??1);
' "$backup.partial" >&8 2>&1
runuser -u "$APP_NAME" -- mv -- "$backup.partial" "$backup"
action "Pre-upgrade dump saved to $backup; operator must also back up files/config"

# Stop through systemd when manually enabled so Restart cannot race replacement.
action 'Stopping backend and preserving rollback code'
service_active=false
if systemctl is-active --quiet "$APP_NAME-backend.service"; then
  service_active=true
  systemctl stop "$APP_NAME-backend.service" >&8 2>&1
else
  as_app /bin/bash "$APP_DIR/scripts/stop.sh" >&8 2>&1
fi
mv "$APP_DIR/backend" "$APP_DIR/backend.previous"
install -d -m 0750 -o "$APP_NAME" -g "$APP_NAME" "$APP_DIR/backend"
tar -C "$RELEASE/backend" -cf - . | runuser -u "$APP_NAME" -- tar -C "$APP_DIR/backend" -xf - --no-same-owner --no-same-permissions

# Install only runtime dependencies and apply committed migrations as non-root.
action 'Installing new runtime dependencies and migrating database'
as_app npm ci --omit=dev >&8 2>&1
as_app node node_modules/prisma/build/index.js migrate deploy >&8 2>&1
action 'Replacing compiled frontend and control scripts'
copy_frontend
copy_scripts

# Return to the prior service mode without enabling a new application service.
action 'Starting upgraded backend and checking loopback health'
if $service_active; then
  systemctl start "$APP_NAME-backend.service" >&8 2>&1
else
  as_app /bin/bash "$APP_DIR/scripts/start.sh" >&8 2>&1
fi
health_check
action 'Upgrade succeeded; retain rollback copies until acceptance checks pass'
