import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ForbiddenError } from '../../common/errors/domain-errors.js';
import type { RequestTenant } from '../../core/context/request-context.service.js';
import { authCheckEvent } from '../../core/xray/xray.events.js';
import { recordXrayStep } from '../../core/xray/xray.trace.js';
import { type Permission, can } from './permissions.js';
import { REQUIRED_PERMISSION_KEY } from './require-permission.decorator.js';
import { eventTime } from '../../core/xray/xray.clock.js';

/**
 * Role-based access control for tenant routes: the caller's role (set by TenantGuard) must
 * hold the permission the route declares.
 *
 * Fails closed: a tenant route that declares no permission is refused, and so is any request
 * that reaches this point without a resolved membership.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { tenant?: RequestTenant }>();
    const isTenantRoute =
      (request.params as Record<string, unknown>)?.orgId !== undefined;
    if (!isTenantRoute) return true;

    const required = this.reflector.getAllAndOverride<Permission | undefined>(
      REQUIRED_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) {
      this.logger.error(
        `Tenant route ${request.method} ${request.route?.path ?? request.path} declares no @RequirePermission(); refusing`,
      );
      throw new ForbiddenError('You do not have permission to do this.');
    }

    const tenant = request.tenant;
    const allowed = tenant !== undefined && can(tenant.role, required);
    if (tenant) {
      recordXrayStep(
        authCheckEvent({
          ts: eventTime(),
          role: tenant.role,
          permission: required,
          allowed,
        }),
      );
    }
    if (!allowed) {
      throw new ForbiddenError('You do not have permission to do this.');
    }
    return true;
  }
}
