import { HttpStatus, ValidationPipe, type ValidationError } from '@nestjs/common';
import { ErrorCode } from '@kloister/shared';
import { ApiException } from './api-exception.js';

/** One field's validation messages, as returned in `details`. */
export interface FieldError {
  /** Dotted property path, e.g. `email`. */
  field: string;
  /** Messages produced by class-validator for that field. */
  messages: string[];
}

/**
 * Flattens nested class-validator errors into a list of field errors.
 *
 * @param errors Errors from class-validator.
 * @param prefix Path of the parent property, for nested objects.
 * @returns One entry per invalid field.
 */
export function flattenValidationErrors(errors: ValidationError[], prefix = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = prefix === '' ? error.property : `${prefix}.${error.property}`;
    const own =
      error.constraints === undefined
        ? []
        : [{ field, messages: Object.values(error.constraints) }];
    return [...own, ...flattenValidationErrors(error.children ?? [], field)];
  });
}

/**
 * Builds the global validation pipe (SPEC §8: DTO validation with
 * class-validator).
 *
 * Unknown properties are rejected rather than silently dropped, so a client
 * cannot slip extra fields (e.g. `systemRole`) past an endpoint that does not
 * expect them.
 *
 * @returns The configured pipe.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        flattenValidationErrors(errors),
      ),
  });
}
