import { ParseUUIDPipe } from '@nestjs/common';
import { NotFoundError } from '../errors/domain-errors.js';

/**
 * Path-parameter ids. A malformed id is answered exactly like an id that does not exist,
 * with the same message, so a caller learns nothing from trying garbage.
 *
 *   @Param('id', uuidParam('Task')) id: string   →   404 "Task not found."
 */
export const uuidParam = (resource: string): ParseUUIDPipe =>
  new ParseUUIDPipe({
    exceptionFactory: () => new NotFoundError(`${resource} not found.`),
  });
