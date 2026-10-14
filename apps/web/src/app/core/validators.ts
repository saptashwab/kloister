import { type ValidatorFn, Validators } from '@angular/forms';

/**
 * Field is required. Wraps the static `Validators.required` so forms pass a
 * plain function instead of an unbound class method.
 *
 * @param control The control to validate.
 * @returns Validation errors, or null.
 */
export const required: ValidatorFn = (control) => Validators.required(control);

/**
 * Value must look like an email. Wraps the static `Validators.email`.
 *
 * @param control The control to validate.
 * @returns Validation errors, or null.
 */
export const email: ValidatorFn = (control) => Validators.email(control);

/**
 * A whole number within an inclusive range, for settings forms. The API
 * checks the same ranges.
 *
 * @param limits The range.
 * @param limits.min Lowest value.
 * @param limits.max Highest value.
 * @returns The validator.
 */
export function wholeNumber(limits: { min: number; max: number }): ValidatorFn {
  return (control) => {
    const value: unknown = control.value;
    if (value === null || value === '') return { required: true };
    const n = Number(value);
    if (!Number.isInteger(n)) return { integer: true };
    if (n < limits.min) return { min: { min: limits.min, actual: n } };
    if (n > limits.max) return { max: { max: limits.max, actual: n } };
    return null;
  };
}
