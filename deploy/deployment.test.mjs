import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const folder = dirname(fileURLToPath(import.meta.url));
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const read = (name) => readFileSync(join(folder, name), 'utf8');
const run = (code) =>
  spawnSync(bash, ['-c', 'exec 8>/dev/null; ' + code], { cwd: folder, encoding: 'utf8' });

test('every deployment script parses in Bash with strict error handling', () => {
  assert(existsSync(bash) || process.platform !== 'win32', 'Git Bash is required');
  for (const name of readdirSync(folder).filter((name) => name.endsWith('.sh'))) {
    const result = spawnSync(bash, ['-n', name], { cwd: folder, encoding: 'utf8' });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert(read(name).startsWith('#!/usr/bin/env bash\nset -euo pipefail\n'));
  }
});

test('configuration rejects traversal, SQL metacharacters, root names and invalid ports before changes', () => {
  for (const change of [
    'APP_NAME=../escape',
    'APP_NAME="bad;sql"',
    'PG_MAJOR=../../13',
    'PG_PORT=65536',
    'BACKEND_PORT=0',
    'NODE_VERSION=26.0.0',
    'PG_PORT=$BACKEND_PORT',
  ]) {
    const result = run(`source ./common.sh; source ./install.conf; ${change}; validate_config`);
    assert.notEqual(result.status, 0, change);
  }
  const valid = run(
    'source ./common.sh; source ./install.conf; validate_config; printf "%s" "$APP_DIR"',
  );
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout, '/app/kloister');
});

test('payload check refuses missing files and an installed dependency tree', () => {
  const missing = run('source ./common.sh; RELEASE=/path-that-does-not-exist; check_payload');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Incomplete extracted release/);
});

test('health check retries failures and accepts a healthy response without network', () => {
  const healthy = run('source ./common.sh; BACKEND_PORT=3000; curl() { return 0; }; health_check');
  assert.equal(healthy.status, 0, healthy.stderr);
  const failed = run(
    'source ./common.sh; BACKEND_PORT=3000; curl() { return 1; }; sleep() { :; }; health_check',
  );
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /health check failed/);
});

test('httpd template is limited to the scoped proxy and SPA fallback', () => {
  const template = read('httpd.conf.template');
  assert.match(template, /ProxyPass \/__APP_NAME__\/api\//);
  assert.match(template, /FallbackResource \/__APP_NAME__\/index.html/);
  assert.doesNotMatch(template, /VirtualHost|SSLEngine|Listen |AllowOverride/);
});

test('installation preserves secret and operating-system boundaries', () => {
  const installer = read('install.sh');
  assert.match(installer, /create-admin.js[^\n]+>\/dev\/tty 2>\/dev\/tty/);
  assert.match(installer, /chmod 0600/);
  assert.match(installer, /sha256sum --check --status/);
  assert.match(read('common.sh'), /if ! apachectl configtest/);
  assert.match(read('common.sh'), /prior conf restored/);
  assert.doesNotMatch(
    installer,
    /systemctl enable[^\n]*backend|firewall-cmd|setsebool -P[^'\n]*\n[^f]/,
  );
  const upgrade = read('upgrade.sh');
  assert(upgrade.indexOf('pg_dump') < upgrade.indexOf('mv "$APP_DIR/backend"'));
  assert.match(upgrade, /backend.previous/);
  assert.match(read('common.sh'), /restore the pre-upgrade dump/);
  // systemd opens StandardOutput paths before changing identity; the app-owned
  // log must instead be opened by the shell already running as the app user.
  assert.doesNotMatch(read('enable-service.sh'), /Standard(?:Output|Error)=append:/);
  assert.match(read('enable-service.sh'), /ExecStart=\/bin\/bash -c 'exec/);
  for (const name of ['start.sh', 'stop.sh', 'status.sh']) {
    assert.match(read(name), /PID belongs to another process/);
    assert.match(read(name), /EUID != 0/);
  }
});

test('rejected httpd configuration restores existing bytes and never reloads', () => {
  const result = run(`
    source ./common.sh
    source ./install.conf
    validate_config
    scratch=$(mktemp -d)
    INSTALL_LOG="$scratch/install.log"
    printf 'old config\\n' > "$scratch/app.conf"
    apachectl() { printf 'syntax error\\n'; return 1; }
    systemctl() { printf 'RELOAD' > "$scratch/reloaded"; }
    (configure_httpd ./httpd.conf.template "$scratch/app.conf" "$scratch/previous") && exit 9
    [[ $(cat "$scratch/app.conf") == 'old config' ]] || exit 10
    [[ ! -e $scratch/reloaded ]] || exit 11
    (configure_httpd ./httpd.conf.template "$scratch/new.conf" "$scratch/unused") && exit 12
    [[ ! -e $scratch/new.conf ]] || exit 13
    printf '%s' "$scratch"
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('accepted httpd configuration substitutes the non-root prefix and reloads once', () => {
  const result = run(`
    source ./common.sh
    source ./install.conf
    validate_config
    scratch=$(mktemp -d)
    INSTALL_LOG="$scratch/install.log"
    apachectl() { return 0; }
    systemctl() { printf '%s' "$*" > "$scratch/reloaded"; }
    configure_httpd ./httpd.conf.template "$scratch/app.conf" "$scratch/previous"
    grep -q 'ProxyPass /kloister/api/ http://127.0.0.1:3000/api/' "$scratch/app.conf"
    [[ $(cat "$scratch/reloaded") == 'reload httpd' ]]
    printf '%s' "$scratch"
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('root log writes use a pipe opened by the app account, including hostile log destinations', () => {
  const result = run(`
    source ./common.sh
    scratch=$(mktemp -d)
    APP_DIR="$scratch/app"
    APP_NAME=kloister
    mkdir -p "$APP_DIR/logs"
    printf 'protected' > "$scratch/victim"
    # Model an app-controlled logger that selects its own destination. Root
    # must only write the pipe; it never opens that destination itself.
    install() { :; }
    runuser() {
      shift 3
      if [[ $1 == mkdir || $1 == install ]]; then "$@"; else cat > "$scratch/received"; fi
    }
    open_log test
    action 'safe action label'
    printf 'safe diagnostic\\n' >&8
    [[ $INSTALL_LOG == $INSTALL_LOG_PATH ]]
    exec 8>&-
    wait
    [[ $(cat "$scratch/victim") == protected ]]
    grep -q 'safe action label' "$scratch/received"
    grep -q 'safe diagnostic' "$scratch/received"
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(read('install.sh'), /prior="\$APP_DIR\/config\/httpd-before-/);
});

test('health failure after upgrade always prints manual rollback guidance and preserves failure status', () => {
  const handler = read('upgrade.sh')
    .split('\n')
    .find((line) => line.startsWith('trap '));
  assert(handler);
  const result = run(
    `source ./common.sh; INSTALL_LOG_PATH=review.log; ${handler}; BACKEND_PORT=3000; curl() { return 1; }; sleep() { :; }; health_check`,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /restore the pre-upgrade dump into a clean database/);
  assert.match(result.stderr, /backend.previous/);
  assert.match(result.stderr, /review.log/);
});

test('an asynchronous logger failure turns an otherwise successful setup into an honest failure', () => {
  const result = run(
    `source ./common.sh; INSTALL_LOG_PATH=review.log; (exit 7) & LOGGER_PID=$!; finish_log 0 install`,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /logger failed/);
  assert.match(read('start.sh'), /9>&- 8>&-/);
});

test('httpd rollback precedes diagnostics even when the log descriptor is broken', () => {
  const result = run(`
    source ./common.sh; source ./install.conf; validate_config
    scratch=$(mktemp -d)
    printf 'original configuration' > "$scratch/app.conf"
    apachectl() { printf 'invalid configuration'; return 1; }
    systemctl() { printf 'unexpected reload' > "$scratch/reloaded"; }
    set +e
    (set -e; exec 8>&-; configure_httpd ./httpd.conf.template "$scratch/app.conf" "$scratch/prior")
    status=$?
    set -e
    (( status != 0 ))
    [[ $(cat "$scratch/app.conf") == 'original configuration' ]]
    [[ ! -e $scratch/reloaded ]]
  `);
  assert.equal(result.status, 0, result.stderr);
});
