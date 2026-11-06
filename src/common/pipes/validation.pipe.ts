import { ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import {
  RequestValidationException,
  type FieldError,
} from '../errors/request-validation.exception.js';

function flatten(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => ({
      field,
      message,
    }));
    return [...own, ...flatten(error.children ?? [], field)];
  });
}

/**
 * Global request validation:
 * - `whitelist` + `forbidNonWhitelisted`: unknown fields are rejected, not silently kept
 *   (this is the mass-assignment defence: a client can never set `role` or `organizationId`
 *   by adding it to the body).
 * - `transform`: query/path strings are coerced to the DTO's declared types.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new RequestValidationException(flatten(errors)),
  });
}
