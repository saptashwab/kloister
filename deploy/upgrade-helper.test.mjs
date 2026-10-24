import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Exercise the upgrade helper's functions in isolation with mocked OS tools; the
// full upgrade and rollback are operator acceptance steps on the RHEL host.
const folder = dirname(fileURLToPath(import.meta.url));
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const code = readFileSync(join(folder, 'upgrade-helper.sh'), 'utf8');
const upgrade = readFileSync(join(folder, 'upgrade.sh'), 'utf8');
const run = (args, input) => spawnSync(bash, args, { cwd: folder, input, encoding: 'utf8' });
const definitions = code.slice(
  code.indexOf('# Report the failed stage'),
  code.indexOf('\nif [[ $MODE == upgrade ]]; then\n'),
);
const isolated = (body) =>
  run(
    [],
    `set -Eeuo pipefail
exec 3>&1 4>&2
MODE=upgrade
SELF=/root/upgrade-helper.sh
LOG=/private/test.log
STAGE=preflight
ERROR_LINE=0
SAFE=''
STAGING=''
STOP_REQUESTED=false
UPGRADE_STARTED=false
ROLLBACK_STARTED=false
BACKUP_READY=false
APP_NAME=kloister
APP_DIR=/app/kloister
UNIT=kloister-backend.service
BACKEND_PORT=3000
HTTPS_ORIGIN=''
${definitions}
${body}
`,
  );

test('the helper has LF lines, parses, and shows help without root', () => {
  assert(!code.includes('\r'));
  assert.equal(run(['-n', 'upgrade-helper.sh']).status, 0);
  const help = run(['upgrade-helper.sh', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /upgrade RELEASE_DIRECTORY/);
  assert.match(help.stdout, /rollback BACKUP_DIRECTORY/);
});

test('the helper never changes firewall, SELinux, httpd configuration or packages', () => {
  const commands = code
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  for (const forbidden of [
    /firewall-cmd/,
    /setsebool|semanage|setenforce|restorecon|chcon/,
    /\b(dnf|yum|rpm)\b/,
    /apachectl|systemctl (reload|restart|enable|disable) httpd/,
    /systemctl enable/,
  ])
    assert.doesNotMatch(commands, forbidden);
});

test('deletions are limited to the archived rollback copies and the staging copy', () => {
  const removals = code.split('\n').filter((line) => /\brm -/.test(line));
  assert.deepEqual(
    removals.map((line) => line.trim()),
    [
      'if [[ -n $STAGING && -d $STAGING ]] && ! $UPGRADE_STARTED; then rm -rf -- "$STAGING"; fi',
      'rm -rf -- "$STAGING/.build-home"',
      'if [[ -d $APP_DIR/backend.previous ]]; then rm -rf -- "$APP_DIR/backend.previous"; fi',
      'if [[ -d /var/www/html/$APP_NAME.previous ]]; then rm -rf -- "/var/www/html/$APP_NAME.previous"; fi',
    ],
  );
  // The copies are removed only after the backup archives are verified.
  assert(
    code.indexOf('touch "$SAFE/READY"') < code.indexOf('rm -rf -- "$APP_DIR/backend.previous"'),
  );
  assert.doesNotMatch(code, /DROP DATABASE|dropdb/);
});

test('dependencies are staged and the backend stops only after confirmation', () => {
  const stage = code.indexOf('\n  stage_backend\n');
  const confirmation = code.indexOf('confirm UPGRADE');
  const stop = code.indexOf('\n  stop_app\n');
  assert(stage > 0 && stage < confirmation && confirmation < stop);
  assert.match(code, /KLOISTER_STAGED_BACKEND=\$STAGING bash "\$RELEASE\/deploy\/upgrade\.sh"/);
  assert.match(upgrade, /\[\[ \$staged == "\$APP_DIR\/backend\.next"/);
  assert.match(upgrade, /if \[\[ -z \$staged \]\]; then as_app npm ci --omit=dev/);
});

test('a failure before stopping says nothing was stopped and removes the staging copy', () => {
  const marker = spawnSync(bash, ['-c', 'mktemp -d'], { encoding: 'utf8' }).stdout.trim();
  const result = isolated(`STAGE="Install the new release dependencies"
STAGING=${marker}
false`);
  assert.equal(spawnSync(bash, ['-c', `test -e ${marker}`]).status, 1, 'staging copy removed');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAILED at step: Install the new release dependencies/);
  assert.match(result.stderr, /Private log: \/private\/test.log/);
  assert.match(result.stderr, /Nothing was stopped or replaced/);
});

test('a failure after stopping prints the restart command for the recorded mode', () => {
  const manual = isolated(
    'STOP_REQUESTED=true; RUN_MODE=manual; STAGE="Back up the database"; false',
  );
  assert.match(manual.stderr, /FAILED at step: Back up the database/);
  assert.match(manual.stderr, /runuser -u kloister -- bash \/app\/kloister\/scripts\/start.sh/);
  const service = isolated('STOP_REQUESTED=true; RUN_MODE=service; false');
  assert.match(service.stderr, /systemctl start kloister-backend.service/);
});

test('a failure during the upgrade prints the exact rollback command', () => {
  const result = isolated(
    'SAFE=/var/backups/kloister-before-1.2.0-x; UPGRADE_STARTED=true; BACKUP_READY=true; STAGE=migrations; false',
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAILED at step: migrations/);
  assert.match(result.stderr, /No automatic rollback was attempted/);
  assert.match(
    result.stderr,
    /sudo bash \/root\/upgrade-helper.sh rollback \/var\/backups\/kloister-before-1.2.0-x/,
  );
});

test('a partial rollback refuses blind retries', () => {
  const result = isolated('ROLLBACK_STARTED=true; STAGE="restore files"; false');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Rollback stopped partway/);
  assert.match(result.stderr, /do not rerun blindly/);
});

test('health checks fail honestly without network access or sleeping', () => {
  const result = isolated('curl() { return 22; }; sleep() { :; }; check_health');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Loopback health did not pass/);
});

test('shared filesystems add their space demands', () => {
  const result = isolated(`stat() { printf '1'; }
available_bytes() { printf '100'; }
reserve_space /backup 60
reserve_space /app 50
check_space`);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /need 110 bytes free; available 100/);
  assert.match(result.stderr, /Insufficient combined free space/);
});
