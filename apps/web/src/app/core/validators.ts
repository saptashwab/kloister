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
