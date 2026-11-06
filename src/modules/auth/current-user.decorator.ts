import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { RequestAuth } from '../../core/context/request-context.service.js';

/** The authenticated caller on a protected route. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestAuth => {
    const request = context.switchToHttp().getRequest<{ auth?: RequestAuth }>();
    if (!request.auth) {
      // Only reachable if a route is marked @Public() but reads the user: a coding bug.
      throw new Error('CurrentUser used on a route without authentication');
    }
    return request.auth;
  },
);
