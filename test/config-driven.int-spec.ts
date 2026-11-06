import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { PrismaService } from '../src/core/prisma/prisma.service.js';
import type { BackgroundTasks } from '../src/core/background/background-tasks.service.js';
import { createTestApp } from './support/create-test-app.js';
import { createAuthedUser, createHttpClient } from './support/http-client.js';
import { resetDb } from './support/db.js';
import type { FakeMailTransport } from './support/fake-mail.js';

/**
 * Proves the tunables are really read from the environment, not baked into the code:
 * boot the real app with different values and observe the behaviour change.
 */
describe('settings come from the environment', () => {
  let app: NestExpressApplication;
  let db: PrismaService;
  let mail: FakeMailTransport;
  let background: BackgroundTasks;

  beforeAll(async () => {
    ({ app, mail, background } = await createTestApp({
      realDatabase: true,
      env: {
        TRUST_PROXY_HOPS: '1',
        RATE_LIMIT_CREDENTIALS_PER_MINUTE: '2',
        RATE_LIMIT_REGISTER_PER_HOUR: '3',
        EMAIL_VERIFY_TTL_HOURS: '48',
        PASSWORD_RESET_TTL_MINUTES: '30',
        PASSWORD_HASH_MEMORY_KIB: '8192',
        PASSWORD_HASH_PASSES: '1',
        ACCESS_TOKEN_TTL_SECONDS: '120',
        CORS_MAX_AGE_SECONDS: '77',
        MAX_ORGS_PER_USER: '2',
        RATE_LIMIT_ORG_CREATE_PER_HOUR: '3',
        INVITATION_TTL_DAYS: '2',
        FREE_PLAN_MAX_SEATS: '2',
        RATE_LIMIT_INVITE_PER_HOUR: '3',
        PAGE_SIZE_DEFAULT: '2',
        PAGE_SIZE_MAX: '3',
        INVOICE_DEFAULT_CURRENCY: 'EUR',
        INVOICE_DEFAULT_TERMS_DAYS: '3',
        INVOICE_MAX_LINE_ITEMS: '2',
      },
    }));
    db = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(db);
    mail.clear();
  });

  const post = (path: string, body: object, ip: string) =>
    request(app.getHttpServer())
      .post(path)
      .set('X-Forwarded-For', ip)
      .send(body);

  it('login attempts are limited to RATE_LIMIT_CREDENTIALS_PER_MINUTE (2, not the default 5)', async () => {
    const attempt = () =>
      post(
        '/v1/auth/login',
        { email: 'a@example.com', password: 'whatever' },
        '10.9.0.1',
      );
    await attempt().expect(401);
    await attempt().expect(401);
    await attempt().expect(429);
  });

  it('forgot-password shares the same configured limit', async () => {
    const attempt = () =>
      post('/v1/auth/forgot-password', { email: 'a@example.com' }, '10.9.0.2');
    await attempt().expect(202);
    await attempt().expect(202);
    await attempt().expect(429);
  });

  it('registrations are limited to RATE_LIMIT_REGISTER_PER_HOUR (3)', async () => {
    const register = (n: number) =>
      post(
        '/v1/auth/register',
        {
          email: `u${n}@example.com`,
          password: 'a long passphrase',
          name: 'U',
        },
        '10.9.0.3',
      );
    for (let n = 0; n < 3; n++) await register(n).expect(201);
    await register(3).expect(429);
  });

  it('the verification link lifetime and the text of the email follow EMAIL_VERIFY_TTL_HOURS', async () => {
    await post(
      '/v1/auth/register',
      { email: 'ttl@example.com', password: 'a long passphrase', name: 'T' },
      '10.9.0.4',
    ).expect(201);
    await background.drain();

    expect(mail.to('ttl@example.com')[0]?.text).toContain('expires in 2 days');
    const row = await db.authToken.findFirstOrThrow({
      where: { type: 'EMAIL_VERIFY' },
    });
    const hours = (row.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47.9);
    expect(hours).toBeLessThanOrEqual(48);
  });

  it('the reset link lifetime and email text follow PASSWORD_RESET_TTL_MINUTES', async () => {
    await post(
      '/v1/auth/register',
      { email: 'reset@example.com', password: 'a long passphrase', name: 'R' },
      '10.9.0.5',
    ).expect(201);
    await post(
      '/v1/auth/forgot-password',
      { email: 'reset@example.com' },
      '10.9.0.5',
    );
    await background.drain();

    const resetMail = mail.to('reset@example.com').at(-1);
    expect(resetMail?.text).toContain('expires in 30 minutes');
    const row = await db.authToken.findFirstOrThrow({
      where: { type: 'PASSWORD_RESET' },
    });
    const minutes = (row.expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(29.9);
    expect(minutes).toBeLessThanOrEqual(30);
  });

  it('the password hash records the configured cost, and still verifies', async () => {
    await post(
      '/v1/auth/register',
      { email: 'cost@example.com', password: 'a long passphrase', name: 'C' },
      '10.9.0.6',
    ).expect(201);
    const user = await db.user.findUniqueOrThrow({
      where: { email: 'cost@example.com' },
    });
    expect(user.passwordHash).toMatch(/^\$argon2id\$v=19\$m=8192,t=1,p=1\$/);
    await post(
      '/v1/auth/login',
      { email: 'cost@example.com', password: 'a long passphrase' },
      '10.9.0.7',
    ).expect(200);
  });

  it('the access token lifetime follows ACCESS_TOKEN_TTL_SECONDS', async () => {
    const res = await post(
      '/v1/auth/register',
      { email: 'jwt@example.com', password: 'a long passphrase', name: 'J' },
      '10.9.0.8',
    ).expect(201);
    expect(res.body.expiresIn).toBe(120);
    const payload = JSON.parse(
      Buffer.from(res.body.accessToken.split('.')[1], 'base64url').toString(),
    ) as { exp: number; iat: number };
    expect(payload.exp - payload.iat).toBe(120);
  });

  it('the CORS preflight cache time follows CORS_MAX_AGE_SECONDS', async () => {
    const res = await request(app.getHttpServer())
      .options('/v1/auth/login')
      .set('Origin', 'http://localhost:3001')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-max-age']).toBe('77');
  });

  it('MAX_ORGS_PER_USER (2, not the default 5) caps ownership, even for simultaneous requests', async () => {
    const owner = await createAuthedUser(app, db, 'quota@example.com');
    const client = createHttpClient(app);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_unused, n) =>
        client.call('post', '/v1/orgs', {
          bearer: owner.token,
          body: { name: `Race ${n}` },
        }),
      ),
    );
    const statuses = results.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([201, 201, 403, 403, 403]);
    expect(results.find((r) => r.status === 403)?.body.code).toBe(
      'LIMIT_REACHED',
    );
    expect(
      await db.membership.count({ where: { userId: owner.id, role: 'OWNER' } }),
    ).toBe(2);
  });

  it('RATE_LIMIT_ORG_CREATE_PER_HOUR (3) limits creation per IP across different people', async () => {
    const client = createHttpClient(app);
    const ip = '10.77.0.1';
    for (let n = 0; n < 3; n++) {
      const user = await createAuthedUser(app, db, `rl${n}@example.com`);
      await client
        .call('post', '/v1/orgs', {
          bearer: user.token,
          body: { name: 'X' },
          ip,
        })
        .expect(201);
    }
    const fourth = await createAuthedUser(app, db, 'rl3@example.com');
    const res = await client
      .call('post', '/v1/orgs', {
        bearer: fourth.token,
        body: { name: 'X' },
        ip,
      })
      .expect(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('FREE_PLAN_MAX_SEATS (2, not the default 3), INVITATION_TTL_DAYS (2) and the invitation email follow the environment', async () => {
    const client = createHttpClient(app);
    const owner = await createAuthedUser(app, db, 'seats-owner@example.com');
    const created = await client
      .call('post', '/v1/orgs', {
        bearer: owner.token,
        body: { name: 'Seats' },
      })
      .expect(201);
    const orgId = created.body.id as string;
    const invite = (email: string) =>
      client.call('post', `/v1/orgs/${orgId}/invitations`, {
        bearer: owner.token,
        body: { email, role: 'MEMBER' },
      });

    const first = await invite('first@example.com').expect(201); // owner + 1 pending = 2 seats
    await background.drain();
    expect(mail.to('first@example.com')[0]?.text).toContain(
      'expires in 2 days',
    );
    const days =
      (new Date(first.body.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(1.9);
    expect(days).toBeLessThanOrEqual(2);

    const full = await invite('second@example.com').expect(402);
    expect(full.body.detail).toContain('allows 2 seats');
  });

  it('RATE_LIMIT_INVITE_PER_HOUR (3) limits sending invitations per IP', async () => {
    const client = createHttpClient(app);
    const owner = await createAuthedUser(app, db, 'rl-owner@example.com');
    const org = await db.organization.create({
      data: {
        name: 'Big',
        slug: 'big-rl',
        subscription: { create: { plan: 'PRO' } },
        memberships: { create: { userId: owner.id, role: 'OWNER' } },
      },
    });
    const ip = '10.88.0.1';
    const invite = (n: number) =>
      client.call('post', `/v1/orgs/${org.id}/invitations`, {
        bearer: owner.token,
        body: { email: `rl${n}@example.com`, role: 'MEMBER' },
        ip,
      });
    for (let n = 0; n < 3; n++) await invite(n).expect(201);
    const res = await invite(3).expect(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('PAGE_SIZE_DEFAULT (2) and PAGE_SIZE_MAX (3) shape every list', async () => {
    const client = createHttpClient(app);
    const owner = await createAuthedUser(app, db, 'pages@example.com');
    const org = await db.organization.create({
      data: {
        name: 'Pages',
        slug: 'pages-org',
        subscription: { create: {} },
        memberships: { create: { userId: owner.id, role: 'OWNER' } },
      },
    });
    await db.client.createMany({
      data: Array.from({ length: 6 }, (_u, i) => ({
        organizationId: org.id,
        name: `Client ${i}`,
        email: `p${i}@x.example`,
      })),
    });
    const list = (query: string) =>
      client
        .call('get', `/v1/orgs/${org.id}/clients${query}`, {
          bearer: owner.token,
        })
        .expect(200);

    expect((await list('')).body.data).toHaveLength(2); // default
    expect((await list('?limit=1')).body.data).toHaveLength(1);
    expect((await list('?limit=1000')).body.data).toHaveLength(3); // clamped to the maximum
  });

  it('INVOICE_DEFAULT_CURRENCY (EUR), INVOICE_DEFAULT_TERMS_DAYS (3) and INVOICE_MAX_LINE_ITEMS (2) shape invoices', async () => {
    const client = createHttpClient(app);
    const owner = await createAuthedUser(app, db, 'inv-config@example.com');
    const org = await db.organization.create({
      data: {
        name: 'Inv',
        slug: 'inv-config',
        subscription: { create: {} },
        memberships: { create: { userId: owner.id, role: 'OWNER' } },
      },
    });
    const customer = await db.client.create({
      data: { organizationId: org.id, name: 'C', email: 'c@x.example' },
    });
    const item = { description: 'x', quantity: 1, unitPriceCents: 100 };
    const post = (body: object) =>
      client.call('post', `/v1/orgs/${org.id}/invoices`, {
        bearer: owner.token,
        body,
      });

    const created = await post({ clientId: customer.id, items: [item] }).expect(
      201,
    );
    expect(created.body.currency).toBe('EUR');

    const sent = await client
      .call('post', `/v1/orgs/${org.id}/invoices/${created.body.id}/send`, {
        bearer: owner.token,
      })
      .expect(200);
    const days =
      (new Date(sent.body.dueDate).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(2.9);
    expect(days).toBeLessThanOrEqual(3);

    await post({ clientId: customer.id, items: [item, item] }).expect(201);
    const tooMany = await post({
      clientId: customer.id,
      items: [item, item, item],
    }).expect(400);
    expect(tooMany.body.errors[0].message).toContain('at most 2');
  });
});
