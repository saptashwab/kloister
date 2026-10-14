import { lstat, readdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { FolderUsageDto } from '@kloister/shared';

/**
 * Adds up the size of every file below a folder. Symbolic links are counted
 * as links and never followed, so a link cannot make the walk leave the
 * folder or loop. Entries that vanish or cannot be read during the walk are
 * skipped; a missing folder counts as empty.
 *
 * @param path The folder.
 * @returns Its path, total bytes and file count.
 */
export async function folderUsage(path: string): Promise<FolderUsageDto> {
  let bytes = 0;
  let files = 0;
  // Iterative, so deep trees (node_modules) cannot overflow the stack.
  const pending = [path];
  while (pending.length > 0) {
    const dir = pending.pop() ?? '';
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const entry = join(dir, name);
      try {
        const info = await lstat(entry);
        if (info.isDirectory()) {
          pending.push(entry);
        } else {
          bytes += info.size;
          files++;
        }
      } catch {
        // Removed or unreadable meanwhile.
      }
    }
  }
  return { path, bytes, files };
}

/**
 * Size and free space of the file system holding a path.
 *
 * @param path Any path on that file system.
 * @returns Total and free bytes (free as available to this process), or
 *   null when the platform cannot tell.
 */
export async function diskSpace(
  path: string,
): Promise<{ totalBytes: number; freeBytes: number } | null> {
  try {
    const info = await statfs(path);
    return { totalBytes: info.blocks * info.bsize, freeBytes: info.bavail * info.bsize };
  } catch {
    return null;
  }
}
