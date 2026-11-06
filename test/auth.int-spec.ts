import { createHash } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SignJWT } from 'jose';
import request from 'supertest';
import { PrismaService } from '../src/core/prisma/prisma.service.js';
import type { BackgroundTasks } from '../src/core/background/background-tasks.service.js';
import { createOrg, resetDb } from './support/db.js';
import { createTestApp } from './support/create-test-app.js';
import type { FakeMailTransport } from './support/fake-mail.js';

const PASSWORD = 'correct horse battery';
const WEB_ORIGIN = 'http://localhost:3001';
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** The whole auth system over real HTTP, against real Postgres. Only mail and Redis are fakes. */
describe('authentication (HTTP + real Postgres)', () => {
  let app: NestExpressApplication;
  let db: PrismaService;
  let mail: FakeMailTransport;
  let background: BackgroundTasks;

  // Each call gets its own client IP (via X-Forwarded-For) so the rate limiter, which is
  // per IP, never leaks between tests.
  let nextIp = 1;
  const freshIp = () => `10.0.${Math.floor(nextIp / 250)}.${nextIp++ % 250}`;

  interface CallOptions {
    ip?: string;
    cookie?: string;
    bearer?: string;
    origin?: string;
  }
  function call(
    method: 'get' | 'post',
    path: string,
    body?: object,
    options: CallOptions = {},
  ) {
    let req = request(app.getHttpServer())
      [method](path)
      .set('X-Forwarded-For', options.ip ?? freshIp());
    if (options.cookie) req = req.set('Cookie', options.cookie);
    if (options.bearer)
      req = req.set('Authorization', `Bearer ${options.bearer}`);
    if (options.origin) req = req.set('Origin', options.origin);
    return body ? req.send(body) : req;
  }

  /** `refresh_token=...` as a browser would send it back. */
  function cookieFrom(res: request.Response): string {
    const header = res.headers['set-cookie'] as unknown as string[] | undefined;
    const line = header?.find((c) => c.startsWith('refresh_token='));
    if (!line) throw new Error('response did not set the refresh cookie');
    return line.split(';')[0] as string;
  }

  async function register(email = 'ada@example.com', options?: CallOptions) {
    const res = await call(
      'post',
      '/v1/auth/register',
      { email, password: PASSWORD, name: 'Ada' },
      options,
    ).expect(201);
    await background.drain();
    return {
      res,
      email,
      accessToken: res.body.accessToken as string,
      cookie: cookieFrom(res),
    };
  }

  beforeAll(async () => {
    ({ app, mail, background } = await createTestApp({
      realDatabase: true,
      env: { TRUST_PROXY_HOPS: '1' },
    }));
    db = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(db);
    mail.clear();
    mail.failWith = undefined;
  });

  describe('registration', () => {
    it('creates the account, signs the user in, and keeps the refresh token out of the body', async () => {
      const { res } = await register('Ada@Example.com ');

      expect(res.body).toMatchObject({
        expiresIn: 900,
        user: {
          email: 'ada@example.com',
          name: 'Ada',
          emailVerified: false,
          isDemo: false,
        },
      });
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(JSON.stringify(res.body)).not.toContain('refresh');
      expect(res.body.user).not.toHaveProperty('passwordHash');
    });

    it('sets the refresh cookie HttpOnly, SameSite=Lax and scoped to /v1/auth', async () => {
      const { res } = await register();
      const cookie = (res.headers['set-cookie'] as unknown as string[]).find(
        (c) => c.startsWith('refresh_token='),
      ) as string;
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toMatch(/Path=\/v1\/auth(;|$)/);
      expect(cookie).toMatch(/Expires=/i);
    });

    it('stores an argon2id hash, never the password, and only a hash of the refresh token', async () => {
      const { cookie } = await register();
      const user = await db.user.findUniqueOrThrow({
        where: { email: 'ada@example.com' },
      });
      expect(user.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(user.passwordHash).not.toContain(PASSWORD);

      const raw = cookie.split('=')[1] as string;
      const row = await db.refreshToken.findFirstOrThrow({
        where: { userId: user.id },
      });
      expect(row.tokenHash).toBe(sha256(raw));
      expect(row.tokenHash).not.toBe(raw);
    });

    it('emails a verification link, and the link token is stored only as a hash', async () => {
      await register();
      expect(mail.to('ada@example.com')).toHaveLength(1);
      const token = mail.lastToken('ada@example.com');
      const stored = await db.authToken.findFirstOrThrow({
        where: { type: 'EMAIL_VERIFY' },
      });
      expect(stored.tokenHash).toBe(sha256(token));
      expect(mail.to('ada@example.com')[0]?.text).toContain(
        `${WEB_ORIGIN}/verify-email?token=`,
      );
    });

    it('rejects a duplicate email with 409, ignoring case', async () => {
      await register('ada@example.com');
      const res = await call('post', '/v1/auth/register', {
        email: 'ADA@example.com',
        password: PASSWORD,
        name: 'Other',
      }).expect(409);
      expect(res.body.code).toBe('CONFLICT');
      expect(await db.user.count()).toBe(1);
    });

    it('lets exactly one of two simultaneous sign-ups for the same email win', async () => {
      const body = { email: 'race@example.com', password: PASSWORD, name: 'R' };
      const results = await Promise.all([
        call('post', '/v1/auth/register', body),
        call('post', '/v1/auth/register', body),
      ]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        201, 409,
      ]);
      expect(await db.user.count()).toBe(1);
    });

    it.each([
      ['a short password', { password: 'short' }],
      ['an invalid email', { email: 'nope' }],
      ['an empty name', { name: '   ' }],
      ['a 10 MB password', { password: 'x'.repeat(10_000) }],
    ])('rejects %s with a 400 and creates nothing', async (_label, patch) => {
      const res = await call('post', '/v1/auth/register', {
        email: 'ada@example.com',
        password: PASSWORD,
        name: 'Ada',
        ...patch,
      }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(await db.user.count()).toBe(0);
    });

    it('refuses fields a client must never set (mass assignment)', async () => {
      const res = await call('post', '/v1/auth/register', {
        email: 'ada@example.com',
        password: PASSWORD,
        name: 'Ada',
        emailVerifiedAt: new Date().toISOString(),
        isDemo: true,
        id: '00000000-0000-0000-0000-000000000000',
      }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(await db.user.count()).toBe(0);
    });

    it('still succeeds when the mail provider is down', async () => {
      mail.failWith = new Error('SMTP connection refused');
      const { res } = await register();
      expect(res.status).toBe(201);
      expect(await db.user.count()).toBe(1);
    });
  });

  describe('login', () => {
    it('logs in with the right password, before the email is verified', async () => {
      await register();
      const res = await call('post', '/v1/auth/login', {
        email: 'ada@example.com',
        password: PASSWORD,
      }).expect(200);
      expect(res.body.user.emailVerified).toBe(false);
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(cookieFrom(res)).toMatch(/^refresh_token=/);
    });

    it('treats the email case-insensitively', async () => {
      await register();
      await call('post', '/v1/auth/login', {
        email: 'ADA@EXAMPLE.COM',
        password: PASSWORD,
      }).expect(200);
    });

    it('gives the identical answer for a wrong password and an unknown email', async () => {
      await register();
      const wrongPassword = await call('post', '/v1/auth/login', {
        email: 'ada@example.com',
        password: 'definitely wrong',
      }).expect(401);
      const unknownEmail = await call('post', '/v1/auth/login', {
        email: 'nobody@example.com',
        password: 'definitely wrong',
      }).expect(401);

      const strip = ({ requestId: _id, ...rest }: Record<string, unknown>) =>
        rest;
      expect(strip(unknownEmail.body)).toEqual(strip(wrongPassword.body));
      expect(wrongPassword.body.detail).toBe('Invalid email or password.');
      expect(wrongPassword.headers['set-cookie']).toBeUndefined();
    });

    it('cannot log in to an account that has no password (demo / Google-only)', async () => {
      await db.user.create({
        data: { email: 'demo@example.com', name: 'Demo', isDemo: true },
      });
      await call('post', '/v1/auth/login', {
        email: 'demo@example.com',
        password: PASSWORD,
      }).expect(401);
    });

    it('rate-limits to 5 attempts a minute per IP + email, without locking out other emails', async () => {
      await register();
      const ip = freshIp();
      const attempt = (email: string) =>
        call(
          'post',
          '/v1/auth/login',
          { email, password: 'wrong password' },
          { ip },
        );
      for (let i = 0; i < 5; i++) await attempt('ada@example.com').expect(401);

      const blocked = await attempt('ada@example.com').expect(429);
      expect(blocked.body.code).toBe('TOO_MANY_REQUESTS');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

      // The same IP trying a different account is a different bucket.
      await attempt('someone-else@example.com').expect(401);
    });

    it('does not let the limit on one IP block the same account from another IP', async () => {
      await register();
      const attacker = freshIp();
      for (let i = 0; i < 6; i++) {
        await call(
          'post',
          '/v1/auth/login',
          { email: 'ada@example.com', password: 'nope nope nope' },
          { ip: attacker },
        );
      }
      await call('post', '/v1/auth/login', {
        email: 'ada@example.com',
        password: PASSWORD,
      }).expect(200);
    });
  });

  describe('access tokens and protected routes', () => {
    it('rejects requests with no token, garbage, or the wrong scheme', async () => {
      await call('get', '/v1/auth/me').expect(401);
      await call('get', '/v1/auth/me', undefined, { bearer: 'garbage' }).expect(
        401,
      );
      await request(app.getHttpServer())
        .get('/v1/auth/me')
        .set('Authorization', 'Basic abc')
        .expect(401);
    });

    it('returns the user and their organisations from /me', async () => {
      const { accessToken } = await register();
      const user = await db.user.findUniqueOrThrow({
        where: { email: 'ada@example.com' },
      });
      const org = await createOrg(db, 'acme');
      await db.membership.create({
        data: { userId: user.id, organizationId: org.id, role: 'ADMIN' },
      });

      const res = await call('get', '/v1/auth/me', undefined, {
        bearer: accessToken,
      }).expect(200);
      expect(res.body).toMatchObject({
        id: user.id,
        email: 'ada@example.com',
        memberships: [{ organizationId: org.id, slug: 'acme', role: 'ADMIN' }],
      });
    });

    it('rejects a token signed with a different secret', async () => {
      const { accessToken } = await register();
      const [, payload] = accessToken.split('.');
      const forged = await new SignJWT(
        JSON.parse(Buffer.from(payload as string, 'base64url').toString()),
      )
        .setProtectedHeader({ alg: 'HS256' })
        .sign(
          new TextEncoder().encode('an-attacker-secret-of-32-characters!!'),
        );
      await call('get', '/v1/auth/me', undefined, { bearer: forged }).expect(
        401,
      );
    });

    it('rejects an "alg: none" token (unsigned)', async () => {
      const { accessToken } = await register();
      const [, payload] = accessToken.split('.');
      const header = Buffer.from('{"alg":"none","typ":"JWT"}').toString(
        'base64url',
      );
      await call('get', '/v1/auth/me', undefined, {
        bearer: `${header}.${payload}.`,
      }).expect(401);
    });

    it('rejects a tampered payload and an expired token', async () => {
      const { accessToken } = await register();
      const [h, , s] = accessToken.split('.');
      const evil = Buffer.from(
        JSON.stringify({ sub: 'someone-else', sid: 'x', isDemo: false }),
      ).toString('base64url');
      await call('get', '/v1/auth/me', undefined, {
        bearer: `${h}.${evil}.${s}`,
      }).expect(401);

      const user = await db.user.findUniqueOrThrow({
        where: { email: 'ada@example.com' },
      });
      const expired = await new SignJWT({ sid: 'x', isDemo: false })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(user.id)
        .setIssuer('saas-xray')
        .setAudience('saas-xray-api')
        .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
        .sign(new TextEncoder().encode(process.env.JWT_ACCESS_SECRET));
      await call('get', '/v1/auth/me', undefined, { bearer: expired }).expect(
        401,
      );
    });

    it('answers 401 for a valid token whose user no longer exists', async () => {
      const { accessToken } = await register();
      await db.user.deleteMany();
      await call('get', '/v1/auth/me', undefined, {
        bearer: accessToken,
      }).expect(401);
    });

    it('answers every auth failure with problem+json and a request id', async () => {
      const res = await call('get', '/v1/auth/me').expect(401);
      expect(res.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      expect(res.body).toMatchObject({
        status: 401,
        code: 'UNAUTHENTICATED',
        requestId: expect.any(String),
      });
    });
  });

  describe('refresh-token rotation', () => {
    it('issues a new access token and a different refresh token, and retires the old one', async () => {
      const { cookie } = await register();
      const res = await call('post', '/v1/auth/refresh', undefined, {
        cookie,
      }).expect(200);
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(cookieFrom(res)).not.toBe(cookie);

      const rows = await db.refreshToken.findMany({
        orderBy: { createdAt: 'asc' },
      });
      expect(rows).toHaveLength(2);
      expect(rows[0]?.revokedAt).not.toBeNull();
      expect(rows[0]?.replacedById).toBe(rows[1]?.id);
      expect(rows[1]?.revokedAt).toBeNull();
      expect(rows[0]?.familyId).toBe(rows[1]?.familyId);
    });

    it('the new access token works', async () => {
      const { cookie } = await register();
      const res = await call('post', '/v1/auth/refresh', undefined, {
        cookie,
      }).expect(200);
      await call('get', '/v1/auth/me', undefined, {
        bearer: res.body.accessToken,
      }).expect(200);
    });

    it('detects reuse of a retired token and revokes the whole session', async () => {
      const { cookie: first } = await register();
      const second = cookieFrom(
        await call('post', '/v1/auth/refresh', undefined, {
          cookie: first,
        }).expect(200),
      );

      // An attacker (or a stale tab) replays the FIRST token.
      const replay = await call('post', '/v1/auth/refresh', undefined, {
        cookie: first,
      }).expect(401);
      expect(replay.body.code).toBe('UNAUTHENTICATED');

      // The legitimate user's newest token is now dead too: the family was revoked.
      await call('post', '/v1/auth/refresh', undefined, {
        cookie: second,
      }).expect(401);
      expect(await db.refreshToken.count({ where: { revokedAt: null } })).toBe(
        0,
      );
    });

    it('only revokes the compromised session, not the same user’s other devices', async () => {
      await register();
      const phone = cookieFrom(
        await call('post', '/v1/auth/login', {
          email: 'ada@example.com',
          password: PASSWORD,
        }).expect(200),
      );
      const laptop = cookieFrom(
        await call('post', '/v1/auth/login', {
          email: 'ada@example.com',
          password: PASSWORD,
        }).expect(200),
      );

      await call('post', '/v1/auth/refresh', undefined, { cookie: phone });
      await call('post', '/v1/auth/refresh', undefined, {
        cookie: phone,
      }).expect(401); // replay on the phone's family

      await call('post', '/v1/auth/refresh', undefined, {
        cookie: laptop,
      }).expect(200);
    });

    it('lets exactly one of two simultaneous refreshes with the same token succeed', async () => {
      const { cookie } = await register();
      const results = await Promise.all([
        call('post', '/v1/auth/refresh', undefined, { cookie }),
        call('post', '/v1/auth/refresh', undefined, { cookie }),
      ]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 401,
      ]);
    });

    it('rejects a missing, malformed or unknown cookie, and clears it', async () => {
      const none = await call('post', '/v1/auth/refresh').expect(401);
      expect(String(none.headers['set-cookie'])).toMatch(/refresh_token=;/);
      await call('post', '/v1/auth/refresh', undefined, {
        cookie: 'refresh_token=not-a-real-token',
      }).expect(401);
    });

    it('rejects an expired refresh token', async () => {
      const { cookie } = await register();
      await db.refreshToken.updateMany({
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await call('post', '/v1/auth/refresh', undefined, { cookie }).expect(401);
    });

    it('enforces the absolute session limit even if the user keeps refreshing', async () => {
      const { cookie } = await register();
      await db.refreshToken.updateMany({
        data: { createdAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) },
      });
      await call('post', '/v1/auth/refresh', undefined, { cookie }).expect(401);
    });

    it('never extends a session past the absolute limit', async () => {
      const { cookie } = await register();
      // Session started 29 days ago: only ~1 day of the 30-day cap remains.
      await db.refreshToken.updateMany({
        data: { createdAt: new Date(Date.now() - 29 * 24 * 3600 * 1000) },
      });
      await call('post', '/v1/auth/refresh', undefined, { cookie }).expect(200);
      const newest = await db.refreshToken.findFirstOrThrow({
        where: { revokedAt: null },
      });
      const daysLeft = (newest.expiresAt.getTime() - Date.now()) / 86_400_000;
      expect(daysLeft).toBeLessThan(1.1); // not the full 7-day sliding window
    });

    it('refuses a refresh that comes from another website', async () => {
      const { cookie } = await register();
      const res = await call('post', '/v1/auth/refresh', undefined, {
        cookie,
        origin: 'https://evil.example',
      }).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
      // And it did not burn the token: the real site can still use it.
      await call('post', '/v1/auth/refresh', undefined, {
        cookie,
        origin: WEB_ORIGIN,
      }).expect(200);
    });
  });

  describe('logout', () => {
    it('ends the session: the refresh token stops working and the cookie is cleared', async () => {
      const { cookie } = await register();
      const res = await call('post', '/v1/auth/logout', undefined, {
        cookie,
      }).expect(204);
      expect(String(res.headers['set-cookie'])).toMatch(/refresh_token=;/);
      await call('post', '/v1/auth/refresh', undefined, { cookie }).expect(401);
    });

    it('is harmless without a session, and refuses cross-origin requests', async () => {
      await call('post', '/v1/auth/logout').expect(204);
      await call('post', '/v1/auth/logout', undefined, {
        origin: 'https://evil.example',
      }).expect(403);
    });

    it('logout-all signs out every device', async () => {
      const first = await register();
      const second = cookieFrom(
        await call('post', '/v1/auth/login', {
          email: 'ada@example.com',
          password: PASSWORD,
        }).expect(200),
      );
      await call('post', '/v1/auth/logout-all', undefined, {
        bearer: first.accessToken,
      }).expect(204);
      await call('post', '/v1/auth/refresh', undefined, {
        cookie: first.cookie,
      }).expect(401);
      await call('post', '/v1/auth/refresh', undefined, {
        cookie: second,
      }).expect(401);
    });

    it('logout-all needs authentication', async () => {
      await call('post', '/v1/auth/logout-all').expect(401);
    });

    it('logout-all leaves other users’ sessions alone', async () => {
      const ada = await register('ada@example.com');
      const bob = await register('bob@example.com');
      await call('post', '/v1/auth/logout-all', undefined, {
        bearer: ada.accessToken,
      }).expect(204);
      await call('post', '/v1/auth/refresh', undefined, {
        cookie: bob.cookie,
      }).expect(200);
    });
  });

  describe('email verification', () => {
    it('verifies once, then the link is dead', async () => {
      const { accessToken } = await register();
      const token = mail.lastToken('ada@example.com');

      await call('post', '/v1/auth/verify-email', { token }).expect(204);
      const me = await call('get', '/v1/auth/me', undefined, {
        bearer: accessToken,
      }).expect(200);
      expect(me.body.emailVerified).toBe(true);

      const again = await call('post', '/v1/auth/verify-email', {
        token,
      }).expect(400);
      expect(again.body.code).toBe('INVALID_TOKEN');
    });

    it('rejects unknown, expired and wrong-type tokens identically', async () => {
      await register();
      const real = mail.lastToken('ada@example.com');

      const unknown = await call('post', '/v1/auth/verify-email', {
        token: 'x'.repeat(43),
      }).expect(400);

      await db.authToken.updateMany({
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await call('post', '/v1/auth/verify-email', {
        token: real,
      }).expect(400);

      await db.authToken.updateMany({
        data: { type: 'PASSWORD_RESET', expiresAt: new Date(Date.now() + 1e6) },
      });
      const wrongType = await call('post', '/v1/auth/verify-email', {
        token: real,
      }).expect(400);

      const strip = ({ requestId: _id, ...rest }: Record<string, unknown>) =>
        rest;
      expect(strip(expired.body)).toEqual(strip(unknown.body));
      expect(strip(wrongType.body)).toEqual(strip(unknown.body));
      const user = await db.user.findUniqueOrThrow({
        where: { email: 'ada@example.com' },
      });
      expect(user.emailVerifiedAt).toBeNull();
    });

    it('lets exactly one of two simultaneous uses of the link succeed', async () => {
      await register();
      const token = mail.lastToken('ada@example.com');
      const results = await Promise.all([
        call('post', '/v1/auth/verify-email', { token }),
        call('post', '/v1/auth/verify-email', { token }),
      ]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        204, 400,
      ]);
    });

    it('resend sends a fresh link and kills the old one', async () => {
      const { accessToken } = await register();
      const oldToken = mail.lastToken('ada@example.com');

      await call('post', '/v1/auth/resend-verification', undefined, {
        bearer: accessToken,
      }).expect(204);
      await background.drain();
      expect(mail.to('ada@example.com')).toHaveLength(2);
      const newToken = mail.lastToken('ada@example.com');
      expect(newToken).not.toBe(oldToken);

      await call('post', '/v1/auth/verify-email', { token: oldToken }).expect(
        400,
      );
      await call('post', '/v1/auth/verify-email', { token: newToken }).expect(
        204,
      );
    });

    it('resend does nothing once verified, and needs authentication', async () => {
      const { accessToken } = await register();
      await call('post', '/v1/auth/verify-email', {
        token: mail.lastToken('ada@example.com'),
      }).expect(204);
      mail.clear();
      await call('post', '/v1/auth/resend-verification', undefined, {
        bearer: accessToken,
      }).expect(204);
      await background.drain();
      expect(mail.sent).toHaveLength(0);

      await call('post', '/v1/auth/resend-verification').expect(401);
    });
  });

  describe('password reset', () => {
    const forgot = (email: string, options?: CallOptions) =>
      call('post', '/v1/auth/forgot-password', { email }, options);

    it('answers identically for a registered and an unregistered address (no enumeration)', async () => {
      await register();
      const known = await forgot('ada@example.com').expect(202);
      const unknown = await forgot('ghost@example.com').expect(202);
      expect(unknown.body).toEqual(known.body);
      await background.drain();

      expect(mail.to('ada@example.com')).toHaveLength(2); // verification + reset
      expect(mail.to('ghost@example.com')).toHaveLength(0);
    });

    it('resets the password, signs out every session, and kills the link', async () => {
      const { cookie } = await register();
      await forgot('ada@example.com').expect(202);
      await background.drain();
      const token = mail.lastToken('ada@example.com');

      await call('post', '/v1/auth/reset-password', {
        token,
        newPassword: 'a brand new passphrase',
      }).expect(204);

      // Old password and old session are gone; the new password works.
      await call('post', '/v1/auth/login', {
        email: 'ada@example.com',
        password: PASSWORD,
      }).expect(401);
      await call('post', '/v1/auth/login', {
        email: 'ada@example.com',
        password: 'a brand new passphrase',
      }).expect(200);
      await call('post', '/v1/auth/refresh', undefined, { cookie }).expect(401);

      // Single use.
      await call('post', '/v1/auth/reset-password', {
        token,
        newPassword: 'yet another passphrase',
      }).expect(400);
    });

    it('a weak new password is rejected without spending the link', async () => {
      await register();
      await forgot('ada@example.com');
      await background.drain();
      const token = mail.lastToken('ada@example.com');

      await call('post', '/v1/auth/reset-password', {
        token,
        newPassword: 'short',
      }).expect(400);
      await call('post', '/v1/auth/reset-password', {
        token,
        newPassword: 'a long enough passphrase',
      }).expect(204);
    });

    it('a newer reset link invalidates the older one', async () => {
      await register();
      await forgot('ada@example.com');
      await background.drain();
      const older = mail.lastToken('ada@example.com');
      await forgot('ada@example.com');
      await background.drain();
      const newer = mail.lastToken('ada@example.com');
      expect(newer).not.toBe(older);

      await call('post', '/v1/auth/reset-password', {
        token: older,
        newPassword: 'a long enough passphrase',
      }).expect(400);
      await call('post', '/v1/auth/reset-password', {
        token: newer,
        newPassword: 'a long enough passphrase',
      }).expect(204);
    });

    it('rejects an expired link', async () => {
      await register();
      await forgot('ada@example.com');
      await background.drain();
      const token = mail.lastToken('ada@example.com');
      await db.authToken.updateMany({
        where: { type: 'PASSWORD_RESET' },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await call('post', '/v1/auth/reset-password', {
        token,
        newPassword: 'a long enough passphrase',
      }).expect(400);
    });

    it('a verification link cannot be used to reset a password', async () => {
      await register();
      await call('post', '/v1/auth/reset-password', {
        token: mail.lastToken('ada@example.com'),
        newPassword: 'a long enough passphrase',
      }).expect(400);
    });

    it('proves mailbox ownership: a reset also verifies the email', async () => {
      await register();
      await forgot('ada@example.com');
      await background.drain();
      await call('post', '/v1/auth/reset-password', {
        token: mail.lastToken('ada@example.com'),
        newPassword: 'a long enough passphrase',
      }).expect(204);
      const user = await db.user.findUniqueOrThrow({
        where: { email: 'ada@example.com' },
      });
      expect(user.emailVerifiedAt).not.toBeNull();
    });

    it('still answers 202 when the mail provider is down', async () => {
      await register();
      mail.failWith = new Error('SMTP connection refused');
      await forgot('ada@example.com').expect(202);
      await background.drain();
    });

    it('rate-limits forgot-password per IP + email', async () => {
      const ip = freshIp();
      for (let i = 0; i < 5; i++)
        await forgot('ada@example.com', { ip }).expect(202);
      await forgot('ada@example.com', { ip }).expect(429);
    });
  });
});
