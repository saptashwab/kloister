#!/usr/bin/env bash
set -euo pipefail

# Reject invalid configuration before a name can enter a path, SQL or service.
# Source only owner-reviewed configuration; it is executable Bash, not user input.
validate_config() {
  [[ ${APP_NAME:-} =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || fail 'Invalid APP_NAME'
  [[ $APP_NAME != root && $APP_NAME != postgres && $APP_NAME != apache ]] || fail 'Reserved APP_NAME'
  [[ ${PG_MAJOR:-} =~ ^[1-9][0-9]$ ]] || fail 'Invalid PG_MAJOR'
  [[ ${NODE_VERSION:-} =~ ^24\.[0-9]+\.[0-9]+$ ]] || fail 'Use a pinned Node 24 version'
  local port
  for port in "${PG_PORT:-}" "${BACKEND_PORT:-}"; do
    [[ $port =~ ^[1-9][0-9]{0,4}$ ]] && (( port <= 65535 )) || fail 'Invalid port'
  done
  [[ $PG_PORT != "$BACKEND_PORT" ]] || fail 'Ports must differ'
  APP_DIR="/app/$APP_NAME"
  PG_BIN="/usr/pgsql-$PG_MAJOR/bin"
  NODE_DIR="$APP_DIR/runtime/node-v$NODE_VERSION-linux-x64"
}

# Fail without echoing command arguments or credentials; inspect the named log.
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Log action labels only. Secret-bearing commands must never use tracing or tee.
action() {
  local line
  line="$(date -Is) $*"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >&8
}

# Root-only entry points must fail before touching any system state.
require_root() { (( EUID == 0 )) || fail 'Run this entry point as root'; }

# Create the installation log privately; process output is not globally redirected.
open_log() {
  [[ ! -L $APP_DIR/logs ]] || fail 'Refusing symlinked log root'
  install -d -m 0750 -o "$APP_NAME" -g "$APP_NAME" "$APP_DIR/logs"
  INSTALL_LOG_PATH="$APP_DIR/logs/install/$1-$(date +%Y%m%d-%H%M%S)-$$.log"
  # The app owns LOG_DIR by specification. Only that account opens filesystem
  # paths there; root writes to an inherited pipe, preventing symlink escalation.
  runuser -u "$APP_NAME" -- install -d -m 0750 -- "$APP_DIR/logs/install"
  exec 8> >(runuser -u "$APP_NAME" -- /bin/bash -c 'umask 077; exec tee -a "$1" >/dev/null' bash "$INSTALL_LOG_PATH")
  LOGGER_PID=$!
  INSTALL_LOG=$INSTALL_LOG_PATH
}

# Finish the app-account log writer and preserve command or logging failure.
# A detached backend must close FD8 so waiting never follows its lifetime.
finish_log() {
  local result=$1 mode=$2
  exec 8>&-
  if [[ -n ${LOGGER_PID:-} ]] && ! wait "$LOGGER_PID"; then
    printf 'Installation logger failed; review terminal diagnostics.\n' >&2
    result=1
  fi
  if (( result != 0 )); then
    if [[ $mode == upgrade ]]; then
      printf 'Upgrade failed. Keep users out. See docs/UPGRADE.md: stop the service, restore the pre-upgrade dump into a clean database, restore backend.previous and the previous frontend, then start and check health. Log: %s\n' "$INSTALL_LOG_PATH" >&2
    else
      printf 'Setup failed; inspect %s and fix the cause before retrying.\n' "$INSTALL_LOG_PATH" >&2
    fi
  fi
  exit "$result"
}

# Run trusted program arguments as the isolated account, with app-local Node.
# Source the mode-0600 environment in that account, never put secrets in argv.
as_app() {
  runuser -u "$APP_NAME" -- /bin/bash -c '
    set -euo pipefail
    set -a; source "$1/config/kloister.env"; set +a
    export PATH="$2/bin:/usr/bin:/bin" CHECKPOINT_DISABLE=1 SCARF_NO_ANALYTICS=true
    export npm_config_cache="$1/backend/.npm-cache"
    cd "$1/backend"
    shift 2
    exec "$@"
  ' bash "$APP_DIR" "$NODE_DIR" "$@"
}

# Verify the release has exactly the expected payload before replacing anything.
check_payload() {
  [[ -f $RELEASE/backend/package-lock.json && -f $RELEASE/backend/dist/main.js &&
     -d $RELEASE/backend/prisma/migrations && -f $RELEASE/frontend/index.html &&
     -f $RELEASE/backend/prisma.config.ts ]] || fail 'Incomplete extracted release'
  grep -q '/__KLOISTER_BASE__/' "$RELEASE/frontend/index.html" || fail 'Missing frontend base placeholder'
  [[ ! -d $RELEASE/backend/node_modules ]] || fail 'Release must not ship node_modules'
}

# Refuse upgrades/retries that silently point scripts and the private environment
# at different ports or data. Changing these settings needs operator migration.
check_installed_config() {
  as_app node --input-type=module -e '
    const [name,dir,major,pgPort,version,port]=process.argv.slice(1);
    const e=process.env,u=new URL(e.DATABASE_URL);
    if(e.APP_NAME!==name || e.APP_DIR!==dir || e.BACKEND_PORT!==port || u.port!==pgPort ||
       u.hostname!=="127.0.0.1" || decodeURIComponent(u.username)!==name || decodeURIComponent(u.pathname.slice(1))!==name ||
       e.PG_DUMP_PATH!=="/usr/pgsql-"+major+"/bin/pg_dump" || process.version!=="v"+version)
      {console.error("Installed environment differs from install.conf; operator migration required");process.exit(1);}
  ' "$APP_NAME" "$APP_DIR" "$PG_MAJOR" "$PG_PORT" "$NODE_VERSION" "$BACKEND_PORT"
}

# Keep script copies and configuration together; the account cannot edit root scripts.
copy_scripts() {
  install -d -m 0755 "$APP_DIR/scripts"
  local script
  for script in common.sh start.sh stop.sh status.sh enable-service.sh; do
    install -m 0755 "$RELEASE/deploy/$script" "$APP_DIR/scripts/$script"
  done
  install -m 0644 "$RELEASE/deploy/install.conf" "$APP_DIR/scripts/install.conf"
}

# Replace only compiled static files. Preserve a prior frontend for manual rollback.
copy_frontend() {
  local web="/var/www/html/$APP_NAME"
  [[ ! -L $web && ! -L $web.previous ]] || fail 'Refusing symlinked web directories'
  [[ ! -e $web.previous ]] || fail 'Archive the previous frontend before retrying'
  if [[ -d $web ]]; then mv "$web" "$web.previous"; fi
  install -d -m 0755 "$web"
  cp -R "$RELEASE/frontend/." "$web/"
  sed -i "s|/__KLOISTER_BASE__/|/$APP_NAME/|g" "$web/index.html"
  chown -R root:root "$web"
  chmod -R a+rX "$web"
}

# Poll loopback health after start; curl failures never make a false success.
health_check() {
  local attempt
  for attempt in {1..30}; do
    if curl --fail --silent --max-time 2 "http://127.0.0.1:$BACKEND_PORT/api/v1/health" >/dev/null; then return; fi
    sleep 1
  done
  fail 'Backend health check failed; inspect logs/backend/process-*.log'
}

# Restore prior bytes on a failed configtest and never reload a rejected file.
configure_httpd() {
  local template=$1 conf=$2 prior=$3 had_conf=false
  [[ ! -L $conf ]] || fail 'Refusing symlinked httpd conf'
  if [[ -f $conf ]]; then cp -p "$conf" "$prior"; had_conf=true; fi
  sed -e "s/__APP_NAME__/$APP_NAME/g" -e "s/__BACKEND_PORT__/$BACKEND_PORT/g" "$template" >"$conf"
  chmod 0644 "$conf"
  if ! apachectl configtest >"$prior.error" 2>&1; then
    # Restore before diagnostics: a full log filesystem or broken pipe must not
    # leave a rejected configuration behind merely because reporting also fails.
    if $had_conf; then cp -p "$prior" "$conf"; else rm -- "$conf"; fi
    cat "$prior.error" >&2
    cat "$prior.error" >&8
    fail 'httpd configtest failed; prior conf restored; httpd was not reloaded'
  fi
  cat "$prior.error" >&8
  systemctl reload httpd >&8 2>&1
}
