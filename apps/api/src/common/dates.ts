import { DATE_PATTERN } from '@kloister/shared';
import { ValidateBy, type ValidationOptions } from 'class-validator';

/**
 * Reports whether a string is a real calendar date in `YYYY-MM-DD` form
 * (rejects e.g. `2026-02-30`).
 *
 * @param value Any value.
 * @returns True for valid dates.
 */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * class-validator decorator for {@link isCalendarDate}.
 *
 * @param options Validation options.
 * @returns The property decorator.
 */
export const IsCalendarDate = (options?: ValidationOptions): PropertyDecorator =>
  ValidateBy(
    {
      name: 'isCalendarDate',
      validator: {
        validate: (value: unknown) => isCalendarDate(value),
        defaultMessage: () => '$property must be a date in YYYY-MM-DD form',
      },
    },
    options,
  );

/**
 * Converts a validated `YYYY-MM-DD` string to the Date Prisma stores in a
 * `@db.Date` column (midnight UTC).
 *
 * @param value The date string.
 * @returns The Date.
 */
export function toDbDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * Converts a `@db.Date` column back to `YYYY-MM-DD`.
 *
 * @param value The stored date, or null.
 * @returns The date string, or null.
 */
export function fromDbDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}
