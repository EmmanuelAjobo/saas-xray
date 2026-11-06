import { Injectable } from '@nestjs/common';
import { PlanLimitExceededError } from '../../common/errors/domain-errors.js';
import { AppConfigService } from '../../core/config/config.service.js';
import type { PrismaService } from '../../core/prisma/prisma.service.js';
import type { Plan } from '../../generated/prisma/client.js';

/** The slice of the database client this needs, so it works inside a transaction too. */
type Db = Pick<PrismaService, 'membership' | 'invitation' | 'subscription'>;

/**
 * What an organisation's plan allows (ARCHITECTURE §10.4). Services call this before
 * creating a limited resource; going over the limit is a 402 with a link to upgrade.
 *
 * The limits come from the environment (FREE_PLAN_MAX_SEATS, PRO_PLAN_MAX_SEATS). Billing
 * (Stripe) arrives later and will change which plan an organisation is on, not this logic.
 */
@Injectable()
export class EntitlementsService {
  constructor(private readonly config: AppConfigService) {}

  seatLimit(plan: Plan): number {
    return plan === 'PRO'
      ? this.config.get('PRO_PLAN_MAX_SEATS')
      : this.config.get('FREE_PLAN_MAX_SEATS');
  }

  /**
   * A seat is a member OR an unexpired pending invitation: an invite holds its seat, so
   * ten invitations cannot be sent on a three-seat plan and then all accepted.
   */
  async seatsInUse(
    db: Db,
    organizationId: string,
    now = new Date(),
  ): Promise<number> {
    const [members, invited] = await Promise.all([
      db.membership.count({ where: { organizationId } }),
      db.invitation.count({
        where: { organizationId, status: 'PENDING', expiresAt: { gt: now } },
      }),
    ]);
    return members + invited;
  }

  /** Throws PlanLimitExceededError unless one more seat fits. Call under the org lock. */
  async assertSeatAvailable(
    db: Db,
    organizationId: string,
    now = new Date(),
  ): Promise<void> {
    const subscription = await db.subscription.findUnique({
      where: { organizationId },
      select: { plan: true },
    });
    const plan = subscription?.plan ?? 'FREE';
    const limit = this.seatLimit(plan);
    if ((await this.seatsInUse(db, organizationId, now)) >= limit) {
      throw new PlanLimitExceededError(
        `The ${plan} plan allows ${limit} seats (members plus pending invitations).`,
        `${this.config.get('WEB_ORIGIN')}/settings/billing`,
      );
    }
  }
}
