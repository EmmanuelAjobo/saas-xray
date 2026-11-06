import { Injectable } from '@nestjs/common';
import {
  ConflictError,
  EmailNotVerifiedError,
  ForbiddenError,
  InvalidStateTransitionError,
  InvalidTokenError,
  NotFoundError,
  UnauthenticatedError,
} from '../../common/errors/domain-errors.js';
import { INVITATION_LIST_MAX } from '../../common/limits.js';
import { DAY_MS, formatDuration } from '../../common/time.js';
import { BackgroundTasks } from '../../core/background/background-tasks.service.js';
import { AppConfigService } from '../../core/config/config.service.js';
import type {
  RequestAuth,
  RequestTenant,
} from '../../core/context/request-context.service.js';
import { MailService } from '../../core/mail/mail.service.js';
import { inviteTemplate } from '../../core/mail/templates.js';
import { PrismaService } from '../../core/prisma/prisma.service.js';
import type {
  Invitation,
  InvitationStatus,
  Role,
} from '../../generated/prisma/client.js';
import { TokenService, hashToken } from '../auth/token.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/** One message for every way a token can be wrong, so none can be told apart. */
const INVALID_INVITATION =
  'This invitation is invalid, has expired, or was sent to a different email address.';

export interface InvitationView {
  id: string;
  email: string;
  role: Role;
  status: InvitationStatus;
  expiresAt: Date;
  createdAt: Date;
}

/** A pending invitation past its expiry is EXPIRED, whether or not a job has marked it yet. */
function view(invitation: Invitation, now: Date): InvitationView {
  const expired =
    invitation.status === 'PENDING' && invitation.expiresAt <= now;
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: expired ? 'EXPIRED' : invitation.status,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
  };
}

/**
 * Inviting people to an organisation (ARCHITECTURE §8.4).
 *
 * Tokens are shown once (in the email) and stored only as hashes. Acceptance is an atomic
 * claim, so a link used twice at once works exactly once. Every change that affects seats
 * runs under a lock on the organisation row, so concurrent invitations cannot overshoot the
 * plan's seat limit.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly entitlements: EntitlementsService,
    private readonly mail: MailService,
    private readonly background: BackgroundTasks,
    private readonly config: AppConfigService,
  ) {}

  // ───────────────────────────── sending ─────────────────────────────

  async create(
    auth: RequestAuth,
    tenant: RequestTenant,
    input: { email: string; role: Role },
  ): Promise<InvitationView> {
    const inviter = await this.requireVerifiedInviter(auth);
    const token = this.tokens.generateOpaqueToken();
    const now = new Date();

    const { invitation, organizationName } = await this.prisma.$transaction(
      async (tx) => {
        const org = await this.lockOrganization(tx, tenant.organizationId);

        const alreadyMember = await tx.membership.findFirst({
          where: {
            organizationId: tenant.organizationId,
            user: { email: input.email },
          },
          select: { id: true },
        });
        if (alreadyMember) {
          throw new ConflictError('This person is already a member.');
        }

        // Invitations past their expiry still hold the "one pending per email" slot until
        // marked; release it so the person can be invited again.
        await tx.invitation.updateMany({
          where: {
            organizationId: tenant.organizationId,
            email: input.email,
            status: 'PENDING',
            expiresAt: { lte: now },
          },
          data: { status: 'EXPIRED' },
        });
        const pending = await tx.invitation.findFirst({
          where: {
            organizationId: tenant.organizationId,
            email: input.email,
            status: 'PENDING',
          },
          select: { id: true },
        });
        if (pending) {
          throw new ConflictError(
            'There is already a pending invitation for this email.',
          );
        }

        await this.entitlements.assertSeatAvailable(
          tx,
          tenant.organizationId,
          now,
        );

        const invitation = await tx.invitation.create({
          data: {
            organizationId: tenant.organizationId,
            email: input.email,
            role: input.role,
            tokenHash: hashToken(token),
            expiresAt: this.expiryFrom(now),
            invitedById: auth.userId,
          },
        });
        return { invitation, organizationName: org.name };
      },
    );

    this.sendEmail(inviter.name, organizationName, invitation, token);
    return view(invitation, now);
  }

  async list(tenant: RequestTenant): Promise<InvitationView[]> {
    const now = new Date();
    const rows = await this.prisma.invitation.findMany({
      where: { organizationId: tenant.organizationId },
      orderBy: { createdAt: 'desc' },
      take: INVITATION_LIST_MAX,
    });
    return rows.map((row) => view(row, now));
  }

  /** New link, new expiry. The old link stops working. */
  async resend(
    auth: RequestAuth,
    tenant: RequestTenant,
    invitationId: string,
  ): Promise<InvitationView> {
    const inviter = await this.requireVerifiedInviter(auth);
    const token = this.tokens.generateOpaqueToken();
    const now = new Date();

    const { invitation, organizationName } = await this.prisma.$transaction(
      async (tx) => {
        const org = await this.lockOrganization(tx, tenant.organizationId);
        const current = await tx.invitation.findFirst({
          where: { id: invitationId, organizationId: tenant.organizationId },
        });
        if (!current) throw new NotFoundError('Invitation not found.');
        if (current.status === 'ACCEPTED' || current.status === 'REVOKED') {
          throw new InvalidStateTransitionError(
            'Only pending or expired invitations can be re-sent.',
          );
        }

        const wasHoldingSeat =
          current.status === 'PENDING' && current.expiresAt > now;
        if (!wasHoldingSeat) {
          // Bringing an expired invitation back needs a seat again, and the email must not
          // already have another live invitation.
          const other = await tx.invitation.findFirst({
            where: {
              organizationId: tenant.organizationId,
              email: current.email,
              status: 'PENDING',
              expiresAt: { gt: now },
              id: { not: current.id },
            },
            select: { id: true },
          });
          if (other) {
            throw new ConflictError(
              'There is already a pending invitation for this email.',
            );
          }
          const member = await tx.membership.findFirst({
            where: {
              organizationId: tenant.organizationId,
              user: { email: current.email },
            },
            select: { id: true },
          });
          if (member)
            throw new ConflictError('This person is already a member.');
          await this.entitlements.assertSeatAvailable(
            tx,
            tenant.organizationId,
            now,
          );
        }

        const invitation = await tx.invitation.update({
          where: { id: current.id },
          data: {
            tokenHash: hashToken(token),
            status: 'PENDING',
            expiresAt: this.expiryFrom(now),
            invitedById: auth.userId,
          },
        });
        return { invitation, organizationName: org.name };
      },
    );

    this.sendEmail(inviter.name, organizationName, invitation, token);
    return view(invitation, now);
  }

  /** Cancels an invitation; its link stops working. Repeating it is harmless. */
  async revoke(tenant: RequestTenant, invitationId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockOrganization(tx, tenant.organizationId);
      const current = await tx.invitation.findFirst({
        where: { id: invitationId, organizationId: tenant.organizationId },
      });
      if (!current) throw new NotFoundError('Invitation not found.');
      if (current.status === 'ACCEPTED') {
        throw new InvalidStateTransitionError(
          'This invitation was already accepted. Remove the member instead.',
        );
      }
      if (current.status === 'REVOKED') return;
      await tx.invitation.update({
        where: { id: current.id },
        data: { status: 'REVOKED' },
      });
    });
  }

  // ───────────────────────────── receiving ─────────────────────────────

  /** What a link is for, before logging in (so sign-up can pre-fill the email). */
  async preview(token: string) {
    const invitation = await this.findLive(this.prisma, token);
    if (!invitation) throw new InvalidTokenError(INVALID_INVITATION);
    const org = await this.prisma.organization.findUnique({
      where: { id: invitation.organizationId },
      select: { name: true },
    });
    if (!org) throw new InvalidTokenError(INVALID_INVITATION);
    return {
      organizationName: org.name,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    };
  }

  /** The logged-in user joins. Their account's email must be the invited one. */
  async accept(auth: RequestAuth, token: string) {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: auth.userId },
        select: { id: true, email: true },
      });
      if (!user) throw new UnauthenticatedError('Authentication required.');

      const invitation = await this.findLive(tx, token);
      if (!invitation || invitation.email !== user.email) {
        throw new InvalidTokenError(INVALID_INVITATION);
      }

      // The atomic claim: of two simultaneous accepts, exactly one gets count 1.
      const claimed = await tx.invitation.updateMany({
        where: { id: invitation.id, status: 'PENDING' },
        data: { status: 'ACCEPTED' },
      });
      if (claimed.count !== 1) throw new InvalidTokenError(INVALID_INVITATION);

      const existing = await tx.membership.findUnique({
        where: {
          userId_organizationId: {
            userId: user.id,
            organizationId: invitation.organizationId,
          },
        },
        select: { id: true },
      });
      // Throwing rolls the claim back, so the invitation is not wasted.
      if (existing) {
        throw new ConflictError(
          'You are already a member of this organisation.',
        );
      }

      const membership = await tx.membership.create({
        data: {
          userId: user.id,
          organizationId: invitation.organizationId,
          role: invitation.role,
        },
        include: {
          organization: { select: { id: true, name: true, slug: true } },
        },
      });
      return {
        organizationId: membership.organization.id,
        name: membership.organization.name,
        slug: membership.organization.slug,
        role: membership.role,
      };
    });
  }

  // ───────────────────────────── internals ─────────────────────────────

  private expiryFrom(now: Date): Date {
    return new Date(
      now.getTime() + this.config.get('INVITATION_TTL_DAYS') * DAY_MS,
    );
  }

  /** A PENDING, unexpired invitation for this token, or undefined. */
  private findLive(db: Pick<PrismaService, 'invitation'>, token: string) {
    return db.invitation
      .findUnique({ where: { tokenHash: hashToken(token) } })
      .then((row) =>
        row && row.status === 'PENDING' && row.expiresAt > new Date()
          ? row
          : undefined,
      );
  }

  /**
   * Locks the organisation row and returns it. Seat counting and the one-pending-per-email
   * rule are "read, then write" checks; the lock makes them safe against concurrent requests.
   */
  private async lockOrganization(tx: Tx, organizationId: string) {
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId}::uuid FOR UPDATE`;
    const org = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    });
    if (!org) throw new NotFoundError('Organization not found.');
    return org;
  }

  /** Demo accounts cannot send mail, and unverified accounts cannot invite (decision D4). */
  private async requireVerifiedInviter(auth: RequestAuth) {
    if (auth.isDemo) {
      throw new ForbiddenError('Demo accounts cannot send invitations.');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: auth.userId },
      select: { name: true, emailVerifiedAt: true },
    });
    if (!user) throw new UnauthenticatedError('Authentication required.');
    if (!user.emailVerifiedAt) {
      throw new EmailNotVerifiedError(
        'Verify your email address before inviting people.',
      );
    }
    return user;
  }

  private sendEmail(
    inviterName: string,
    organizationName: string,
    invitation: Invitation,
    token: string,
  ): void {
    const url = `${this.config.get('WEB_ORIGIN')}/invite/accept?token=${encodeURIComponent(token)}`;
    const ttlMs = this.config.get('INVITATION_TTL_DAYS') * DAY_MS;
    this.background.run('invitation-email', () =>
      this.mail.send({
        to: invitation.email,
        ...inviteTemplate({
          inviterName,
          organizationName,
          role: invitation.role,
          url,
          expiresIn: formatDuration(ttlMs),
        }),
      }),
    );
  }
}
