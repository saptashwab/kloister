import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '@kloister/shared';
import { ApiException } from './api-exception.js';

/**
 * Reads the Prisma error code from a thrown value.
 *
 * @param error Anything thrown by Prisma.
 * @returns The code (e.g. `P2002`), or undefined.
 */
function prismaCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/**
 * Reports whether an error is a unique-constraint violation.
 *
 * @param error Anything thrown by Prisma.
 * @returns True for Prisma error P2002.
 */
export function isUniqueViolation(error: unknown): boolean {
  return prismaCode(error) === 'P2002';
}

/**
 * Reports whether an error is a foreign-key violation, i.e. a referenced
 * row was deleted by a concurrent request after it was checked.
 *
 * @param error Anything thrown by Prisma.
 * @returns True for Prisma error P2003.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  return prismaCode(error) === 'P2003';
}

/**
 * Converts a serializable-transaction conflict (Prisma P2034, raised when a
 * concurrent transaction touched the same rows) into 409 `CONFLICT`, so the
 * client sees "try again" rather than a 500. Other errors are returned as is.
 *
 * @param error Anything thrown inside a transaction.
 * @returns The error to rethrow.
 */
export function mapTransactionConflict(error: unknown): unknown {
  return prismaCode(error) === 'P2034'
    ? new ApiException(
        HttpStatus.CONFLICT,
        ErrorCode.CONFLICT,
        'Another change was made at the same time; please try again',
      )
    : error;
}
