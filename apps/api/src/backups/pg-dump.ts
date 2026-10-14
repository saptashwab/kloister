import { spawn } from 'node:child_process';

/** Result of running pg_dump. */
export interface DumpResult {
  /** Exit code; null when the process was killed. */
  code: number | null;
  /** What pg_dump wrote to standard error, shortened. */
  stderr: string;
}

/**
 * Runs a program without a shell and collects its exit code and error
 * output. Replaced by a fake in unit tests.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<DumpResult>;

/** Most error output kept from pg_dump, in characters. */
const STDERR_MAX = 2_000;

/**
 * The default {@link CommandRunner}: `child_process.spawn` with no shell, so
 * no argument is ever interpreted by one, and a hard timeout.
 *
 * @param command The program.
 * @param args Its arguments.
 * @param env Its whole environment.
 * @param timeoutMs Time after which it is killed.
 * @returns The exit code and error output; rejects when it cannot start.
 */
export const spawnCommand: CommandRunner = (command, args, env, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: timeoutMs,
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_MAX);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr: stderr.trim() }));
  });

/**
 * Builds pg_dump's environment from the backend's database URL (SPEC §9.1:
 * credentials come from the environment or `config/.pgpass`, never from
 * code). Host, port, user, database and SSL settings go into the standard
 * libpq variables. The password is passed as `PGPASSWORD` only when no
 * `PGPASSFILE` is configured; with one, pg_dump reads `.pgpass` itself.
 * Nothing goes on the command line, where other users could see it, and
 * nothing else of the backend's environment is passed on.
 *
 * @param databaseUrl The backend's `DATABASE_URL`.
 * @param env The backend's environment, for `PATH`, `PGPASSFILE` and locale.
 * @returns The child environment.
 */
export function pgDumpEnvironment(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  const child: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT']) {
    if (env[name] !== undefined) child[name] = env[name];
  }
  // IPv6 hosts come bracketed in URLs (`[::1]`); libpq wants them bare.
  if (url.hostname !== '') {
    child['PGHOST'] = decodeURIComponent(url.hostname).replace(/^\[(.*)\]$/, '$1');
  }
  // libpq also accepts a socket folder as `?host=/var/run/postgresql`.
  const socketHost = url.searchParams.get('host');
  if (socketHost !== null && socketHost !== '') child['PGHOST'] = socketHost;
  if (url.port !== '') child['PGPORT'] = url.port;
  if (url.username !== '') child['PGUSER'] = decodeURIComponent(url.username);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (database !== '') child['PGDATABASE'] = database;
  // SSL settings map to their libpq variables.
  for (const [param, name] of [
    ['sslmode', 'PGSSLMODE'],
    ['sslrootcert', 'PGSSLROOTCERT'],
    ['sslcert', 'PGSSLCERT'],
    ['sslkey', 'PGSSLKEY'],
  ] as const) {
    const value = url.searchParams.get(param);
    if (value !== null) child[name] = value;
  }
  const passFile = env['PGPASSFILE'];
  if (passFile !== undefined && passFile !== '') {
    child['PGPASSFILE'] = passFile;
  } else if (url.password !== '') {
    child['PGPASSWORD'] = decodeURIComponent(url.password);
  }
  return child;
}

/**
 * pg_dump's arguments: the custom format (`-Fc`, SPEC §9.1), never asking
 * for a password (`--no-password`), written to `target`.
 *
 * @param target Path of the dump file.
 * @returns The arguments.
 */
export function pgDumpArgs(target: string): string[] {
  return ['--format=custom', '--no-password', `--file=${target}`];
}

/**
 * The name of a backup file (SPEC §9.1).
 *
 * @param appName The app name; `backup` when unset (local development).
 * @param at When the backup started, in server-local time.
 * @returns `<app_name>-<yyyymmdd-hhmmss>.dump`.
 */
export function backupFileName(appName: string, at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${appName === '' ? 'backup' : appName}-${date}-${time}.dump`;
}

/**
 * Reads the start time from a backup file name made by {@link backupFileName}.
 *
 * @param name A file name.
 * @param prefix The app name the file must belong to.
 * @returns The time, or null when the name is not one of ours.
 */
export function backupFileTime(name: string, prefix: string): Date | null {
  if (!name.startsWith(`${prefix}-`)) return null;
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.dump$/.exec(
    name.slice(prefix.length + 1),
  );
  if (match === null) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return new Date(y ?? 0, (mo ?? 1) - 1, d, h, mi, s);
}
