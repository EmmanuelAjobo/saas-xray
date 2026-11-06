import { SetMetadata } from '@nestjs/common';
import type { Permission } from './permissions.js';

export const REQUIRED_PERMISSION_KEY = 'requiredPermission';

/**
 * Declares what a route under `/orgs/:orgId/...` needs. Mandatory: a tenant route without it
 * is refused (fail closed), so forgetting it can never leave an endpoint open to every member.
 */
export const RequirePermission = (
  permission: Permission,
): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSION_KEY, permission);
