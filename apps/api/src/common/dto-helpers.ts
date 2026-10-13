import { ValidateIf } from 'class-validator';

/**
 * Trims string input; leaves anything else for the validators to reject.
 *
 * @param params class-transformer callback parameters.
 * @param params.value Raw value.
 * @returns The trimmed value.
 */
export const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Like `@IsOptional()` but only for absent fields: an explicit `null` is
 * still validated (and rejected), for columns that are NOT NULL.
 *
 * @returns The property decorator.
 */
export const OmittableNotNull = (): PropertyDecorator =>
  ValidateIf((_object: unknown, value: unknown) => value !== undefined);

/**
 * For nullable fields: skips validation when the field is absent or `null`
 * (null clears the value), and validates anything else.
 *
 * @returns The property decorator.
 */
export const Nullable = (): PropertyDecorator =>
  ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null);

/**
 * Parses a `true`/`false` query string value.
 *
 * @param params class-transformer callback parameters.
 * @param params.value Raw value.
 * @returns A boolean, or the raw value for the validator to reject.
 */
export const queryBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;
