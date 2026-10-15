#!/usr/bin/env bash
set -euo pipefail

# This is the explicit opt-in entry point; install.sh never calls it.
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/common.sh"
source "$SCRIPT_DIR/install.conf"
require_root
validate_config
[[ -f $APP_DIR/config/installed ]] || fail 'Complete installation first'
open_log enable-service
trap 'finish_log "$?" enable-service' EXIT
action 'Installing the explicitly requested application service'

# systemd supervises the real Node process, retaining the same PID/control paths.
# EnvironmentFile is read by systemd; do not shell-expand private values here.
cat >"/etc/systemd/system/$APP_NAME-backend.service" <<EOF
[Unit]
Description=Project tracker backend ($APP_NAME)
After=network.target postgresql-$PG_MAJOR.service

[Service]
Type=simple
User=$APP_NAME
Group=$APP_NAME
WorkingDirectory=$APP_DIR/backend
EnvironmentFile=$APP_DIR/config/kloister.env
Environment=CHECKPOINT_DISABLE=1
Environment=SCARF_NO_ANALYTICS=true
ExecStart=/bin/bash -c 'exec $NODE_DIR/bin/node dist/main.js >> $APP_DIR/logs/backend/process-service.log 2>&1'
Restart=on-failure
UMask=0027
StandardOutput=journal
StandardError=journal
ExecStartPost=/bin/bash -c 'echo \$MAINPID > $APP_DIR/run/backend.pid'
ExecStopPost=/bin/rm -f $APP_DIR/run/backend.pid

[Install]
WantedBy=multi-user.target
EOF

# Stop a manually running process before allowing systemd to start a second one.
as_app /bin/bash "$APP_DIR/scripts/stop.sh" >&8 2>&1
systemctl daemon-reload >&8 2>&1
systemctl enable --now "$APP_NAME-backend.service" >&8 2>&1
health_check
action 'Service explicitly enabled; use systemctl for subsequent starts/stops'
