import { Injectable } from '@nestjs/common';
import { RequestContextService } from '../context/request-context.service.js';
import { PrismaService } from './prisma.service.js';
import { type TenantClient, createTenantClient } from './tenant-client.js';

/**
 * The database client for domain code (tasks, clients, invoices, ...). Every query through
 * `client` is confined to the organisation of the current request.
 *
 * Domain modules must use this and never PrismaService; a test enforces it. PrismaService
 * (unscoped) is for identity and tenancy plumbing that legitimately works across
 * organisations: logging in, finding which organisations a user belongs to, accepting an
 * invitation by token.
 */
@Injectable()
export class TenantPrismaService {
  readonly client: TenantClient;

  constructor(prisma: PrismaService, context: RequestContextService) {
    this.client = createTenantClient(
      prisma,
      () => context.tenant?.organizationId,
    );
  }
}
