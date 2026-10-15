#!/usr/bin/env bash
set -euo pipefail

# Validate settings and identity before reading or signalling a stored PID.
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/common.sh"
source "$SCRIPT_DIR/install.conf"
validate_config
[[ $(id -un) == "$APP_NAME" && $EUID != 0 ]] || fail "Run as $APP_NAME"
exec 9>"$APP_DIR/run/control.lock"
flock -x 9
PID_FILE="$APP_DIR/run/backend.pid"
[[ -f $PID_FILE ]] || { printf 'Stopped\n'; exit 0; }
pid=$(cat "$PID_FILE")
[[ $pid =~ ^[1-9][0-9]*$ ]] || fail 'Invalid PID file'
if ! kill -0 "$pid" 2>/dev/null; then rm -- "$PID_FILE"; exit 0; fi
[[ $(readlink "/proc/$pid/exe") == "$NODE_DIR/bin/node" && $(readlink "/proc/$pid/cwd") == "$APP_DIR/backend" ]] || fail 'PID belongs to another process; refusing signal'

# Allow graceful Nest shutdown; never escalate to an unreviewed SIGKILL.
kill -TERM "$pid"
for attempt in {1..30}; do
  if ! kill -0 "$pid" 2>/dev/null || [[ $(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null || true) == Z ]]; then
    rm -- "$PID_FILE"; printf 'Stopped\n'; exit 0
  fi
  sleep 1
done
fail 'Still running after 30 seconds; inspect before retrying'
