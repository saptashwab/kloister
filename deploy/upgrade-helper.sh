#!/usr/bin/env bash
set -euo pipefail
# Guided, backed-up upgrade and matching rollback for a managed RHEL 8 install.
#
#   upgrade:  sudo -E bash deploy/upgrade-helper.sh upgrade RELEASE_DIR [APP_NAME] [HTTPS_ORIGIN]
#   rollback: sudo bash /path/upgrade-helper.sh rollback BACKUP_DIR
#
# The helper never changes firewall, SELinux, httpd configuration, PostgreSQL
# clusters or the Node runtime, never installs packages and never deletes earlier
# backups or recovery databases. Build tools for native modules (CC, CXX, PYTHON
# or a gcc-toolset PATH) come from the caller's environment: export them, then run
# with `sudo -E` or from a root shell so they reach the dependency install.
set -E
umask 077

# Show usage without requiring privileges or changing the machine.
usage() {
  printf 'Usage:\n  sudo -E bash %s upgrade RELEASE_DIRECTORY [APP_NAME] [HTTPS_ORIGIN]\n  sudo bash %s rollback BACKUP_DIRECTORY\n' "$0" "$0"
}
if [[ ${1:-} == --help || ${1:-} == -h ]]; then usage; exit 0; fi
if [[ ${1:-} != upgrade && ${1:-} != rollback ]]; then usage >&2; exit 2; fi
MODE=$1
if [[ $MODE == upgrade && ($# -lt 2 || $# -gt 4) ]] ||
  [[ $MODE == rollback && $# != 2 ]]; then
  usage >&2
  exit 2
fi
[[ $(id -u) == 0 ]] || {
  printf 'ERROR: run as root (sudo -E bash ...), not as an ordinary account.\n' >&2
  exit 1
}

# Keep the caller's PATH only for the staged dependency build (gcc-toolset); every
# other command uses the system PATH. Output goes to a private log; stages and the
# final result stay visible on the terminal.
CALLER_PATH=${PATH:-}
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
SELF=$(readlink -f -- "$0")
LOG_DIRECTORY=$(mktemp -d /var/tmp/kloister-upgrade-helper.XXXXXX)
LOG="$LOG_DIRECTORY/run.log"
exec 3>&1 4>&2
exec >"$LOG" 2>&1
STAGE='initial checks'
ERROR_LINE=0
SAFE=''
STAGING=''
STOP_REQUESTED=false
UPGRADE_STARTED=false
ROLLBACK_STARTED=false
BACKUP_READY=false

# Report the failed stage, the log and the exact recovery command; never run
# recovery automatically.
finish() {
  local result=$?
  trap - EXIT ERR INT TERM HUP
  if [[ -n $STAGING && -d $STAGING ]] && ! $UPGRADE_STARTED; then rm -rf -- "$STAGING"; fi
  if ((result != 0)); then
    printf '\nFAILED at step: %s\nExit code: %s; script line: %s\nPrivate log: %s\n' "$STAGE" "$result" "$ERROR_LINE" "$LOG" >&4
    [[ -z $SAFE ]] || printf 'Backup/state directory: %s\n' "$SAFE" >&4
    if $ROLLBACK_STARTED; then
      printf 'Rollback stopped partway through. Keep users out; do not rerun blindly. Preserve the log and inspect the recorded step.\n' >&4
    elif $UPGRADE_STARTED && $BACKUP_READY; then
      printf 'Keep users out. The installation may be partly upgraded. No automatic rollback was attempted.\nTo return to the previous version, run:\n  sudo bash %q rollback %q\n' "$SELF" "$SAFE" >&4
    elif $STOP_REQUESTED; then
      printf 'The backend was stopped, but no application code was replaced.\n' >&4
      if [[ ${RUN_MODE:-manual} == service ]]; then
        printf 'After reading the log, restart the current version with:\n  sudo systemctl start %q\n' "$UNIT" >&4
      else
        printf 'After reading the log, restart the current version with:\n  sudo runuser -u %q -- bash %q\n' "$APP_NAME" "$APP_DIR/scripts/start.sh" >&4
      fi
    else
      printf 'Nothing was stopped or replaced; the current version is still running.\n' >&4
    fi
  fi
  exit "$result"
}
trap finish EXIT
trap 'ERROR_LINE=$LINENO' ERR
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Record each stage before running its commands, including explicit refusals.
step() {
  STAGE=$1
  printf '\n[%s] %s\n' "$(date -Is)" "$STAGE"
  printf '[%s] %s\n' "$(date -Is)" "$STAGE" >&3
}
abort() {
  printf 'ERROR: %s\n' "$*"
  printf 'ERROR: %s\n' "$*" >&4
  exit 1
}
say() {
  printf '%s\n' "$*"
  printf '%s\n' "$*" >&3
}

# Serialize maintenance in root-owned runtime storage, never an app-writable file.
lock_maintenance() {
  local directory=/run/kloister-maintenance
  [[ ! -L $directory ]] || abort 'Refusing a symlinked maintenance lock directory.'
  if [[ ! -e $directory ]]; then install -d -m 0700 -o root -g root "$directory"; fi
  [[ -d $directory && $(stat -c %u "$directory") == 0 && $(stat -c %a "$directory") == 700 ]] || abort 'Maintenance lock directory must be root-owned mode 0700.'
  [[ ! -L $directory/$APP_NAME.lock ]] || abort 'Refusing a symlinked maintenance lock.'
  exec 7>"$directory/$APP_NAME.lock"
  flock -n 7 || abort 'Another upgrade/rollback helper is running for this application.'
}

# Use the existing local PostgreSQL administrator without passwords in argv.
pg() {
  local program=$1
  shift
  runuser -u postgres -- env -u PGHOST -u PGHOSTADDR -u PGUSER -u PGDATABASE \
    -u PGPASSWORD -u PGSERVICE -u PGSERVICEFILE -u PGOPTIONS \
    "$PG_BIN/$program" --no-password -p "$PG_PORT" "$@"
}

# Refuse a backup or rollback while a backend is still listening.
assert_stopped() {
  local listeners
  listeners=$(ss -ltnH "sport = :$BACKEND_PORT")
  [[ -z $listeners ]] || abort 'Backend port still listens; inspect the process before continuing.'
}

# Stop through the existing service when active, then cleanly stop any manual PID.
stop_app() {
  if systemctl is-active --quiet "$UNIT"; then systemctl stop "$UNIT"; fi
  runuser -u "$APP_NAME" -- bash "$APP_DIR/scripts/stop.sh"
  assert_stopped
}

# Return to the recorded supervision mode without enabling any service.
start_app() {
  if [[ $RUN_MODE == service ]]; then
    runuser -u "$APP_NAME" -- bash "$APP_DIR/scripts/stop.sh"
    systemctl start "$UNIT"
  else
    runuser -u "$APP_NAME" -- bash "$APP_DIR/scripts/start.sh" 3>&- 4>&- 7>&-
  fi
}

# Check actual health, optionally through the operator's existing HTTPS origin.
check_health() {
  local attempt healthy=false
  for attempt in {1..30}; do
    if curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:$BACKEND_PORT/api/v1/health"; then
      healthy=true
      break
    fi
    sleep 1
  done
  $healthy || abort 'Loopback health did not pass within 30 attempts.'
  runuser -u "$APP_NAME" -- bash "$APP_DIR/scripts/status.sh"
  if [[ -n $HTTPS_ORIGIN ]]; then
    curl --proto '=https' --fail --show-error --max-time 20 "$HTTPS_ORIGIN/$APP_NAME/api/v1/health"
  fi
}

# Confirm maintenance explicitly before stopping an application or switching data.
confirm() {
  local expected=$1 answer
  printf '\n%s\nType %s to continue: ' "$2" "$expected" >&3
  read -r answer </dev/tty
  [[ $answer == "$expected" ]] || abort 'Confirmation did not match; no further actions taken.'
}

# Keep the restore check independent of application content and private values.
counts() {
  pg psql -X -d "$1" -At -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'User', count(*) FROM "User"
UNION ALL SELECT 'Project', count(*) FROM "Project"
UNION ALL SELECT 'WorkItem', count(*) FROM "WorkItem"
UNION ALL SELECT 'Note', count(*) FROM "Note"
UNION ALL SELECT 'Attachment', count(*) FROM "Attachment";
SQL
}

# Fail before stopping when storage cannot hold the archives and a recovery DB.
available_bytes() { df -Pk -- "$1" | awk 'NR==2 {printf "%.0f\n", $4 * 1024}'; }

# Sum simultaneous requirements on shared filesystems.
declare -A SPACE_NEEDED=() SPACE_FREE=() SPACE_PATH=()
reserve_space() {
  local path=$1 bytes=$2 device free
  device=$(stat -c %d "$path")
  free=$(available_bytes "$path")
  SPACE_NEEDED[$device]=$((${SPACE_NEEDED[$device]:-0} + bytes))
  if [[ -z ${SPACE_FREE[$device]+set} ]] || ((free < SPACE_FREE[$device])); then
    SPACE_FREE[$device]=$free
    SPACE_PATH[$device]=$path
  fi
}
check_space() {
  local device
  for device in "${!SPACE_NEEDED[@]}"; do
    say "Filesystem at ${SPACE_PATH[$device]}: need ${SPACE_NEEDED[$device]} bytes free; available ${SPACE_FREE[$device]} bytes"
    ((SPACE_FREE[$device] > SPACE_NEEDED[$device])) || abort 'Insufficient combined free space; see the displayed filesystem requirements.'
  done
}

# Bytes used by a directory, or 0 when it does not exist.
size_of() { if [[ -e $1 ]]; then echo $(($(du -sk -- "$1" | awk '{print $1}') * 1024)); else echo 0; fi; }

# Package version of an extracted backend, read with the installed Node runtime.
version_of() {
  "$NODE_DIR/bin/node" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version' "$1/package.json"
}

# Report leftovers of earlier upgrades; they are kept, never deleted here.
list_leftovers() {
  local found=false path
  for path in /var/backups/"$APP_NAME"-before-* "$APP_DIR".*held* /var/www/html/"$APP_NAME".*held*; do
    [[ -e $path ]] || continue
    found=true
    say "  kept: $path ($(size_of "$path") bytes)"
  done
  # Read the list first so a psql failure stops the helper instead of hiding leftovers;
  # an underscore in the name is escaped so it is not a LIKE wildcard.
  local databases
  databases=$(
    pg psql -X -d postgres -At -F '|' -v ON_ERROR_STOP=1 -v app="$APP_NAME" \
      -v pattern="${APP_NAME//_/\\_}\\_%" <<'SQL'
SELECT datname, pg_database_size(datname) FROM pg_database
WHERE datname <> :'app' AND datname LIKE :'pattern' ORDER BY datname;
SQL
  )
  while IFS='|' read -r name bytes; do
    [[ -n $name ]] || continue
    found=true
    say "  kept database: $name ($bytes bytes)"
  done <<<"$databases"
  $found || say '  none found'
}

# Install the release's runtime dependencies in a staging copy while the current
# version keeps running, with the caller's build tools; prove the native modules.
stage_backend() {
  local target="$APP_DIR/backend.next"
  # A leftover is reported, never removed: set STAGING only once this run owns it.
  [[ ! -e $target && ! -L $target ]] || abort "Remove the leftover staging directory $target first (it belongs to an interrupted run)."
  STAGING=$target
  install -d -m 0750 -o "$APP_NAME" -g "$APP_NAME" "$STAGING"
  tar -C "$RELEASE/backend" -cf - . | runuser -u "$APP_NAME" -- tar -C "$STAGING" -xf - --no-same-owner --no-same-permissions
  # A native build uses the installed runtime's headers (no download) and a
  # writable home inside the staging copy; the build tools come from the caller.
  runuser -u "$APP_NAME" -- env PATH="$NODE_DIR/bin:$CALLER_PATH" HOME="$STAGING/.build-home" \
    CHECKPOINT_DISABLE=1 SCARF_NO_ANALYTICS=true npm_config_cache="$STAGING/.npm-cache" \
    npm_config_nodedir="$NODE_DIR" bash -c 'mkdir -p "$HOME" && cd "$1" && npm ci --omit=dev' bash "$STAGING"
  rm -rf -- "$STAGING/.build-home"
  runuser -u "$APP_NAME" -- env PATH="$NODE_DIR/bin:/usr/bin:/bin" bash -c '
    cd "$1" && node --input-type=module -e "
      import {hash,verify} from \"argon2\";
      const h=await hash(\"native-compatibility-probe\");
      if(!await verify(h,\"native-compatibility-probe\"))process.exit(1);
    "' bash "$STAGING"
  [[ -f $STAGING/node_modules/prisma/build/index.js ]] || abort 'The staged dependencies have no Prisma CLI.'
}

if [[ $MODE == upgrade ]]; then
  # Load the installed settings; their validation defines APP_DIR and all binaries.
  step 'Load and validate the installed configuration'
  RELEASE=$(readlink -f -- "$2")
  APP_NAME=${3:-kloister}
  [[ $APP_NAME =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || abort 'Invalid application name.'
  EXPECTED_NAME=$APP_NAME
  [[ -f /app/$APP_NAME/scripts/install.conf ]] || abort "No managed installation at /app/$APP_NAME."
  source "/app/$APP_NAME/scripts/install.conf"
  source "$RELEASE/deploy/common.sh"
  validate_config
  [[ $APP_NAME == "$EXPECTED_NAME" ]] || abort 'Installed application name does not match the requested name.'
  lock_maintenance
  UNIT="$APP_NAME-backend.service"
  HTTPS_ORIGIN=${4:-}
  HTTPS_ORIGIN=${HTTPS_ORIGIN%/}
  [[ -z $HTTPS_ORIGIN || $HTTPS_ORIGIN =~ ^https://[^/]+$ ]] || abort 'HTTPS_ORIGIN must be https://hostname[:port], without a path.'
  [[ -f $APP_DIR/config/installed ]] || abort 'Completed managed installation marker is missing.'
  [[ ! -L $APP_DIR && ! -L $APP_DIR/backend && ! -L /var/www/html/$APP_NAME ]] || abort 'Symlinked installation roots require manual review.'
  [[ $RELEASE != "$APP_DIR" && $RELEASE != "$APP_DIR/"* ]] || abort 'Keep the extracted release outside the installed application.'
  for command in tar sha256sum ss curl runuser systemctl flock df du awk cmp find stat; do
    command -v "$command" >/dev/null || abort "Missing system command: $command"
  done
  [[ -x $NODE_DIR/bin/node ]] || abort 'The installed Node runtime is missing; runtime changes need operator planning.'

  # The package's install.conf must carry the installed settings; adopt them
  # automatically and keep the package default beside it for reference.
  step 'Use the installed settings for the new release'
  if ! cmp -s "$APP_DIR/scripts/install.conf" "$RELEASE/deploy/install.conf"; then
    [[ -e $RELEASE/deploy/install.conf.package ]] || cp -p -- "$RELEASE/deploy/install.conf" "$RELEASE/deploy/install.conf.package"
    cp -- "$APP_DIR/scripts/install.conf" "$RELEASE/deploy/install.conf"
    say 'Copied the installed scripts/install.conf into the release (package default kept as deploy/install.conf.package).'
  fi
  check_payload
  check_installed_config
  INSTALLED_VERSION=$(version_of "$APP_DIR/backend")
  NEW_VERSION=$(version_of "$RELEASE/backend")
  "$NODE_DIR/bin/node" -e '
    const p=(v)=>v.split("-")[0].split(".").map(Number);
    const [a,b]=[p(process.argv[1]),p(process.argv[2])];
    for(let i=0;i<3;i++){if(b[i]>a[i])process.exit(0);if(b[i]<a[i])break;}
    process.exit(1);
  ' "$INSTALLED_VERSION" "$NEW_VERSION" || abort "The release ($NEW_VERSION) is not newer than the installed version ($INSTALLED_VERSION)."
  say "Upgrading $APP_NAME from $INSTALLED_VERSION to $NEW_VERSION."

  # Report the build environment the dependency install will see.
  step 'Check the build environment for native modules'
  for variable in CC CXX PYTHON npm_config_python; do
    if [[ -n ${!variable:-} ]]; then say "  $variable=${!variable}"; fi
  done
  if [[ $CALLER_PATH == */opt/rh/* ]]; then say '  PATH includes a Red Hat toolset (/opt/rh).'; fi
  # Report (never install) the tools a native build would use; a prebuilt module needs none.
  for tool in "${CC:-cc}" "${CXX:-c++}" make "${PYTHON:-${npm_config_python:-python3}}"; do
    if found=$(PATH=$CALLER_PATH command -v "$tool"); then
      say "  found $tool: $found ($(PATH=$CALLER_PATH "$tool" --version 2>&1 | head -n 1))"
    else
      say "  not found: $tool (needed only if a native module must be compiled)"
    fi
  done

  step 'Check backup coverage, PostgreSQL access and free space'
  as_app node --input-type=module -e '
    import {resolve,sep} from "node:path";
    const root=resolve(process.env.APP_DIR);
    for(const key of ["ATTACHMENTS_DIR","BRANDING_DIR","BACKUP_DIR","LOG_DIR","PGPASSFILE"]){
      const value=process.env[key];
      if(!value || !resolve(value).startsWith(root+sep)){
        console.error("Backup does not cover configured path: "+key+"; stop for an adjusted backup plan");process.exit(1);
      }
    }
  '
  [[ -z $(find "$APP_DIR/data" "$APP_DIR/config" -type l -print -quit) ]] || abort 'Symlinks under data/config require an adjusted backup plan.'
  pg psql -X -d postgres -At -v ON_ERROR_STOP=1 -c 'SHOW server_version;'
  DATABASE_BYTES=$(
    pg psql -X -d postgres -At -v ON_ERROR_STOP=1 -v app_db="$APP_NAME" <<'SQL'
SELECT pg_database_size(:'app_db');
SQL
  )
  DATABASE_DIRECTORY=$(pg psql -X -d postgres -At -v ON_ERROR_STOP=1 -c 'SHOW data_directory;')
  APP_BYTES=$(size_of "$APP_DIR")
  WEB_BYTES=$(size_of "/var/www/html/$APP_NAME")
  PREVIOUS_WEB_BYTES=$(size_of "/var/www/html/$APP_NAME.previous")
  [[ ! -L /var/backups ]] || abort 'Refusing a symlinked /var/backups.'
  if [[ ! -e /var/backups ]]; then install -d -m 0700 -o root -g root /var/backups; fi
  [[ -d /var/backups && $(stat -c %u /var/backups) == 0 ]] || abort '/var/backups must be a root-owned directory.'
  BACKUP_ROOT_MODE=$(stat -c %a /var/backups)
  (((8#$BACKUP_ROOT_MODE & 0022) == 0)) || abort '/var/backups must not be writable by group or others.'
  reserve_space /var/backups $(((APP_BYTES + WEB_BYTES + PREVIOUS_WEB_BYTES + DATABASE_BYTES) * 5 / 4))
  reserve_space "$DATABASE_DIRECTORY" $((DATABASE_BYTES * 2))
  # The app filesystem gains a staged backend and the shipped script's own dump.
  BACKEND_BYTES=$(size_of "$APP_DIR/backend")
  reserve_space "$APP_DIR" $((BACKEND_BYTES * 3 + DATABASE_BYTES))
  reserve_space /var/www/html $((WEB_BYTES * 2))
  check_space
  say 'Earlier upgrade leftovers (kept; delete them yourself once no longer needed):'
  list_leftovers
  for previous in "$APP_DIR/backend.previous" "/var/www/html/$APP_NAME.previous"; do
    [[ ! -L $previous ]] || abort "Refusing a symlinked $previous."
    [[ ! -e $previous ]] || say "  $previous will be archived into the new backup, then removed so the upgrade can keep its own rollback copy."
  done

  # Build the new dependencies while users still work on the current version.
  step 'Install the new release dependencies in a staging copy (current version keeps running)'
  stage_backend

  say "Application=$APP_NAME; PostgreSQL=$PG_MAJOR port=$PG_PORT; backend=$BACKEND_PORT; Node=$NODE_VERSION"
  say "Release=$RELEASE"
  say "Private log=$LOG"
  confirm UPGRADE 'Keep users out until browser checks pass or you roll back. No firewall, SELinux or httpd configuration will change.'

  # Save supervision and settings before stopping; create a unique root-only record.
  step 'Record the maintenance state and stop the backend'
  SAFE=$(mktemp -d "/var/backups/${APP_NAME}-before-${NEW_VERSION}-$(date +%Y%m%d-%H%M%S).XXXXXX")
  RUN_MODE=manual
  if systemctl is-active --quiet "$UNIT"; then RUN_MODE=service; fi
  # PostgreSQL names are at most 63 bytes; keep the generated names within that.
  RESTORE_DB="${APP_NAME:0:24}_pre_${NEW_VERSION//[^0-9]/_}_$(date +%Y%m%d%H%M%S)_$$"
  declare -p APP_NAME APP_DIR PG_MAJOR PG_PORT PG_BIN NODE_VERSION NODE_DIR BACKEND_PORT UNIT RUN_MODE \
    HTTPS_ORIGIN RESTORE_DB APP_BYTES WEB_BYTES INSTALLED_VERSION NEW_VERSION >"$SAFE/state.env"
  printf '%s\n' "$RUN_MODE" >"$SAFE/run-mode"
  printf '%s\n' "$RESTORE_DB" >"$SAFE/recovery-db-name"
  say "Backup/state directory: $SAFE"
  STOP_REQUESTED=true
  stop_app

  # Keep SQL and filesystem backups coordinated while the application is stopped.
  step 'Back up the application database'
  pg pg_dump --format=custom --dbname="$APP_NAME" >"$SAFE/database.dump.partial"
  mv -- "$SAFE/database.dump.partial" "$SAFE/database.dump"
  "$PG_BIN/pg_restore" --list "$SAFE/database.dump" >"$SAFE/database-contents.txt"
  counts "$APP_NAME" >"$SAFE/original-counts.txt"

  step 'Back up the application, frontend and configuration files'
  tar --acls --xattrs --selinux --numeric-owner --exclude="app/$APP_NAME/backend.next" \
    -cpf "$SAFE/application.tar" -C / "app/$APP_NAME"
  tar --acls --xattrs --selinux --numeric-owner -cpf "$SAFE/frontend.tar" -C / "var/www/html/$APP_NAME"
  if [[ -d /var/www/html/$APP_NAME.previous ]]; then
    tar --acls --xattrs --selinux --numeric-owner -cpf "$SAFE/previous-frontend.tar" -C / "var/www/html/$APP_NAME.previous"
  fi
  if [[ -f /etc/httpd/conf.d/$APP_NAME.conf ]]; then cp -a "/etc/httpd/conf.d/$APP_NAME.conf" "$SAFE/"; fi
  if [[ -f /etc/systemd/system/$UNIT ]]; then cp -a "/etc/systemd/system/$UNIT" "$SAFE/"; fi
  for archive in "$SAFE"/*.tar; do tar -tf "$archive" >/dev/null; done

  # A failed restore never targets the original database and never permits upgrade.
  step 'Restore the backup into a separate recovery database and compare counts'
  pg createdb --template=template0 --owner="$APP_NAME" "$RESTORE_DB"
  pg pg_restore --dbname="$RESTORE_DB" --role="$APP_NAME" --no-owner --no-privileges --exit-on-error --single-transaction <"$SAFE/database.dump"
  counts "$RESTORE_DB" >"$SAFE/restored-counts.txt"
  cmp "$SAFE/original-counts.txt" "$SAFE/restored-counts.txt"
  pg psql -X -d postgres -v ON_ERROR_STOP=1 -v recovery_db="$RESTORE_DB" <<'SQL'
ALTER DATABASE :"recovery_db" ALLOW_CONNECTIONS false;
SQL
  (
    cd "$SAFE"
    sha256sum database.dump ./*.tar state.env original-counts.txt restored-counts.txt recovery-db-name run-mode >SHA256SUMS
    sha256sum -c SHA256SUMS
  )
  touch "$SAFE/READY"
  BACKUP_READY=true

  # The previous rollback copies are now inside verified archives; remove only them.
  step 'Archive the earlier rollback copies'
  UPGRADE_STARTED=true
  if [[ -d $APP_DIR/backend.previous ]]; then rm -rf -- "$APP_DIR/backend.previous"; fi
  if [[ -d /var/www/html/$APP_NAME.previous ]]; then rm -rf -- "/var/www/html/$APP_NAME.previous"; fi

  # Run the shipped script as a child so its exit traps cannot close this helper;
  # it moves the staged dependencies into place instead of reinstalling them.
  step 'Run the shipped upgrade (database dump, code replacement, migrations, frontend)'
  KLOISTER_STAGED_BACKEND=$STAGING bash "$RELEASE/deploy/upgrade.sh" 3>&- 4>&- 7>&-
  STAGING=''
  step 'Return to the original supervision mode'
  start_app
  step 'Check process and application health'
  check_health
  touch "$SAFE/UPGRADE-COMPLETE"
  say ''
  say "UPGRADE COMPLETE: $INSTALLED_VERSION -> $NEW_VERSION; automated checks passed."
  say "Backup/recovery: $SAFE"
  say "Private log: $LOG"
  say 'Keep users out until you check HTTPS, sign-in, boards, permissions and existing files in a browser.'
  say 'No backups or recovery databases were deleted.'
  say 'If anything is wrong, roll back with:'
  say "  sudo bash $(printf '%q' "$SELF") rollback $(printf '%q' "$SAFE")"
else
  # Only a root-owned, private backup produced by this helper can drive rollback.
  step 'Validate the coordinated backup and recorded settings'
  SAFE=$(readlink -f -- "$2")
  [[ $SAFE == /var/backups/* && -d $SAFE && ! -L $2 ]] || abort 'Expected a real backup directory under /var/backups.'
  [[ $(stat -c %u "$SAFE") == 0 && $(stat -c %a "$SAFE") == 700 ]] || abort 'Backup directory must be owned by root with mode 0700.'
  [[ -f $SAFE/READY && ! -e $SAFE/ROLLBACK-STARTED && ! -e $SAFE/ROLLED-BACK ]] || abort 'Backup is incomplete or rollback was already started; inspect instead of rerunning.'
  (
    cd "$SAFE"
    sha256sum -c SHA256SUMS
  )
  source "$SAFE/state.env"
  [[ $APP_NAME =~ ^[a-z][a-z0-9_-]{0,31}$ && $APP_DIR == "/app/$APP_NAME" ]] || abort 'Unexpected saved application paths.'
  lock_maintenance
  reserve_space "$APP_DIR" $((APP_BYTES * 5 / 4))
  reserve_space /var/www/html $(((WEB_BYTES + $(size_of "/var/www/html/$APP_NAME.previous")) * 5 / 4))
  check_space
  [[ $(
    pg psql -X -d postgres -At -v ON_ERROR_STOP=1 -v recovery_db="$RESTORE_DB" <<'SQL'
SELECT count(*) FROM pg_database WHERE datname = :'recovery_db' AND NOT datallowconn;
SQL
  ) == 1 ]] || abort 'The protected recovery database is missing or was unlocked; inspect before rollback.'
  say "Rolling back $APP_NAME from ${NEW_VERSION:-the upgraded version} to ${INSTALLED_VERSION:-the backed-up version}."
  confirm ROLLBACK 'Rollback restores the pre-upgrade point. Later writes are kept in held copies, not merged into the old version. Keep users out.'
  step 'Stop the backend before switching database and files'
  STOP_REQUESTED=true
  stop_app
  ROLLBACK_STARTED=true
  touch "$SAFE/ROLLBACK-STARTED"
  STAMP=$(date +%Y%m%d%H%M%S)
  HELD_DB="${APP_NAME:0:24}_held_${STAMP}_$$"
  HELD_APP="${APP_DIR}.held-${STAMP}-$$"
  HELD_WEB="/var/www/html/${APP_NAME}.held-${STAMP}-$$"
  HELD_PREVIOUS_WEB="/var/www/html/${APP_NAME}.previous.held-${STAMP}-$$"
  declare -p HELD_DB HELD_APP HELD_WEB HELD_PREVIOUS_WEB >"$SAFE/held-state.env"

  # Rename only the application's databases; preserve the upgraded state intact.
  step 'Keep the upgraded database and activate the tested recovery database'
  pg psql -X -d postgres -v ON_ERROR_STOP=1 -v app_db="$APP_NAME" -v held_db="$HELD_DB" -v recovery_db="$RESTORE_DB" <<'SQL'
ALTER DATABASE :"app_db" ALLOW_CONNECTIONS false;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'app_db' AND pid <> pg_backend_pid();
ALTER DATABASE :"app_db" RENAME TO :"held_db";
ALTER DATABASE :"recovery_db" RENAME TO :"app_db";
ALTER DATABASE :"app_db" ALLOW_CONNECTIONS true;
SQL

  # Keep the current trees, then restore the exact pre-upgrade files.
  step 'Keep the upgraded files and restore the pre-upgrade application and frontend'
  cd /
  mv -- "$APP_DIR" "$HELD_APP"
  if [[ -e /var/www/html/$APP_NAME ]]; then mv -- "/var/www/html/$APP_NAME" "$HELD_WEB"; fi
  if [[ -e /var/www/html/$APP_NAME.previous ]]; then mv -- "/var/www/html/$APP_NAME.previous" "$HELD_PREVIOUS_WEB"; fi
  tar --acls --xattrs --selinux --same-owner -xpf "$SAFE/application.tar" -C /
  tar --acls --xattrs --selinux --same-owner -xpf "$SAFE/frontend.tar" -C /
  if [[ -f $SAFE/previous-frontend.tar ]]; then
    tar --acls --xattrs --selinux --same-owner -xpf "$SAFE/previous-frontend.tar" -C /
  fi
  counts "$APP_NAME" >"$SAFE/rollback-counts.txt"
  cmp "$SAFE/original-counts.txt" "$SAFE/rollback-counts.txt"
  step 'Start the restored application and check health'
  start_app
  check_health
  touch "$SAFE/ROLLED-BACK"
  say ''
  say 'ROLLBACK COMPLETE: the pre-upgrade application and data are restored.'
  say "Private log: $LOG"
  say "Held database: $HELD_DB"
  say "Held application: $HELD_APP"
  say "Held frontend: $HELD_WEB"
  if [[ -e $HELD_PREVIOUS_WEB ]]; then say "Held earlier frontend copy: $HELD_PREVIOUS_WEB"; fi
  say 'Check sign-in, HTTPS, permissions and files in a browser before reopening access. No held copies were deleted.'
fi
