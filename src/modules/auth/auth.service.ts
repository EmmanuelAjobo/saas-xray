import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  ConflictError,
  InvalidTokenError,
  UnauthenticatedError,
} from '../../common/errors/domain-errors.js';
import { MAX_IP_LENGTH, MAX_USER_AGENT_LENGTH } from '../../common/limits.js';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  formatDuration,
} from '../../common/time.js';
import { AppConfigService } from '../../core/config/config.service.js';
import { BackgroundTasks } from '../../core/background/background-tasks.service.js';
import { MailService } from '../../core/mail/mail.service.js';
import {
  resetPasswordTemplate,
  verifyEmailTemplate,
} from '../../core/mail/templates.js';
import { PrismaService } from '../../core/prisma/prisma.service.js';
import type { AuthTokenType, User } from '../../generated/prisma/client.js';
import { PasswordService } from './password.service.js';
import { TokenService, hashToken } from './token.service.js';

/** Where a request came from; stored with each session so users can recognise their devices. */
export interface ClientMeta {
  ip?: string;
  userAgent?: string;
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  /** Goes into the HttpOnly cookie; never in the response body. */
  refreshToken: string;
  refreshExpiresAt: Date;
  user: PublicUser;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  isDemo: boolean;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerifiedAt !== null,
    isDemo: user.isDemo,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    private readonly background: BackgroundTasks,
    private readonly config: AppConfigService,
  ) {}

  // ───────────────────────────── registration & login ─────────────────────────────

  async register(
    input: { email: string; password: string; name: string },
    meta: ClientMeta,
  ): Promise<Session> {
    const passwordHash = await this.passwords.hash(input.password);
    let user: User;
    try {
      user = await this.prisma.user.create({
        data: { email: input.email, name: input.name, passwordHash },
      });
    } catch (error) {
      // The unique index is the source of truth, so two simultaneous sign-ups for the same
      // email cannot both succeed (a "check then insert" would race).
      if (isUniqueViolation(error)) {
        throw new ConflictError('An account with this email already exists.');
      }
      throw error;
    }
    this.sendVerificationEmail(user);
    return this.startSession(user, meta);
  }

  async login(
    input: { email: string; password: string },
    meta: ClientMeta,
  ): Promise<Session> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
    });
    // Same message and same CPU cost whether the email is unknown, the account has no
    // password (Google-only / demo), or the password is wrong.
    const ok = user?.passwordHash
      ? await this.passwords.verify(input.password, user.passwordHash)
      : await this.passwords.verifyAgainstDummy(input.password);
    if (!user || !ok) {
      throw new UnauthenticatedError('Invalid email or password.');
    }
    return this.startSession(user, meta);
  }

  // ───────────────────────────── sessions (refresh tokens) ─────────────────────────────

  /**
   * Signs in an existing user without a password: for flows that have already established
   * who they are by other means (the demo sandbox). Never expose this to a request that
   * names an arbitrary user.
   */
  async startSessionFor(userId: string, meta: ClientMeta): Promise<Session> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthenticatedError('Authentication required.');
    return this.startSession(user, meta);
  }

  /** Ends one session (a refresh-token family), e.g. when a demo visitor switches persona. */
  async revokeSession(sessionId: string): Promise<void> {
    await this.revokeFamily(sessionId);
  }

  /** Starts a brand-new session: a new refresh-token family. */
  private async startSession(user: User, meta: ClientMeta): Promise<Session> {
    const now = Date.now();
    const maxAgeEnd =
      now + this.config.get('REFRESH_TOKEN_MAX_AGE_DAYS') * DAY_MS;
    const { session } = await this.issue(
      this.prisma,
      user,
      randomUUID(),
      maxAgeEnd,
      meta,
      now,
    );
    return session;
  }

  private async issue(
    db: Pick<PrismaService, 'refreshToken'>,
    user: User,
    familyId: string,
    maxAgeEnd: number,
    meta: ClientMeta,
    now: number,
  ): Promise<{ session: Session; tokenId: string }> {
    const refreshToken = this.tokens.generateOpaqueToken();
    // Sliding: each refresh pushes expiry out, but never past the absolute limit.
    const expiresAt = new Date(
      Math.min(
        now + this.config.get('REFRESH_TOKEN_TTL_DAYS') * DAY_MS,
        maxAgeEnd,
      ),
    );
    const row = await db.refreshToken.create({
      data: {
        userId: user.id,
        familyId,
        tokenHash: hashToken(refreshToken),
        expiresAt,
        ip: meta.ip?.slice(0, MAX_IP_LENGTH),
        userAgent: meta.userAgent?.slice(0, MAX_USER_AGENT_LENGTH),
      },
    });
    const accessToken = await this.tokens.signAccessToken({
      userId: user.id,
      sessionId: familyId,
      isDemo: user.isDemo,
    });
    return {
      tokenId: row.id,
      session: {
        accessToken,
        expiresIn: this.tokens.accessTokenTtlSeconds,
        refreshToken,
        refreshExpiresAt: expiresAt,
        user: toPublicUser(user),
      },
    };
  }

  /**
   * Rotation with reuse detection (OAuth 2.0 Security BCP): every refresh retires the token
   * presented and issues a new one in the same family. Presenting a token that was already
   * retired means a copy exists somewhere it should not, so the WHOLE family is revoked and
   * the user must log in again.
   */
  async refresh(rawToken: string, meta: ClientMeta): Promise<Session> {
    const now = new Date();
    const outcome = await this.prisma.$transaction(async (tx) => {
      const current = await tx.refreshToken.findUnique({
        where: { tokenHash: hashToken(rawToken) },
        include: { user: true },
      });
      if (!current) return { kind: 'unknown' as const };

      // `updateMany ... where revokedAt is null` is an atomic claim: of two simultaneous
      // refreshes with the same token, exactly one wins; the loser looks like a replay.
      const claimed = await tx.refreshToken.updateMany({
        where: { id: current.id, revokedAt: null },
        data: { revokedAt: now },
      });
      if (claimed.count === 0) {
        return { kind: 'reused' as const, current };
      }
      if (current.expiresAt <= now) return { kind: 'expired' as const };

      const first = await tx.refreshToken.findFirstOrThrow({
        where: { familyId: current.familyId },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      });
      const maxAgeEnd =
        first.createdAt.getTime() +
        this.config.get('REFRESH_TOKEN_MAX_AGE_DAYS') * DAY_MS;
      if (now.getTime() >= maxAgeEnd) return { kind: 'expired' as const };

      const next = await this.issue(
        tx,
        current.user,
        current.familyId,
        maxAgeEnd,
        meta,
        now.getTime(),
      );
      await tx.refreshToken.update({
        where: { id: current.id },
        data: { replacedById: next.tokenId },
      });
      return { kind: 'ok' as const, session: next.session };
    });

    switch (outcome.kind) {
      case 'ok':
        return outcome.session;
      case 'reused':
        // Outside the transaction on purpose: the revocation must persist even though we
        // are about to reject this request.
        await this.revokeFamily(outcome.current.familyId);
        this.logger.warn(
          `Refresh token reuse detected; session revoked (user ${outcome.current.userId}, family ${outcome.current.familyId})`,
        );
        throw new UnauthenticatedError('Session is no longer valid.');
      default:
        throw new UnauthenticatedError('Session is no longer valid.');
    }
  }

  /** Ends the session the cookie belongs to. Silent if the token is unknown (idempotent). */
  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(rawToken) },
      select: { familyId: true },
    });
    if (row) await this.revokeFamily(row.familyId);
  }

  async logoutAll(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // ───────────────────────────── email verification ─────────────────────────────

  async verifyEmail(rawToken: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const userId = await this.consumeToken(tx, 'EMAIL_VERIFY', rawToken);
      await tx.user.updateMany({
        where: { id: userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: new Date() },
      });
    });
  }

  async resendVerification(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthenticatedError('Authentication required.');
    if (user.emailVerifiedAt) return; // already done: nothing to send, nothing to reveal
    this.sendVerificationEmail(user);
  }

  // ───────────────────────────── password reset ─────────────────────────────

  /**
   * Always succeeds from the caller's point of view. The lookup and the email happen in the
   * background, so neither the response body nor its timing reveals whether the address is
   * registered.
   */
  requestPasswordReset(email: string): void {
    this.background.run('password-reset-email', async () => {
      const user = await this.prisma.user.findUnique({ where: { email } });
      // Demo accounts have no real mailbox and no password to reset.
      if (!user || user.isDemo) return;
      const ttlMs = this.config.get('PASSWORD_RESET_TTL_MINUTES') * MINUTE_MS;
      const url = await this.createEmailLink(
        user.id,
        'PASSWORD_RESET',
        ttlMs,
        '/reset-password',
      );
      await this.mail.send({
        to: user.email,
        ...resetPasswordTemplate({
          name: user.name,
          url,
          expiresIn: formatDuration(ttlMs),
        }),
      });
    });
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      const userId = await this.consumeToken(tx, 'PASSWORD_RESET', rawToken);
      const now = new Date();
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash },
      });
      // They just proved they control the mailbox.
      await tx.user.updateMany({
        where: { id: userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });
      // Anyone holding an old session (maybe the reason for the reset) is signed out, and
      // any other outstanding reset links die with this one.
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.authToken.updateMany({
        where: { userId, type: 'PASSWORD_RESET', usedAt: null },
        data: { usedAt: now },
      });
    });
  }

  // ───────────────────────────── profile ─────────────────────────────

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          include: {
            organization: { select: { id: true, name: true, slug: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!user) throw new UnauthenticatedError('Authentication required.');
    return {
      ...toPublicUser(user),
      memberships: user.memberships.map((m) => ({
        organizationId: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        role: m.role,
      })),
    };
  }

  // ───────────────────────────── single-use email tokens ─────────────────────────────

  /** Creates a token, invalidating older unused ones of the same type, and returns the link. */
  private async createEmailLink(
    userId: string,
    type: AuthTokenType,
    ttlMs: number,
    path: string,
  ): Promise<string> {
    const token = this.tokens.generateOpaqueToken();
    await this.prisma.$transaction([
      this.prisma.authToken.updateMany({
        where: { userId, type, usedAt: null },
        data: { usedAt: new Date() },
      }),
      this.prisma.authToken.create({
        data: {
          userId,
          type,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + ttlMs),
        },
      }),
    ]);
    return `${this.config.get('WEB_ORIGIN')}${path}?token=${encodeURIComponent(token)}`;
  }

  /**
   * Marks a token used and returns its user. The conditional update is the atomic claim, so a
   * link opened twice at once works exactly once. Unknown, used and expired tokens are
   * indistinguishable to the caller.
   */
  private async consumeToken(
    tx: Pick<PrismaService, 'authToken'>,
    type: AuthTokenType,
    rawToken: string,
  ): Promise<string> {
    const tokenHash = hashToken(rawToken);
    const now = new Date();
    const claimed = await tx.authToken.updateMany({
      where: { tokenHash, type, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) {
      throw new InvalidTokenError('This link is invalid or has expired.');
    }
    const row = await tx.authToken.findUniqueOrThrow({
      where: { tokenHash },
      select: { userId: true },
    });
    return row.userId;
  }

  private sendVerificationEmail(user: User): void {
    this.background.run('verification-email', async () => {
      const ttlMs = this.config.get('EMAIL_VERIFY_TTL_HOURS') * HOUR_MS;
      const url = await this.createEmailLink(
        user.id,
        'EMAIL_VERIFY',
        ttlMs,
        '/verify-email',
      );
      await this.mail.send({
        to: user.email,
        ...verifyEmailTemplate({
          name: user.name,
          url,
          expiresIn: formatDuration(ttlMs),
        }),
      });
    });
  }
}
