import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { RequestTenant } from '../../core/context/request-context.service.js';

/** The organisation in scope and the caller's role in it, on a `/orgs/:orgId/...` route. */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestTenant => {
    const request = context
      .switchToHttp()
      .getRequest<{ tenant?: RequestTenant }>();
    if (!request.tenant) {
      // Only reachable on a route outside /orgs/:orgId that reads the tenant: a coding bug.
      throw new Error(
        'CurrentTenant used on a route that is not tenant-scoped',
      );
    }
    return request.tenant;
  },
);
