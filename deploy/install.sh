#!/usr/bin/env bash
set -euo pipefail

# Resolve the extracted release and trusted operator configuration before changes.
RELEASE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source "$RELEASE/deploy/common.sh"
source "$RELEASE/deploy/install.conf"
require_root
validate_config
source /etc/os-release
[[ ${VERSION_ID%%.*} == 8 && " ${ID_LIKE:-} $ID " =~ (rhel|centos) ]] || fail 'EL8 is required'
[[ $(uname -m) == x86_64 ]] || fail 'Only x86_64 is packaged'
check_payload
[[ ${ADMIN_EMAIL:-} =~ ^[^[:space:]@]+@[^[:space:]@]+$ && -n ${ADMIN_NAME:-} ]] || fail 'Set ADMIN_EMAIL and ADMIN_NAME in install.conf'
[[ ! -L /app && ! -L $APP_DIR ]] || fail 'Refusing symlinked app path'

# Refuse adoption of unrelated accounts or installations; a partial owned install
# can be resumed without changing its database credentials or existing cluster.
if id "$APP_NAME" >/dev/null 2>&1; then
  [[ -f $APP_DIR/config/install-owner && $(stat -c %U "$APP_DIR/config/install-owner") == root ]] || fail 'Existing account is not managed by this installer'
else
  [[ ! -e $APP_DIR ]] || fail 'Application directory already exists'
  useradd --system --user-group --home-dir "$APP_DIR" --shell /sbin/nologin "$APP_NAME"
fi
install -d -m 0755 -o root -g root /app "$APP_DIR"
install -d -m 0750 -o root -g "$APP_NAME" "$APP_DIR/config"
touch "$APP_DIR/config/install-owner"
open_log install
trap 'finish_log "$?" install' EXIT
action 'Checking disk space and required operator-managed httpd'
available=$(df -Pk "$APP_DIR" | awk 'NR==2 {print $4}')
(( available >= 5242880 )) || action 'WARNING: less than 5 GB free'
command -v apachectl >/dev/null || fail 'Install/configure httpd and TLS first; see INSTALL.md'

# Verify Node from an operator-supplied archive plus trusted checksum list, or
# fetch both over HTTPS. Never use or alter a system-wide Node installation.
action 'Preparing verified app-local Node runtime'
install -d -m 0755 "$APP_DIR/runtime"
archive="node-v$NODE_VERSION-linux-x64.tar.xz"
if [[ ! -x $NODE_DIR/bin/node ]]; then
  node_source="$RELEASE"
  if [[ ! -f $node_source/$archive ]]; then
    node_source="$APP_DIR/runtime/download-$NODE_VERSION"
    install -d -m 0700 "$node_source"
    curl --fail --location --proto '=https' --tlsv1.2 "https://nodejs.org/dist/v$NODE_VERSION/$archive" -o "$node_source/$archive"
    curl --fail --location --proto '=https' --tlsv1.2 "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$node_source/SHASUMS256.txt"
  fi
  [[ -f $node_source/SHASUMS256.txt ]] || fail 'Supply trusted SHASUMS256.txt with the offline Node archive'
  checksum=$(awk -v file="$archive" '$2 == file {print $1}' "$node_source/SHASUMS256.txt")
  [[ $checksum =~ ^[a-f0-9]{64}$ ]] || fail 'Missing or duplicate Node checksum'
  printf '%s  %s\n' "$checksum" "$node_source/$archive" | sha256sum --check --status || fail 'Node SHA256 mismatch'
  tar -xJf "$node_source/$archive" -C "$APP_DIR/runtime" --no-same-owner
fi
[[ $("$NODE_DIR/bin/node" --version) == "v$NODE_VERSION" ]] || fail 'Unexpected Node version'

# Provision only a missing PGDG major. Existing binaries mean the operator must
# already have a ready cluster at PG_PORT; never init, restart or reconfigure it.
action 'Checking isolated PostgreSQL major and configured port'
if [[ ! -x $PG_BIN/postgres ]]; then
  [[ ! -e /var/lib/pgsql/$PG_MAJOR/data ]] || fail 'Existing cluster found; refusing initialization'
  ss -ltn | awk '{print $4}' | grep -Eq ":$PG_PORT$" && fail 'PG_PORT is already in use'
  dnf -y install https://download.postgresql.org/pub/repos/yum/reporpms/EL-8-x86_64/pgdg-redhat-repo-latest.noarch.rpm >&8 2>&1
  dnf -qy module disable postgresql >&8 2>&1
  dnf -y install "postgresql$PG_MAJOR-server" >&8 2>&1
  "$PG_BIN/postgresql-$PG_MAJOR-setup" initdb >&8 2>&1
  printf '\nport = %s\n' "$PG_PORT" >>"/var/lib/pgsql/$PG_MAJOR/data/postgresql.conf"
  systemctl enable --now "postgresql-$PG_MAJOR" >&8 2>&1
fi
runuser -u postgres -- "$PG_BIN/pg_isready" -p "$PG_PORT" >&8 2>&1 || fail 'Configured cluster is not ready; operator action required'

# Create only this app's role/database. Credentials travel via stdin and private
# files, never command arguments, action logs or tracing. A rerun reuses files.
action 'Preparing private database credentials and persistent folders'
if [[ ! -f $APP_DIR/config/kloister.env ]]; then
  role_exists=$(printf "SELECT 1 FROM pg_roles WHERE rolname='%s';\n" "$APP_NAME" | runuser -u postgres -- "$PG_BIN/psql" -XAt -v ON_ERROR_STOP=1 -p "$PG_PORT" postgres)
  db_exists=$(printf "SELECT 1 FROM pg_database WHERE datname='%s';\n" "$APP_NAME" | runuser -u postgres -- "$PG_BIN/psql" -XAt -v ON_ERROR_STOP=1 -p "$PG_PORT" postgres)
  [[ -z $role_exists && -z $db_exists ]] || fail 'Database/role already exists without app credentials; operator recovery required'
  password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  # Write recovery credentials before SQL so an interrupted provision is recoverable.
  umask 077
  cat >"$APP_DIR/config/kloister.env" <<EOF
NODE_ENV=production
APP_NAME=$APP_NAME
APP_DIR=$APP_DIR
BACKEND_HOST=127.0.0.1
BACKEND_PORT=$BACKEND_PORT
DATABASE_URL=postgresql://$APP_NAME:$password@127.0.0.1:$PG_PORT/$APP_NAME
ATTACHMENTS_DIR=$APP_DIR/data/attachments
BRANDING_DIR=$APP_DIR/data/branding
BACKUP_DIR=$APP_DIR/backups/postgres
LOG_DIR=$APP_DIR/logs
PG_DUMP_PATH=$PG_BIN/pg_dump
PGPASSFILE=$APP_DIR/config/.pgpass
EOF
  printf '127.0.0.1:%s:%s:%s:%s\n' "$PG_PORT" "$APP_NAME" "$APP_NAME" "$password" >"$APP_DIR/config/.pgpass"
  chown "$APP_NAME:$APP_NAME" "$APP_DIR/config/kloister.env" "$APP_DIR/config/.pgpass"
  chmod 0600 "$APP_DIR/config/kloister.env" "$APP_DIR/config/.pgpass"
  printf 'CREATE ROLE "%s" LOGIN PASSWORD '\''%s'\'';\nCREATE DATABASE "%s" OWNER "%s";\n' "$APP_NAME" "$password" "$APP_NAME" "$APP_NAME" |
    runuser -u postgres -- "$PG_BIN/psql" -Xq -v ON_ERROR_STOP=1 -p "$PG_PORT" postgres >/dev/null 2>&1 || fail 'Role/database provisioning failed; inspect private credentials and recover with operator SQL (see INSTALL.md)'
  unset password
fi
for folder in data backups logs run; do
  [[ ! -L $APP_DIR/$folder ]] || fail 'Refusing symlinked persistent root'
  install -d -m 0750 -o "$APP_NAME" -g "$APP_NAME" "$APP_DIR/$folder"
done
runuser -u "$APP_NAME" -- /bin/bash -c 'umask 027; mkdir -p -- "$1/data/attachments" "$1/data/branding" "$1/backups/postgres" "$1/logs/backend" "$1/logs/backups"' bash "$APP_DIR"

# A completed install is resumed without replacing code; upgrades use upgrade.sh.
action 'Installing backend dependencies and applying migrations as the app account'
if [[ ! -f $APP_DIR/config/installed ]]; then
  [[ ! -L $APP_DIR/backend ]] || fail 'Refusing symlinked backend'
  install -d -m 0750 -o "$APP_NAME" -g "$APP_NAME" "$APP_DIR/backend"
  tar -C "$RELEASE/backend" -cf - . | runuser -u "$APP_NAME" -- tar -C "$APP_DIR/backend" -xf - --no-same-owner --no-same-permissions
  check_installed_config
  as_app npm ci --omit=dev >&8 2>&1
  as_app node --input-type=module -e 'import {hash,verify} from "argon2"; const h=await hash("native-compatibility-probe"); if(!await verify(h,"native-compatibility-probe"))process.exit(1)' >&8 2>&1 || fail 'argon2 native compatibility failed; do not start; report for the specified fallback'
  as_app node node_modules/prisma/build/index.js migrate deploy >&8 2>&1
  action 'Installing compiled frontend and control scripts'
  copy_frontend
  copy_scripts
fi
check_installed_config

# Replace just the single scoped httpd file. Restore its prior bytes on config
# failure, and never reload a configuration that did not pass configtest.
action 'Validating the scoped httpd proxy configuration'
conf="/etc/httpd/conf.d/$APP_NAME.conf"
prior="$APP_DIR/config/httpd-before-$(date +%Y%m%d-%H%M%S)-$$.conf"
configure_httpd "$RELEASE/deploy/httpd.conf.template" "$conf" "$prior"

# Leave SELinux and firewall decisions to the operator, with an exact warning.
if ! getsebool httpd_can_network_connect 2>/dev/null | grep -q -- '--> on'; then
  action 'WARNING: operator may need: setsebool -P httpd_can_network_connect on'
fi

# Bootstrap output goes only to the terminal, outside all installation logging.
action 'Creating initial administrator (temporary password is terminal-only)'
[[ -w /dev/tty ]] || fail 'A terminal is required to receive the initial password; rerun interactively'
as_app node dist/cli/create-admin.js --email "$ADMIN_EMAIL" --name "$ADMIN_NAME" >/dev/tty 2>/dev/tty
action 'Starting the backend without enabling any application service'
as_app /bin/bash "$APP_DIR/scripts/start.sh" >&8 2>&1
health_check
touch "$APP_DIR/config/installed"
action "Installation ready at the existing HTTPS origin under /$APP_NAME/; service enablement is manual"
