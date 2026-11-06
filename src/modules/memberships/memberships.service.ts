import { Injectable } from '@nestjs/common';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../common/errors/domain-errors.js';
import type { RequestTenant } from '../../core/context/request-context.service.js';
import { PrismaService } from '../../core/prisma/prisma.service.js';
import type { Role } from '../../generated/prisma/client.js';
import { type Permission, can } from '../tenancy/permissions.js';

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

export interface MemberView {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: Date;
}

const CANNOT_TOUCH_OWNER = 'Only an owner can change or remove an owner.';

/**
 * Who is on the team, and the rules for changing it.
 *
 * Every change runs in one transaction that first LOCKS the organisation row. That
 * serialises concurrent membership changes in the same organisation, which is what makes the
 * "always at least one owner" rule safe: without the lock, two owners demoting each other at
 * the same instant would each see "the other is still an owner" and leave zero.
 */
@Injectable()
export class MembershipsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenant: RequestTenant): Promise<MemberView[]> {
    const members = await this.prisma.membership.findMany({
      where: { organizationId: tenant.organizationId },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return members.map((m) => ({
      id: m.id,
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      joinedAt: m.createdAt,
    }));
  }

  async changeRole(
    tenant: RequestTenant,
    membershipId: string,
    newRole: Role,
  ): Promise<MemberView> {
    await this.prisma.$transaction(async (tx) => {
      const { actor, target } = await this.lockAndLoad(
        tx,
        tenant,
        membershipId,
        'member:change-role',
      );

      if (target.id === actor.id) {
        throw new ForbiddenError('You cannot change your own role.');
      }
      if (actor.role !== 'OWNER') {
        // Admins manage members; ownership is the owners' to give and take.
        if (target.role === 'OWNER') {
          throw new ForbiddenError(CANNOT_TOUCH_OWNER);
        }
        if (newRole === 'OWNER') {
          throw new ForbiddenError('Only an owner can grant ownership.');
        }
      }
      if (target.role === newRole) return; // already there: nothing to do

      await tx.membership.update({
        where: { id: target.id },
        data: { role: newRole },
      });
      await this.assertHasOwner(tx, tenant.organizationId);
    });

    const updated = (await this.list(tenant)).find(
      (m) => m.id === membershipId,
    );
    if (!updated) throw new NotFoundError('Member not found.');
    return updated;
  }

  async remove(tenant: RequestTenant, membershipId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { actor, target } = await this.lockAndLoad(
        tx,
        tenant,
        membershipId,
        'member:remove',
      );
      if (target.id === actor.id) {
        throw new ConflictError('Use "leave" to remove yourself.');
      }
      if (actor.role !== 'OWNER' && target.role === 'OWNER') {
        throw new ForbiddenError(CANNOT_TOUCH_OWNER);
      }
      // Their assigned tasks stay, unassigned (the foreign key sets assigneeId to null).
      await tx.membership.delete({ where: { id: target.id } });
      await this.assertHasOwner(tx, tenant.organizationId);
    });
  }

  /** The caller leaves. The only owner cannot: someone must be left in charge. */
  async leave(tenant: RequestTenant): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockOrganization(tx, tenant.organizationId);
      const me = await tx.membership.findFirst({
        where: {
          id: tenant.membershipId,
          organizationId: tenant.organizationId,
        },
      });
      if (!me) throw new NotFoundError('Organization not found.');

      if (me.role === 'OWNER') {
        const otherOwners = await tx.membership.count({
          where: {
            organizationId: tenant.organizationId,
            role: 'OWNER',
            id: { not: me.id },
          },
        });
        if (otherOwners === 0) {
          throw new ConflictError(
            'You are the only owner. Make someone else an owner first, or delete the organisation.',
          );
        }
      }
      await tx.membership.delete({ where: { id: me.id } });
    });
  }

  // ───────────────────────────── internals ─────────────────────────────

  private async lockOrganization(
    tx: Tx,
    organizationId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId}::uuid FOR UPDATE`;
  }

  /**
   * Locks the organisation, then re-reads BOTH people under the lock. The role the guard
   * saw a few milliseconds ago may already be stale (someone else demoted the caller);
   * decisions are made on what is true now.
   */
  private async lockAndLoad(
    tx: Tx,
    tenant: RequestTenant,
    membershipId: string,
    permission: Permission,
  ) {
    await this.lockOrganization(tx, tenant.organizationId);
    const actor = await tx.membership.findFirst({
      where: { id: tenant.membershipId, organizationId: tenant.organizationId },
    });
    // The caller was removed an instant ago: from their point of view, the org is gone.
    if (!actor) throw new NotFoundError('Organization not found.');
    // The guard checked the role it saw earlier. If the caller was demoted since, the
    // permission must be re-checked against the role they hold NOW.
    if (!can(actor.role, permission)) {
      throw new ForbiddenError('You do not have permission to do this.');
    }

    // Scoped by organisation: another org's membership id is simply "not found".
    const target = await tx.membership.findFirst({
      where: { id: membershipId, organizationId: tenant.organizationId },
    });
    if (!target) throw new NotFoundError('Member not found.');
    return { actor, target };
  }

  /** Last line of defence for the invariant: throwing here rolls the whole change back. */
  private async assertHasOwner(tx: Tx, organizationId: string): Promise<void> {
    const owners = await tx.membership.count({
      where: { organizationId, role: 'OWNER' },
    });
    if (owners === 0) {
      throw new ConflictError('An organisation must always have an owner.');
    }
  }
}
