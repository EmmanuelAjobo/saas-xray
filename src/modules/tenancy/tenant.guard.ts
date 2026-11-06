import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  NotFoundError,
  UnauthenticatedError,
} from '../../common/errors/domain-errors.js';
import {
  type RequestAuth,
  RequestContextService,
  type RequestTenant,
} from '../../core/context/request-context.service.js';
import { PrismaService } from '../../core/prisma/prisma.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Identical for "no such organisation", "malformed id" and "you are not a member". */
const NOT_FOUND = 'Organization not found.';

type TenantRequest = Request & { auth?: RequestAuth; tenant?: RequestTenant };

/**
 * Tenant isolation at the edge. Any route with an `:orgId` path parameter is checked here:
 * the caller must be a member of that organisation, and their CURRENT role is loaded fresh
 * on every request (so a demotion or removal takes effect immediately, not when their
 * access token expires).
 *
 * A non-member gets 404, never 403: a 403 would confirm the organisation exists.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: RequestContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TenantRequest>();
    const organizationId = (request.params as Record<string, unknown>)?.orgId;
    if (organizationId === undefined) return true; // not a tenant route

    const auth = request.auth;
    if (!auth) throw new UnauthenticatedError('Authentication required.');

    if (typeof organizationId !== 'string' || !UUID.test(organizationId)) {
      throw new NotFoundError(NOT_FOUND);
    }
    const membership = await this.prisma.membership.findUnique({
      where: {
        userId_organizationId: { userId: auth.userId, organizationId },
      },
      select: { id: true, role: true },
    });
    if (!membership) throw new NotFoundError(NOT_FOUND);

    const tenant: RequestTenant = {
      organizationId,
      membershipId: membership.id,
      role: membership.role,
    };
    request.tenant = tenant;
    this.context.setTenant(tenant);
    return true;
  }
}
