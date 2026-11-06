import { Controller, Get } from '@nestjs/common';
import type { RequestTenant } from '../../src/core/context/request-context.service.js';
import { CurrentTenant } from '../../src/modules/tenancy/current-tenant.decorator.js';
import { RequirePermission } from '../../src/modules/tenancy/require-permission.decorator.js';

/**
 * Test-only controller (never part of the app) under /orgs/:orgId. Lets the suite exercise
 * the real tenant and permission guards with routes that need each kind of permission,
 * including one that deliberately forgets to declare any.
 */
@Controller('orgs/:orgId/probe')
export class TenantProbeController {
  /** No @RequirePermission: the guard must refuse it (fail closed). */
  @Get('forgot-permission')
  forgotPermission() {
    return { reached: true };
  }

  @Get('anyone')
  @RequirePermission('org:read')
  anyone(@CurrentTenant() tenant: RequestTenant) {
    return tenant;
  }

  @Get('managers')
  @RequirePermission('invoice:send')
  managers() {
    return { ok: true };
  }

  @Get('owner')
  @RequirePermission('billing:manage')
  owner() {
    return { ok: true };
  }
}
