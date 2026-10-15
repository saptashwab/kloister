#!/usr/bin/env bash
set -euo pipefail

# Read the root-owned deployment settings and validate all derived paths.
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/common.sh"
source "$SCRIPT_DIR/install.conf"
validate_config
[[ $(id -un) == "$APP_NAME" && $EUID != 0 ]] || fail "Run as $APP_NAME"

# Load only the private app environment. Refuse duplicate or unrelated PID files.
set -a; source "$APP_DIR/config/kloister.env"; set +a
export PATH="$NODE_DIR/bin:/usr/bin:/bin" CHECKPOINT_DISABLE=1 SCARF_NO_ANALYTICS=true
install -d -m 0750 "$APP_DIR/run" "$APP_DIR/logs/backend"
exec 9>"$APP_DIR/run/control.lock"
flock -x 9
PID_FILE="$APP_DIR/run/backend.pid"
if [[ -f $PID_FILE ]]; then
  pid=$(cat "$PID_FILE")
  [[ $pid =~ ^[1-9][0-9]*$ ]] || fail 'Invalid PID file; inspect before removing'
  if kill -0 "$pid" 2>/dev/null; then
    [[ $(readlink "/proc/$pid/exe") == "$NODE_DIR/bin/node" && $(readlink "/proc/$pid/cwd") == "$APP_DIR/backend" ]] || fail 'PID belongs to another process'
    printf 'Already running (%s)\n' "$pid"; exit 0
  fi
fi

# Detach the non-root backend; close the lock descriptor so later stop can lock.
# Early crashes go to separate files rather than corrupting daily JSON logs.
cd "$APP_DIR/backend"
umask 027
nohup "$NODE_DIR/bin/node" dist/main.js >>"$APP_DIR/logs/backend/process-$(date +%Y-%m-%d).log" 2>&1 < /dev/null 9>&- 8>&- &
pid=$!
printf '%s\n' "$pid" > "$PID_FILE"
sleep 1
kill -0 "$pid" 2>/dev/null || fail 'Backend exited; inspect process log'
printf 'Started (%s)\n' "$pid"
