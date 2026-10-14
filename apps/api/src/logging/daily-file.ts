import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Formats a server-local calendar date.
 *
 * @param date The moment.
 * @returns `YYYY-MM-DD` in the server's time zone.
 */
export function localDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A log destination that writes to one file per server-local day,
 * `<dir>/<prefix>-<yyyy-mm-dd>.log` (SPEC §9.1: `logs/backend/backend-…`,
 * `logs/backups/backup-…`), switching files at midnight. pino writes each
 * entry with {@link write}; files are opened for appending, so a restart
 * continues the day's file. Old files are removed by {@link pruneDailyFiles}
 * under the admin's retention setting (SPEC §9.5).
 */
export class DailyFileStream {
  private current: { date: string; stream: WriteStream } | null = null;

  /**
   * Creates the folder if needed; files are opened on the first write.
   *
   * @param dir Folder for the files.
   * @param prefix File name prefix.
   * @param now Clock, replaceable in tests.
   */
  constructor(
    private readonly dir: string,
    private readonly prefix: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o750 });
  }

  /**
   * Appends one log entry to today's file.
   *
   * @param chunk The serialized entry.
   * @returns True, as pino expects from a destination.
   */
  write(chunk: string): boolean {
    const date = localDate(this.now());
    if (this.current?.date !== date) {
      this.current?.stream.end();
      const path = join(this.dir, `${this.prefix}-${date}.log`);
      const stream = createWriteStream(path, { flags: 'a', mode: 0o640 });
      // A full disk or an unwritable file must never stop the backend: the
      // failure goes to standard error and the next entry opens the file again.
      stream.on('error', (error) => {
        process.stderr.write(`Log file ${path} cannot be written: ${String(error)}\n`);
        if (this.current?.stream === stream) this.current = null;
      });
      this.current = { date, stream };
    }
    this.current.stream.write(chunk);
    return true;
  }

  /**
   * Flushes and closes the open file.
   *
   * @returns Resolves once closed.
   */
  end(): Promise<void> {
    const open = this.current;
    this.current = null;
    if (open === null) return Promise.resolve();
    return new Promise((resolve) => open.stream.end(resolve));
  }
}

/**
 * Deletes daily files (`<prefix>-<yyyy-mm-dd>.log`) whose date is more than
 * `retentionDays` days before today, by the date in the name. Other files
 * in the folder are never touched.
 *
 * @param dir The folder.
 * @param prefix File name prefix.
 * @param retentionDays Days to keep, today included.
 * @param now The current time.
 * @returns Names of the deleted files.
 */
export async function pruneDailyFiles(
  dir: string,
  prefix: string,
  retentionDays: number,
  now: Date = new Date(),
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const oldest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (retentionDays - 1));
  const keepFrom = localDate(oldest);
  const pattern = new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})\\.log$`);
  const deleted: string[] = [];
  for (const name of names.sort()) {
    const date = pattern.exec(name)?.[1];
    // ISO dates compare correctly as strings.
    if (date === undefined || date >= keepFrom) continue;
    try {
      await rm(join(dir, name), { force: true });
      deleted.push(name);
    } catch {
      // Removed meanwhile, or not ours to remove; try again tomorrow.
    }
  }
  return deleted;
}
