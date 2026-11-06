import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { TokenService } from '../../src/modules/auth/token.service.js';
import type { PrismaClient, Role } from '../../src/generated/prisma/client.js';

type Method = 'get' | 'post' | 'patch' | 'delete';

export interface CallOptions {
  body?: object;
  bearer?: string;
  ip?: string;
}

/**
 * Small HTTP client for integration tests. Every call comes from a fresh client IP (via
 * X-Forwarded-For, so the app under test needs TRUST_PROXY_HOPS=1) so the per-IP rate limiter
 * never leaks between tests.
 */
export function createHttpClient(app: NestExpressApplication) {
  let counter = 1;
  const freshIp = () =>
    `10.2.${Math.floor(counter / 250) % 250}.${counter++ % 250}`;

  const call = (method: Method, path: string, options: CallOptions = {}) => {
    let req = request(app.getHttpServer())
      [method](path)
      .set('X-Forwarded-For', options.ip ?? freshIp());
    if (options.bearer) {
      req = req.set('Authorization', `Bearer ${options.bearer}`);
    }
    return options.body ? req.send(options.body) : req;
  };
  return { call, freshIp };
}

export interface TestUser {
  id: string;
  email: string;
  /** A valid access token, minted directly (skips the slow password hashing). */
  token: string;
}

/**
 * Creates a user row and an access token for it, without going through registration.
 * Verified by default; pass `verified: false` for the unverified case.
 */
export async function createAuthedUser(
  app: NestExpressApplication,
  db: PrismaClient,
  email: string,
  {
    isDemo = false,
    verified = true,
  }: { isDemo?: boolean; verified?: boolean } = {},
): Promise<TestUser> {
  const user = await db.user.create({
    data: {
      email,
      name: email.split('@')[0] as string,
      isDemo,
      emailVerifiedAt: verified ? new Date() : null,
    },
  });
  const token = await app.get(TokenService).signAccessToken({
    userId: user.id,
    sessionId: 'test-session',
    isDemo,
  });
  return { id: user.id, email, token };
}

/** An organisation with the given people already in it, bypassing the API. */
export async function createOrgWith(
  db: PrismaClient,
  slug: string,
  members: Array<{ user: TestUser; role: Role }>,
) {
  const org = await db.organization.create({
    data: {
      name: slug,
      slug,
      subscription: { create: {} },
      memberships: {
        create: members.map((m) => ({ userId: m.user.id, role: m.role })),
      },
    },
    include: { memberships: true },
  });
  const membershipOf = (user: TestUser) => {
    const found = org.memberships.find((m) => m.userId === user.id);
    if (!found) throw new Error(`${user.email} is not in ${slug}`);
    return found.id;
  };
  return { org, id: org.id, membershipOf };
}
