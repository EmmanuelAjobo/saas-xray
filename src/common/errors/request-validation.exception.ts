import { BadRequestException } from '@nestjs/common';

export interface FieldError {
  /** Dotted path to the offending field, e.g. `address.postcode`. */
  field: string;
  message: string;
}

/** Thrown by the global ValidationPipe; rendered by the filter as a 400 with `errors[]`. */
export class RequestValidationException extends BadRequestException {
  constructor(readonly errors: FieldError[]) {
    super('Request validation failed');
  }
}
