import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard.js';
import { TenantGuard } from './tenant.guard.js';

/**
 * Registers the tenant guards globally. Order matters and is the order listed here:
 * (rate limit → authentication →) membership → permission.
 */
@Module({
  providers: [
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class TenancyModule {}
