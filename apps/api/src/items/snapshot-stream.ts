import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import type { Readable, Writable } from 'node:stream';
import type JSZip from 'jszip';

/**
 * Finishes an offline archive before download, streaming file bytes instead of buffering them.
 * @param zip Locally generated entries; file sources open lazily when consumed.
 * @param sources Registered file inputs, explicitly closed even when output storage fails.
 * @param createOutput Private output writer; injectable for storage-failure verification.
 * @returns Private temporary file stream, removed on completion/disconnection; failures clean up immediately.
 */
export async function completedArchive(
  zip: JSZip,
  sources: readonly Readable[] = [],
  createOutput: (path: string) => Writable = (path) =>
    createWriteStream(path, { flags: 'wx', mode: 0o600 }),
): Promise<ReadStream> {
  const directory = await mkdtemp(join(tmpdir(), 'work-snapshot-'));
  try {
    const path = join(directory, 'snapshot.zip');
    await pipeline(
      zip.generateNodeStream({ streamFiles: true, compression: 'DEFLATE' }),
      createOutput(path),
    );
    const stream = createReadStream(path);
    stream.once('close', () => {
      void rm(directory, { recursive: true, force: true });
    });
    return stream;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    await Promise.allSettled(
      sources.map((source) => {
        const closed = finished(source, { cleanup: true });
        source.destroy();
        return closed;
      }),
    );
  }
}
