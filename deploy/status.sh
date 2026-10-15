#!/usr/bin/env bash
set -euo pipefail

# Validate identity, PID and executable before reporting health.
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/common.sh"
source "$SCRIPT_DIR/install.conf"
validate_config
[[ $(id -un) == "$APP_NAME" && $EUID != 0 ]] || fail "Run as $APP_NAME"
[[ -f $APP_DIR/run/backend.pid ]] || { printf 'Stopped\n'; exit 3; }
pid=$(cat "$APP_DIR/run/backend.pid")
[[ $pid =~ ^[1-9][0-9]*$ ]] || fail 'Invalid PID file'
kill -0 "$pid" 2>/dev/null || { printf 'Stale PID; stopped\n'; exit 3; }
[[ $(readlink "/proc/$pid/exe") == "$NODE_DIR/bin/node" && $(readlink "/proc/$pid/cwd") == "$APP_DIR/backend" ]] || fail 'PID belongs to another process'
curl --fail --silent --max-time 3 "http://127.0.0.1:$BACKEND_PORT/api/v1/health"
printf '\nRunning (%s)\n' "$pid"
