import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { conflict } from './api-exception.js';
import {
  isForeignKeyViolation,
  isUniqueViolation,
  mapTransactionConflict,
} from './prisma-errors.js';

/**
 * Runs work in a serializable transaction. Serialization failures become
 * 409 `CONFLICT` ("try again"), and so do unique-constraint violations, with
 * `duplicateMessage` (e.g. a duplicate label name), and foreign-key
 * violations: item creation runs read committed, so a row it inserts
 * concurrently (a child of an item being deleted, a card in a bucket being
 * deleted) is only caught by the database.
 *
 * Serializable isolation makes the checks a change relies on (no cycle, the
 * bucket is empty, only one active sprint) hold at commit time: a concurrent
 * change that would break them makes one of the two transactions fail.
 *
 * @param prisma Database client.
 * @param work The transaction body.
 * @param duplicateMessage Message for a unique-constraint violation.
 * @param timeout Optional bounded duration for an explicitly large atomic operation.
 * @returns The body's result.
 */
export async function serializable<T>(
  prisma: PrismaService,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  duplicateMessage = 'Another change was made at the same time; please try again',
  timeout?: number,
): Promise<T> {
  try {
    return await prisma.$transaction(work, {
      isolationLevel: 'Serializable',
      ...(timeout === undefined ? {} : { timeout }),
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict(duplicateMessage);
    if (isForeignKeyViolation(error)) {
      throw conflict('Something this change refers to was just changed; please try again');
    }
    throw mapTransactionConflict(error);
  }
}
