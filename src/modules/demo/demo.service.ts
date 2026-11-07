import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  ForbiddenError,
  NotFoundError,
  TemporarilyUnavailableError,
} from '../../common/errors/domain-errors.js';
import { AppConfigService } from '../../core/config/config.service.js';
import type { RequestAuth } from '../../core/context/request-context.service.js';
import { PrismaService } from '../../core/prisma/prisma.service.js';
import type { Role } from '../../generated/prisma/client.js';
import { seedDemoOrganization } from '../../seed/demo-template.js';
import {
  AuthService,
  type ClientMeta,
  type Session,
} from '../auth/auth.service.js';

/** 6 random bytes = 12 hex characters: a unique, URL-safe tag for each sandbox. */
const TAG_BYTES = 6;

export interface DemoSession {
  session: Session;
  organization: { id: string; name: string; slug: string };
  expiresAt: Date;
  role: Role;
}

/**
 * The "Try the demo" button (ARCHITECTURE §18): every visitor gets their own sandbox
 * organisation, seeded from the template, and is signed in as its owner, with zero sign-up.
 *
 * Guardrails live elsewhere and already apply, because demo accounts are flagged `isDemo`:
 * they cannot create organisations or invite people, invoices sent from a demo organisation
 * send no real email, and demo users have no password to guess or change.
 */
@Injectable()
export class DemoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
  ) {}

  assertEnabled(): void {
    // A switched-off demo looks like a route that does not exist.
    if (!this.config.get('DEMO_ENABLED')) throw new NotFoundError('Not found.');
  }

  async start(meta: ClientMeta): Promise<DemoSession> {
    this.assertEnabled();

    // A soft cap (concurrent starts can overshoot it slightly) that keeps a flood of
    // visitors from filling the database; sandboxes expire, so it frees itself.
    const active = await this.prisma.organization.count({
      where: { isDemo: true, demoExpiresAt: { gt: new Date() } },
    });
    if (active >= this.config.get('DEMO_MAX_ACTIVE')) {
      throw new TemporarilyUnavailableError(
        'The demo is very busy right now. Please try again in a few minutes.',
      );
    }

    const seeded = await seedDemoOrganization(this.prisma, {
      tag: randomBytes(TAG_BYTES).toString('hex'),
      ttlHours: this.config.get('DEMO_TTL_HOURS'),
    });
    const session = await this.auth.startSessionFor(seeded.ownerUserId, meta);
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: seeded.organizationId },
      select: { id: true, name: true, slug: true, demoExpiresAt: true },
    });
    return {
      session,
      organization: { id: org.id, name: org.name, slug: org.slug },
      expiresAt: org.demoExpiresAt as Date,
      role: 'OWNER',
    };
  }

  /**
   * Lets a visitor feel role-based access by becoming the sandbox's owner, admin or member.
   * Only ever moves between the three personas of the visitor's OWN sandbox.
   */
  async switchRole(
    auth: RequestAuth,
    role: Role,
    meta: ClientMeta,
  ): Promise<DemoSession> {
    this.assertEnabled();
    if (!auth.isDemo) {
      throw new ForbiddenError(
        'Switching roles is only available in the demo.',
      );
    }

    const current = await this.prisma.membership.findFirst({
      where: { userId: auth.userId, organization: { isDemo: true } },
      select: { organizationId: true },
    });
    if (!current) throw new NotFoundError('Demo organization not found.');

    const target = await this.prisma.membership.findFirst({
      where: {
        organizationId: current.organizationId,
        role,
        user: { isDemo: true },
      },
      select: {
        userId: true,
        organization: {
          select: { id: true, name: true, slug: true, demoExpiresAt: true },
        },
      },
    });
    if (!target) throw new NotFoundError('Demo organization not found.');

    const session = await this.auth.startSessionFor(target.userId, meta);
    // The old persona's session ends, so a visitor holds exactly one at a time.
    await this.auth.revokeSession(auth.sessionId);
    const { organization } = target;
    return {
      session,
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
      },
      expiresAt: organization.demoExpiresAt as Date,
      role,
    };
  }
}
