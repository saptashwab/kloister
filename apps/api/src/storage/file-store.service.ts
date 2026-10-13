import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ErrorCode } from '@kloister/shared';
import { ApiException, invalidField, notFound } from '../common/api-exception.js';
import { AppConfig } from '../config/app-config.js';
import { SNIFF_BYTES } from './file-types.js';

/** An upload written to the incoming folder, not yet kept. */
export interface ReceivedFile {
  /** Where the bytes are now. */
  tempPath: string;
  /** Size in bytes. */
  sizeBytes: number;
  /** Hex SHA-256 of the content. */
  sha256: string;
  /** The first bytes, for type detection. */
  head: Buffer;
}

/** Folder inside the attachments directory for uploads still being checked. */
const INCOMING = '.incoming';

/**
 * Stores attachment and inline-image bytes on disk (SPEC §5), at
 * `<ATTACHMENTS_DIR>/<projectId>/<storedName>`, outside the web root. Stored
 * names are random uuids, never derived from user input, and project ids
 * come from the database, so no request can choose a path.
 *
 * Uploads are streamed to an incoming folder on the same file system while
 * their size is counted and their hash computed, then renamed into place
 * once the database row is written; nothing is held in memory.
 */
@Injectable()
export class FileStoreService {
  private readonly logger = new Logger(FileStoreService.name);

  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param config Runtime configuration (the attachments directory).
   */
  constructor(private readonly config: AppConfig) {}

  /**
   * Streams an upload into the incoming folder.
   *
   * @param source The request body.
   * @param maxBytes Largest size accepted.
   * @returns The received file; 413 `FILE_TOO_LARGE` when larger than the
   *   limit, 400 when empty. Nothing is left behind on failure.
   */
  async receive(source: Readable, maxBytes: number): Promise<ReceivedFile> {
    const dir = join(this.config.attachmentsDir, INCOMING);
    await mkdir(dir, { recursive: true, mode: 0o750 });
    const tempPath = join(dir, randomUUID());
    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > maxBytes) {
          callback(fileTooLarge(maxBytes));
          return;
        }
        if (head.length < SNIFF_BYTES) {
          head = Buffer.concat([head, chunk.subarray(0, SNIFF_BYTES - head.length)]);
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(source, meter, createWriteStream(tempPath, { mode: 0o640 }));
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
    if (size === 0) {
      await rm(tempPath, { force: true });
      throw invalidField('file', 'The file is empty');
    }
    return { tempPath, sizeBytes: size, sha256: hash.digest('hex'), head };
  }

  /**
   * Moves a received file into its project folder under its stored name.
   *
   * @param file The received file.
   * @param projectId Project id (from the database).
   * @param storedName Random stored name.
   * @returns Resolves once in place.
   */
  async keep(file: ReceivedFile, projectId: string, storedName: string): Promise<void> {
    const dir = join(this.config.attachmentsDir, projectId);
    await mkdir(dir, { recursive: true, mode: 0o750 });
    await rename(file.tempPath, join(dir, storedName));
  }

  /**
   * Throws a received file away.
   *
   * @param file The received file.
   * @returns Resolves once removed.
   */
  async discard(file: ReceivedFile): Promise<void> {
    await rm(file.tempPath, { force: true });
  }

  /**
   * Opens a stored file for reading.
   *
   * @param projectId Project id.
   * @param storedName Stored name.
   * @returns The stream; 404 if the file is missing on disk.
   */
  async open(projectId: string, storedName: string): Promise<ReadStream> {
    const path = join(this.config.attachmentsDir, projectId, storedName);
    try {
      await stat(path);
    } catch {
      this.logger.warn(`Stored file missing: ${projectId}/${storedName}`);
      throw notFound('File');
    }
    return createReadStream(path);
  }

  /**
   * Deletes uploads left in the incoming folder by an interrupted request or
   * a stopped process, once they are older than `maxAgeMs`.
   *
   * @param maxAgeMs Age after which an incoming file is abandoned.
   * @returns How many files were deleted.
   */
  async sweepIncoming(maxAgeMs: number): Promise<number> {
    const dir = join(this.config.attachmentsDir, INCOMING);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return 0;
    }
    let deleted = 0;
    for (const name of names) {
      const path = join(dir, name);
      try {
        if (Date.now() - (await stat(path)).mtimeMs > maxAgeMs) {
          await rm(path, { force: true });
          deleted++;
        }
      } catch {
        // Finished or removed meanwhile.
      }
    }
    return deleted;
  }

  /**
   * Deletes stored files after their rows are gone. Failures are logged, not
   * thrown: the rows (and so the quota) are already released.
   *
   * @param files Project id and stored name of each file.
   * @returns Resolves once attempted.
   */
  async remove(files: readonly { projectId: string; storedName: string }[]): Promise<void> {
    for (const file of files) {
      try {
        await rm(join(this.config.attachmentsDir, file.projectId, file.storedName), {
          force: true,
        });
      } catch (error) {
        this.logger.error(
          `Could not delete ${file.projectId}/${file.storedName}: ${String(error)}`,
        );
      }
    }
  }
}

/**
 * The 413 for an upload over the size limit.
 *
 * @param maxBytes The limit.
 * @returns The exception.
 */
export function fileTooLarge(maxBytes: number): ApiException {
  return new ApiException(
    HttpStatus.PAYLOAD_TOO_LARGE,
    ErrorCode.FILE_TOO_LARGE,
    `Files may be at most ${Math.floor(maxBytes / (1024 * 1024))} MB`,
  );
}
