import type { NestExpressApplication } from '@nestjs/platform-express';
import type { BackgroundTasks } from '../src/core/background/background-tasks.service.js';
import { PrismaService } from '../src/core/prisma/prisma.service.js';
import { DemoCleanupService } from '../src/modules/demo/demo-cleanup.service.js';
import { createTestApp } from './support/create-test-app.js';
import { resetDb } from './support/db.js';
import type { FakeMailTransport } from './support/fake-mail.js';
import { createAuthedUser, createHttpClient } from './support/http-client.js';

const HOUR = 3_600_000;
const strip = ({ requestId: _id, ...rest }: Record<string, unknown>) => rest;

/** Opens an app with the given settings, runs `fn`, and always closes it. */
async function withApp<T>(
  env: Record<string, string>,
  fn: (ctx: {
    app: NestExpressApplication;
    db: PrismaService;
    mail: FakeMailTransport;
    background: BackgroundTasks;
    http: ReturnType<typeof createHttpClient>['call'];
  }) => Promise<T>,
): Promise<T> {
  const { app, mail, background } = await createTestApp({
    realDatabase: true,
    env: { TRUST_PROXY_HOPS: '1', ...env },
  });
  const db = app.get(PrismaService);
  await resetDb(db);
  try {
    return await fn({
      app,
      db,
      mail,
      background,
      http: createHttpClient(app).call,
    });
  } finally {
    await app.close();
  }
}

describe('"Try the demo" (HTTP + real Postgres)', () => {
  let app: NestExpressApplication;
  let db: PrismaService;
  let mail: FakeMailTransport;
  let background: BackgroundTasks;
  let http: ReturnType<typeof createHttpClient>['call'];

  beforeAll(async () => {
    ({ app, mail, background } = await createTestApp({
      realDatabase: true,
      env: { TRUST_PROXY_HOPS: '1' },
    }));
    db = app.get(PrismaService);
    http = createHttpClient(app).call;
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(db);
    mail.clear();
    mail.failWith = undefined;
  });

  const startDemo = () => http('post', '/v1/auth/demo', { body: {} });
  const switchRole = (token: string, role: string) =>
    http('post', '/v1/demo/switch-role', { bearer: token, body: { role } });

  describe('starting a sandbox', () => {
    it('signs a stranger in, in one request, to a fully populated private organisation', async () => {
      const res = await startDemo().expect(201);

      expect(res.body).toMatchObject({
        expiresIn: 900,
        role: 'OWNER',
        user: { isDemo: true, emailVerified: true },
        organization: { name: 'Acme Studio (demo)' },
      });
      expect(JSON.stringify(res.body)).not.toContain('refresh');
      expect(res.headers['set-cookie']).toEqual([
        expect.stringMatching(/^refresh_token=.*HttpOnly/i),
      ]);
      const hours =
        (new Date(res.body.expiresAt).getTime() - Date.now()) / HOUR;
      expect(hours).toBeGreaterThan(23.9);
      expect(hours).toBeLessThanOrEqual(24);

      const orgId = res.body.organization.id as string;
      const org = await db.organization.findUniqueOrThrow({
        where: { id: orgId },
        include: { subscription: true },
      });
      expect(org).toMatchObject({ isDemo: true, invoiceSeq: 10 });
      expect(org.subscription).toMatchObject({
        plan: 'FREE',
        status: 'ACTIVE',
      });
      expect(
        await db.membership.count({ where: { organizationId: orgId } }),
      ).toBe(3);
      expect(await db.task.count({ where: { organizationId: orgId } })).toBe(
        25,
      );
      expect(await db.client.count({ where: { organizationId: orgId } })).toBe(
        6,
      );
      expect(await db.invoice.count({ where: { organizationId: orgId } })).toBe(
        10,
      );
    });

    it('the returned token works immediately, and the visitor is the OWNER of the sandbox', async () => {
      const res = await startDemo().expect(201);
      const token = res.body.accessToken as string;
      const orgId = res.body.organization.id as string;

      const me = await http('get', '/v1/auth/me', { bearer: token }).expect(
        200,
      );
      expect(me.body.isDemo).toBe(true);
      expect(me.body.memberships).toEqual([
        expect.objectContaining({ organizationId: orgId, role: 'OWNER' }),
      ]);
      const tasks = await http('get', `/v1/orgs/${orgId}/tasks?limit=100`, {
        bearer: token,
      }).expect(200);
      expect(tasks.body.data).toHaveLength(25);
      const invoices = await http(
        'get',
        `/v1/orgs/${orgId}/invoices?limit=100`,
        { bearer: token },
      ).expect(200);
      expect(invoices.body.data).toHaveLength(10);
    });

    it('works with no body at all (a bare button click)', async () => {
      await http('post', '/v1/auth/demo').expect(201);
    });

    it('gives every visitor their OWN sandbox: separate data, nothing shared', async () => {
      const a = (await startDemo().expect(201)).body;
      const b = (await startDemo().expect(201)).body;
      expect(a.organization.id).not.toBe(b.organization.id);
      expect(a.organization.slug).not.toBe(b.organization.slug);
      expect(a.user.email).not.toBe(b.user.email);

      // A changes things; B sees none of it.
      const mine = await http('post', `/v1/orgs/${a.organization.id}/tasks`, {
        bearer: a.accessToken,
        body: { title: 'Only in sandbox A' },
      }).expect(201);
      const bTasks = await http(
        'get',
        `/v1/orgs/${b.organization.id}/tasks?limit=100`,
        { bearer: b.accessToken },
      ).expect(200);
      expect(bTasks.body.data).toHaveLength(25);
      expect(JSON.stringify(bTasks.body)).not.toContain('Only in sandbox A');

      // And B cannot reach A's sandbox at all.
      await http('get', `/v1/orgs/${a.organization.id}/tasks/${mine.body.id}`, {
        bearer: b.accessToken,
      }).expect(404);
      await http('get', `/v1/orgs/${a.organization.id}`, {
        bearer: b.accessToken,
      }).expect(404);
    });

    it('lets the visitor actually use the product: create, edit, send an invoice', async () => {
      const { accessToken: token, organization } = (
        await startDemo().expect(201)
      ).body;
      const o = `/v1/orgs/${organization.id}`;
      const clients = await http('get', `${o}/clients`, {
        bearer: token,
      }).expect(200);
      const invoice = await http('post', `${o}/invoices`, {
        bearer: token,
        body: {
          clientId: clients.body.data[0].id,
          items: [
            { description: 'Demo work', quantity: 2, unitPriceCents: 5000 },
          ],
        },
      }).expect(201);
      expect(invoice.body.number).toBe('INV-0011'); // the sandbox already holds 10
      await http('post', `${o}/invoices/${invoice.body.id}/send`, {
        bearer: token,
      }).expect(200);
      await http('post', `${o}/clients`, {
        bearer: token,
        body: { name: 'New', email: 'new@demo.example' },
      }).expect(201);
    });
  });

  describe('guardrails (demo accounts are flagged, so every feature can tell)', () => {
    it('sends NO real email from a demo organisation', async () => {
      const { accessToken: token, organization } = (
        await startDemo().expect(201)
      ).body;
      const o = `/v1/orgs/${organization.id}`;
      const draft = (
        await http('get', `${o}/invoices?status=DRAFT`, {
          bearer: token,
        }).expect(200)
      ).body.data[0];
      await http('post', `${o}/invoices/${draft.id}/send`, {
        bearer: token,
      }).expect(200);
      await background.drain();
      expect(mail.sent).toHaveLength(0);
    });

    it('cannot create organisations or invite people', async () => {
      const { accessToken: token, organization } = (
        await startDemo().expect(201)
      ).body;
      const org = await http('post', '/v1/orgs', {
        bearer: token,
        body: { name: 'Mine' },
      }).expect(403);
      expect(org.body.code).toBe('FORBIDDEN');
      await http('post', `/v1/orgs/${organization.id}/invitations`, {
        bearer: token,
        body: { email: 'friend@example.com', role: 'MEMBER' },
      }).expect(403);
      await background.drain();
      expect(mail.sent).toHaveLength(0);
    });

    it('has no password: it cannot be logged into, and "forgot password" sends nothing', async () => {
      const { user } = (await startDemo().expect(201)).body;
      await http('post', '/v1/auth/login', {
        body: { email: user.email, password: 'anything at all' },
      }).expect(401);
      await http('post', '/v1/auth/forgot-password', {
        body: { email: user.email },
      }).expect(202);
      await background.drain();
      expect(mail.sent).toHaveLength(0);
    });

    it('can end its own session', async () => {
      const res = await startDemo().expect(201);
      const cookie = (
        res.headers['set-cookie'] as unknown as string[]
      )[0]!.split(';')[0]!;
      await http('post', '/v1/auth/refresh', {})
        .set('Cookie', cookie)
        .expect(200);
    });
  });

  describe('switching role (feel what each role can do)', () => {
    it('moves between the owner, admin and member of the SAME sandbox, with real permissions each time', async () => {
      const start = (await startDemo().expect(201)).body;
      const o = `/v1/orgs/${start.organization.id}`;
      const newClient = (token: string, n: number) =>
        http('post', `${o}/clients`, {
          bearer: token,
          body: { name: `C${n}`, email: `c${n}@x.example` },
        });

      await newClient(start.accessToken, 1).expect(201); // owner may

      const asMember = (
        await switchRole(start.accessToken, 'MEMBER').expect(200)
      ).body;
      expect(asMember).toMatchObject({
        role: 'MEMBER',
        organization: { id: start.organization.id },
      });
      expect(asMember.user.id).not.toBe(start.user.id);
      await newClient(asMember.accessToken, 2).expect(403); // members cannot
      await http('get', `${o}/tasks`, { bearer: asMember.accessToken }).expect(
        200,
      ); // but can read

      const asAdmin = (
        await switchRole(asMember.accessToken, 'ADMIN').expect(200)
      ).body;
      expect(asAdmin.role).toBe('ADMIN');
      await newClient(asAdmin.accessToken, 3).expect(201);
      await http('delete', o, { bearer: asAdmin.accessToken }).expect(403); // only owners delete the org

      const backToOwner = (
        await switchRole(asAdmin.accessToken, 'OWNER').expect(200)
      ).body;
      expect(backToOwner.user.id).toBe(start.user.id);
      await http('get', '/v1/auth/me', {
        bearer: backToOwner.accessToken,
      }).expect(200);
    });

    it('sets a fresh cookie and ends the previous persona’s session', async () => {
      const start = await startDemo().expect(201);
      const oldCookie = (
        start.headers['set-cookie'] as unknown as string[]
      )[0]!.split(';')[0]!;
      const res = await switchRole(start.body.accessToken, 'MEMBER').expect(
        200,
      );
      expect(res.headers['set-cookie']).toEqual([
        expect.stringMatching(/^refresh_token=/),
      ]);
      await http('post', '/v1/auth/refresh', {})
        .set('Cookie', oldCookie)
        .expect(401);
    });

    it('never leaves the visitor’s own sandbox, whichever sandbox or role (not merely the oldest one)', async () => {
      const visitors = [];
      for (let i = 0; i < 3; i++)
        visitors.push((await startDemo().expect(201)).body);

      // Newest visitor first, so a switch that picked "any sandbox" would land in the oldest.
      for (const visitor of [...visitors].reverse()) {
        for (const role of ['MEMBER', 'ADMIN', 'OWNER'] as const) {
          const switched = (
            await switchRole(visitor.accessToken, role).expect(200)
          ).body;
          expect(
            switched.organization.id,
            `${role} for ${visitor.organization.slug}`,
          ).toBe(visitor.organization.id);
          const me = await http('get', '/v1/auth/me', {
            bearer: switched.accessToken,
          }).expect(200);
          expect(
            me.body.memberships.map(
              (m: { organizationId: string }) => m.organizationId,
            ),
          ).toEqual([visitor.organization.id]);
          // Never the others' sandboxes.
          for (const other of visitors.filter((v) => v !== visitor)) {
            await http('get', `/v1/orgs/${other.organization.id}`, {
              bearer: switched.accessToken,
            }).expect(404);
          }
          // Keep using the freshest token for the next switch of this visitor.
          visitor.accessToken = switched.accessToken;
        }
      }
    });

    it('is refused for ordinary (non-demo) accounts', async () => {
      const real = await createAuthedUser(app, db, 'real@example.com');
      const res = await switchRole(real.token, 'OWNER').expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('needs authentication and a valid role', async () => {
      await http('post', '/v1/demo/switch-role', {
        body: { role: 'OWNER' },
      }).expect(401);
      const { accessToken } = (await startDemo().expect(201)).body;
      await switchRole(accessToken, 'SUPERUSER').expect(400);
      await http('post', '/v1/demo/switch-role', {
        bearer: accessToken,
        body: {},
      }).expect(400);
      await http('post', '/v1/demo/switch-role', {
        bearer: accessToken,
        body: { role: 'OWNER', userId: 'x' },
      }).expect(400);
    });
  });

  describe('rate limit', () => {
    it('allows 10 starts an hour per IP, then 429 with Retry-After; another IP is unaffected', async () => {
      const ip = '10.55.0.1';
      for (let i = 0; i < 10; i++) {
        await http('post', '/v1/auth/demo', { body: {}, ip }).expect(201);
      }
      const blocked = await http('post', '/v1/auth/demo', {
        body: {},
        ip,
      }).expect(429);
      expect(blocked.body.code).toBe('TOO_MANY_REQUESTS');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      await http('post', '/v1/auth/demo', { body: {}, ip: '10.55.0.2' }).expect(
        201,
      );
    });
  });

  describe('expiry and cleanup', () => {
    const cleanup = () => app.get(DemoCleanupService);
    const dataIn = async (orgId: string) => ({
      org: await db.organization.count({ where: { id: orgId } }),
      members: await db.membership.count({ where: { organizationId: orgId } }),
      tasks: await db.task.count({ where: { organizationId: orgId } }),
      clients: await db.client.count({ where: { organizationId: orgId } }),
      invoices: await db.invoice.count({ where: { organizationId: orgId } }),
      lines: await db.invoiceLineItem.count({
        where: { invoice: { organizationId: orgId } },
      }),
    });

    it('deletes expired sandboxes with everything in them and their demo users, and spares live ones', async () => {
      const dead1 = (await startDemo().expect(201)).body;
      const dead2 = (await startDemo().expect(201)).body;
      const alive = (await startDemo().expect(201)).body;
      await db.organization.updateMany({
        where: { id: { in: [dead1.organization.id, dead2.organization.id] } },
        data: { demoExpiresAt: new Date(Date.now() - 1000) },
      });
      const usersBefore = await db.user.count();

      const result = await cleanup().purgeExpired();
      expect(result).toEqual({ organizations: 2, users: 0 });

      for (const gone of [dead1, dead2]) {
        expect(await dataIn(gone.organization.id)).toEqual({
          org: 0,
          members: 0,
          tasks: 0,
          clients: 0,
          invoices: 0,
          lines: 0,
        });
      }
      expect(await dataIn(alive.organization.id)).toEqual({
        org: 1,
        members: 3,
        tasks: 25,
        clients: 6,
        invoices: 10,
        lines: 14,
      });
      expect(await db.user.count()).toBe(usersBefore - 6); // 3 demo people per dead sandbox
      // The survivor still works.
      await http('get', `/v1/orgs/${alive.organization.id}/tasks`, {
        bearer: alive.accessToken,
      }).expect(200);
    });

    it('an expired visitor is locked out at once: their still-valid token no longer opens anything', async () => {
      const visitor = (await startDemo().expect(201)).body;
      await db.organization.update({
        where: { id: visitor.organization.id },
        data: { demoExpiresAt: new Date(Date.now() - 1000) },
      });
      await cleanup().purgeExpired();
      await http('get', '/v1/auth/me', { bearer: visitor.accessToken }).expect(
        401,
      );
      await http('get', `/v1/orgs/${visitor.organization.id}/tasks`, {
        bearer: visitor.accessToken,
      }).expect(404);
    });

    it('never touches ordinary organisations or users, whatever their dates say', async () => {
      const real = await createAuthedUser(app, db, 'real@example.com');
      const org = await db.organization.create({
        data: {
          name: 'Real Co',
          slug: 'real-co',
          demoExpiresAt: new Date(Date.now() - HOUR), // nonsense value on a non-demo org
          memberships: { create: { userId: real.id, role: 'OWNER' } },
        },
      });
      const loner = await createAuthedUser(app, db, 'loner@example.com'); // no organisation
      await db.user.updateMany({
        data: { createdAt: new Date(Date.now() - 48 * HOUR) },
      });

      const result = await cleanup().purgeExpired();
      expect(result).toEqual({ organizations: 0, users: 0 });
      expect(await db.organization.count({ where: { id: org.id } })).toBe(1);
      expect(
        await db.user.count({ where: { id: { in: [real.id, loner.id] } } }),
      ).toBe(2);
    });

    it('never deletes the permanent sample organisation made by `npm run db:seed`', async () => {
      const { seedDemoOrganization } =
        await import('../src/seed/demo-template.js');
      const sample = await seedDemoOrganization(db, { ttlHours: 1 }); // tag "template"
      await db.organization.update({
        where: { id: sample.organizationId },
        data: { demoExpiresAt: new Date(Date.now() - HOUR) },
      });
      expect(await cleanup().purgeExpired()).toEqual({
        organizations: 0,
        users: 0,
      });
      expect(
        await db.organization.count({ where: { id: sample.organizationId } }),
      ).toBe(1);
    });

    it('sweeps up demo users left behind when a visitor deleted their own sandbox, but only old ones', async () => {
      const visitor = (await startDemo().expect(201)).body;
      await http('delete', `/v1/orgs/${visitor.organization.id}`, {
        bearer: visitor.accessToken,
      }).expect(204);
      expect(await db.user.count({ where: { isDemo: true } })).toBe(3); // orphaned, but fresh

      expect(await cleanup().purgeExpired()).toEqual({
        organizations: 0,
        users: 0,
      }); // too new
      expect(await db.user.count({ where: { isDemo: true } })).toBe(3);

      await db.user.updateMany({
        where: { isDemo: true },
        data: { createdAt: new Date(Date.now() - 25 * HOUR) },
      });
      expect(await cleanup().purgeExpired()).toEqual({
        organizations: 0,
        users: 3,
      });
      expect(await db.user.count({ where: { isDemo: true } })).toBe(0);
    });

    it('can be run again and again, and concurrently, without harm', async () => {
      const dead = (await startDemo().expect(201)).body;
      await db.organization.update({
        where: { id: dead.organization.id },
        data: { demoExpiresAt: new Date(Date.now() - 1000) },
      });
      const runs = await Promise.all([
        cleanup().purgeExpired(),
        cleanup().purgeExpired(),
        cleanup().purgeExpired(),
      ]);
      expect(
        runs.reduce((n, r) => n + r.organizations, 0),
      ).toBeGreaterThanOrEqual(1);
      expect(await db.organization.count()).toBe(0);
      expect(await cleanup().purgeExpired()).toEqual({
        organizations: 0,
        users: 0,
      });
    });
  });

  it('is not consulted at all when no secret is configured (local development)', async () => {
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: false }),
      });
    });
    try {
      await startDemo().expect(201);
      expect(calls).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('error answers carry no internals', async () => {
    const res = await http('post', '/v1/auth/demo', {
      body: { unexpected: true },
    }).expect(400);
    expect(strip(res.body)).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

// Each group below owns ONE app at a time: nestjs-cls keeps plugin state in a module-level
// singleton, so closing one app instance would break another that is still alive in the
// same process. (Production runs one app per process.)
describe('settings come from the environment', () => {
  it('DEMO_ENABLED=false switches the button off: it looks like the route does not exist', async () => {
    await withApp({ DEMO_ENABLED: 'false' }, async ({ http, app }) => {
      const res = await http('post', '/v1/auth/demo', { body: {} }).expect(404);
      expect(res.body.code).toBe('NOT_FOUND');
      const real = await createAuthedUser(
        app,
        app.get(PrismaService),
        'x@example.com',
        { isDemo: true },
      );
      await http('post', '/v1/demo/switch-role', {
        bearer: real.token,
        body: { role: 'OWNER' },
      }).expect(404);
      expect(await app.get(PrismaService).organization.count()).toBe(0);
    });
  });

  it('DEMO_MAX_ACTIVE caps live sandboxes (503 with a friendly message), and frees up as they expire', async () => {
    await withApp({ DEMO_MAX_ACTIVE: '2' }, async ({ http, db }) => {
      const first = (
        await http('post', '/v1/auth/demo', { body: {} }).expect(201)
      ).body;
      await http('post', '/v1/auth/demo', { body: {} }).expect(201);
      const busy = await http('post', '/v1/auth/demo', { body: {} }).expect(
        503,
      );
      expect(busy.body).toMatchObject({
        status: 503,
        code: 'TEMPORARILY_UNAVAILABLE',
      });
      expect(busy.body.detail).toMatch(/very busy/);
      expect(await db.organization.count()).toBe(2); // nothing half-created

      await db.organization.update({
        where: { id: first.organization.id },
        data: { demoExpiresAt: new Date(Date.now() - 1000) },
      });
      await http('post', '/v1/auth/demo', { body: {} }).expect(201);
    });
  });

  it('DEMO_TTL_HOURS sets how long a sandbox lives', async () => {
    await withApp({ DEMO_TTL_HOURS: '2' }, async ({ http }) => {
      const res = await http('post', '/v1/auth/demo', { body: {} }).expect(201);
      const hours =
        (new Date(res.body.expiresAt).getTime() - Date.now()) / HOUR;
      expect(hours).toBeGreaterThan(1.9);
      expect(hours).toBeLessThanOrEqual(2);
    });
  });

  it('RATE_LIMIT_DEMO_PER_HOUR is configurable', async () => {
    await withApp({ RATE_LIMIT_DEMO_PER_HOUR: '2' }, async ({ http }) => {
      const ip = '10.66.0.1';
      await http('post', '/v1/auth/demo', { body: {}, ip }).expect(201);
      await http('post', '/v1/auth/demo', { body: {}, ip }).expect(201);
      await http('post', '/v1/auth/demo', { body: {}, ip }).expect(429);
    });
  });

  it('DEMO_PURGE_BATCH_SIZE limits one purge run; the rest wait for the next', async () => {
    await withApp({ DEMO_PURGE_BATCH_SIZE: '2' }, async ({ http, db, app }) => {
      for (let i = 0; i < 5; i++)
        await http('post', '/v1/auth/demo', { body: {} }).expect(201);
      await db.organization.updateMany({
        data: { demoExpiresAt: new Date(Date.now() - 1000) },
      });
      const cleanup = app.get(DemoCleanupService);
      expect((await cleanup.purgeExpired()).organizations).toBe(2);
      expect((await cleanup.purgeExpired()).organizations).toBe(2);
      expect((await cleanup.purgeExpired()).organizations).toBe(1);
      expect(await db.organization.count()).toBe(0);
    });
  });
});

describe('bot protection (Cloudflare Turnstile)', () => {
  const SECRET = 'turnstile-test-secret';
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubTurnstile = (answer: () => Promise<unknown>) => {
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    vi.stubGlobal('fetch', (url: string, init: { body: URLSearchParams }) => {
      calls.push({ url, body: init.body });
      return answer();
    });
    return calls;
  };
  const ok = (success: boolean) => () =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ success }) });

  it('with a secret configured, requires a valid challenge token', async () => {
    await withApp({ TURNSTILE_SECRET_KEY: SECRET }, async ({ http, db }) => {
      const calls = stubTurnstile(ok(true));

      await http('post', '/v1/auth/demo', { body: {} }).expect(403); // no token at all
      expect(calls).toHaveLength(0); // never even asked Cloudflare
      expect(await db.organization.count()).toBe(0);

      await http('post', '/v1/auth/demo', {
        body: { turnstileToken: 'good-token' },
      }).expect(201);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      );
      expect(calls[0]?.body.get('secret')).toBe(SECRET);
      expect(calls[0]?.body.get('response')).toBe('good-token');
    });
  });

  it('refuses a token Cloudflare rejects, without creating anything', async () => {
    await withApp({ TURNSTILE_SECRET_KEY: SECRET }, async ({ http, db }) => {
      stubTurnstile(ok(false));
      const res = await http('post', '/v1/auth/demo', {
        body: { turnstileToken: 'bad' },
      }).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect(await db.organization.count()).toBe(0);
      expect(await db.user.count()).toBe(0);
    });
  });

  it('FAILS CLOSED: if Cloudflare is unreachable or misbehaves, nobody gets a sandbox', async () => {
    await withApp({ TURNSTILE_SECRET_KEY: SECRET }, async ({ http, db }) => {
      stubTurnstile(() => Promise.reject(new Error('network down')));
      await http('post', '/v1/auth/demo', {
        body: { turnstileToken: 't' },
      }).expect(403);
      stubTurnstile(() =>
        Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
      );
      await http('post', '/v1/auth/demo', {
        body: { turnstileToken: 't' },
      }).expect(403);
      stubTurnstile(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: 'yes' }),
        }),
      );
      await http('post', '/v1/auth/demo', {
        body: { turnstileToken: 't' },
      }).expect(403); // only literal true passes
      expect(await db.organization.count()).toBe(0);
    });
  });

  it('rejects an oversized token before doing any work', async () => {
    await withApp({ TURNSTILE_SECRET_KEY: SECRET }, async ({ http }) => {
      const calls = stubTurnstile(ok(true));
      await http('post', '/v1/auth/demo', {
        body: { turnstileToken: 'x'.repeat(5_000) },
      }).expect(400);
      expect(calls).toHaveLength(0);
    });
  });
});
