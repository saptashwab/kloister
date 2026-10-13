import { type ArgumentMetadata, Injectable, type PipeTransform } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { isUUID } from 'class-validator';

/**
 * Lowercases a uuid, or every uuid in an array, leaving anything else for
 * the validators. Postgres compares uuids case-insensitively but ids
 * compared in code are lowercase, so input is normalised once at the edge.
 *
 * @param value Raw value.
 * @returns The value with uuids lowercased.
 */
export function lowercaseUuids(value: unknown): unknown {
  if (typeof value === 'string') return isUUID(value) ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(lowercaseUuids);
  return value;
}

/**
 * class-transformer decorator for uuid (or uuid array) fields of request
 * DTOs; see {@link lowercaseUuids}.
 *
 * @returns The property decorator.
 */
export const LowercaseUuid = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => lowercaseUuids(value));

/**
 * Global pipe that lowercases uuid-shaped path parameters before any
 * route pipe runs, so `/items/ABC…` and `/items/abc…` behave identically.
 * Other parameters (project keys, item numbers) pass through unchanged.
 */
@Injectable()
export class UuidParamCasePipe implements PipeTransform {
  /**
   * Normalises one argument.
   *
   * @param value The argument.
   * @param metadata Where it comes from.
   * @returns The argument, lowercased if it is a uuid path parameter.
   */
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    return metadata.type === 'param' ? lowercaseUuids(value) : value;
  }
}
