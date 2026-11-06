import { Injectable } from '@nestjs/common';
import {
  ForbiddenError,
  LimitReachedError,
  NotFoundError,
} from '../../common/errors/domain-errors.js';
import { AppConfigService } from '../../core/config/config.service.js';
import type {
  RequestAuth,
  RequestTenant,
} from '../../core/context/request-context.service.js';
import { PrismaService } from '../../core/prisma/prisma.service.js';
import type { Role } from '../../generated/prisma/client.js';
import { makeSlug } from './slug.js';

/** How many times to retry when a random slug suffix collides (it practically never does). */
const SLUG_ATTEMPTS = 5;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: Role;
  createdAt: Date;
}

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  /** Creates an organisation with the caller as its OWNER and a FREE subscription. */
  async create(user: RequestAuth, name: string): Promise<OrganizationSummary> {
    if (user.isDemo) {
      throw new ForbiddenError('Demo accounts cannot create organisations.');
    }
    const max = this.config.get('MAX_ORGS_PER_USER');

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          // Lock this user's row so two simultaneous creates cannot both pass the quota
          // check ("count, then insert" would race).
          await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.userId}::uuid FOR UPDATE`;
          const owned = await tx.membership.count({
            where: { userId: user.userId, role: 'OWNER' },
          });
          if (owned >= max) {
            throw new LimitReachedError(
              `You can own at most ${max} organisations.`,
            );
          }
          const org = await tx.organization.create({
            data: {
              name,
              slug: makeSlug(name),
              memberships: { create: { userId: user.userId, role: 'OWNER' } },
              subscription: { create: {} }, // schema defaults: FREE, ACTIVE
            },
          });
          return {
            id: org.id,
            name: org.name,
            slug: org.slug,
            role: 'OWNER' as const,
            createdAt: org.createdAt,
          };
        });
      } catch (error) {
        if (isUniqueViolation(error) && attempt < SLUG_ATTEMPTS) continue;
        throw error;
      }
    }
  }

  /** Organisations the caller belongs to, oldest first. */
  async listMine(userId: string): Promise<OrganizationSummary[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      include: { organization: true },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
      slug: m.organization.slug,
      role: m.role,
      createdAt: m.organization.createdAt,
    }));
  }

  async get(tenant: RequestTenant) {
    const org = await this.prisma.organization.findUnique({
      where: { id: tenant.organizationId },
      include: {
        subscription: { select: { plan: true } },
        _count: { select: { memberships: true } },
      },
    });
    if (!org) throw new NotFoundError('Organization not found.');
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      role: tenant.role,
      createdAt: org.createdAt,
      memberCount: org._count.memberships,
      plan: org.subscription?.plan ?? 'FREE',
    };
  }

  async rename(tenant: RequestTenant, name: string) {
    await this.prisma.organization.update({
      where: { id: tenant.organizationId },
      data: { name },
    });
    return this.get(tenant);
  }

  /** Deletes the organisation and everything it owns (members, tasks, clients, invoices...). */
  async remove(tenant: RequestTenant): Promise<void> {
    await this.prisma.organization.delete({
      where: { id: tenant.organizationId },
    });
  }
}
