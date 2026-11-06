import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../src/core/prisma/prisma.service.js';
import { createTestApp } from './support/create-test-app.js';
import { resetDb } from './support/db.js';
import {
  createAuthedUser,
  createHttpClient,
  createOrgWith,
  type TestUser,
} from './support/http-client.js';

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NO_SUCH_ORG = '0198a2b4-5d6e-7f80-9a1b-2c3d4e5f6a7b';
const withoutRequestId = ({
  requestId: _id,
  ...rest
}: Record<string, unknown>) => rest;

describe('organisations (HTTP + real Postgres)', () => {
  let app: NestExpressApplication;
  let db: PrismaService;
  let client: ReturnType<typeof createHttpClient>;
  const http = (...args: Parameters<typeof client.call>) =>
    client.call(...args);

  let ada: TestUser;
  let bob: TestUser;
  let cleo: TestUser;
  let outsider: TestUser;

  beforeAll(async () => {
    ({ app } = await createTestApp({
      realDatabase: true,
      env: { TRUST_PROXY_HOPS: '1' },
    }));
    db = app.get(PrismaService);
    client = createHttpClient(app);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(db);
    ada = await createAuthedUser(app, db, 'ada@example.com');
    bob = await createAuthedUser(app, db, 'bob@example.com');
    cleo = await createAuthedUser(app, db, 'cleo@example.com');
    outsider = await createAuthedUser(app, db, 'outsider@example.com');
  });

  describe('POST /v1/orgs', () => {
    it('creates the organisation, makes the caller its OWNER, and puts it on the FREE plan', async () => {
      const res = await http('post', '/v1/orgs', {
        bearer: ada.token,
        body: { name: 'Acme Studio' },
      }).expect(201);

      expect(res.body).toMatchObject({
        name: 'Acme Studio',
        role: 'OWNER',
      });
      expect(res.body.id).toMatch(UUID_V7);
      expect(res.body.slug).toMatch(/^acme-studio-[0-9a-f]{6}$/);

      const org = await db.organization.findUniqueOrThrow({
        where: { id: res.body.id },
        include: { memberships: true, subscription: true },
      });
      expect(org.memberships).toEqual([
        expect.objectContaining({ userId: ada.id, role: 'OWNER' }),
      ]);
      expect(org.subscription).toMatchObject({
        plan: 'FREE',
        status: 'ACTIVE',
      });
      expect(org.isDemo).toBe(false);
    });

    it('trims the name, and gives two organisations with the same name different slugs', async () => {
      const make = () =>
        http('post', '/v1/orgs', {
          bearer: ada.token,
          body: { name: '  Acme  ' },
        }).expect(201);
      const [a, b] = [await make(), await make()];
      expect(a.body.name).toBe('Acme');
      expect(a.body.slug).not.toBe(b.body.slug);
    });

    it.each([
      ['Café Münchën — Ltd.', /^cafe-munchen-ltd-[0-9a-f]{6}$/],
      ['!!!', /^org-[0-9a-f]{6}$/],
      ['密码', /^org-[0-9a-f]{6}$/],
    ])('builds a safe slug from %j', async (name, pattern) => {
      const res = await http('post', '/v1/orgs', {
        bearer: ada.token,
        body: { name },
      }).expect(201);
      expect(res.body.slug).toMatch(pattern);
    });

    it.each([
      ['an empty name', { name: '' }],
      ['a blank name', { name: '    ' }],
      ['a missing name', {}],
      ['a name that is not text', { name: 42 }],
      ['a 101-character name', { name: 'x'.repeat(101) }],
    ])('rejects %s with 400 and creates nothing', async (_label, body) => {
      const res = await http('post', '/v1/orgs', {
        bearer: ada.token,
        body,
      }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(await db.organization.count()).toBe(0);
    });

    it('refuses fields the client must not set (slug, plan, role, isDemo, owner)', async () => {
      for (const extra of [
        { slug: 'mine' },
        { plan: 'PRO' },
        { role: 'OWNER' },
        { isDemo: true },
        { organizationId: NO_SUCH_ORG },
      ]) {
        await http('post', '/v1/orgs', {
          bearer: ada.token,
          body: { name: 'Acme', ...extra },
        }).expect(400);
      }
      expect(await db.organization.count()).toBe(0);
    });

    it('requires authentication', async () => {
      await http('post', '/v1/orgs', { body: { name: 'Acme' } }).expect(401);
      await http('post', '/v1/orgs', {
        bearer: 'garbage',
        body: { name: 'Acme' },
      }).expect(401);
    });

    it('is not available to demo accounts', async () => {
      const demo = await createAuthedUser(app, db, 'demo@example.com', {
        isDemo: true,
      });
      const res = await http('post', '/v1/orgs', {
        bearer: demo.token,
        body: { name: 'Mine' },
      }).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('limits how many organisations one person can OWN (default 5), but not how many they join', async () => {
      // Belonging to many organisations as a MEMBER does not count against the quota.
      for (let i = 0; i < 7; i++) {
        await createOrgWith(db, `joined-${i}`, [{ user: ada, role: 'MEMBER' }]);
      }
      for (let i = 0; i < 5; i++) {
        await http('post', '/v1/orgs', {
          bearer: ada.token,
          body: { name: `Own ${i}` },
        }).expect(201);
      }
      const res = await http('post', '/v1/orgs', {
        bearer: ada.token,
        body: { name: 'One too many' },
      }).expect(403);
      expect(res.body.code).toBe('LIMIT_REACHED');
      expect(res.body.detail).toContain('5');
      expect(
        await db.membership.count({ where: { userId: ada.id, role: 'OWNER' } }),
      ).toBe(5);

      // Someone else is unaffected.
      await http('post', '/v1/orgs', {
        bearer: bob.token,
        body: { name: 'Bob Co' },
      }).expect(201);
    });
  });

  describe('GET /v1/orgs', () => {
    it('lists only my organisations, with my role in each, oldest first', async () => {
      const first = await createOrgWith(db, 'first', [
        { user: ada, role: 'OWNER' },
        { user: bob, role: 'MEMBER' },
      ]);
      const second = await createOrgWith(db, 'second', [
        { user: bob, role: 'ADMIN' },
      ]);
      await createOrgWith(db, 'not-mine', [{ user: cleo, role: 'OWNER' }]);

      const res = await http('get', '/v1/orgs', { bearer: bob.token }).expect(
        200,
      );
      expect(
        res.body.map((o: { id: string; role: string }) => [o.id, o.role]),
      ).toEqual([
        [first.id, 'MEMBER'],
        [second.id, 'ADMIN'],
      ]);
    });

    it('is an empty list, not an error, for someone with no organisations', async () => {
      const res = await http('get', '/v1/orgs', {
        bearer: outsider.token,
      }).expect(200);
      expect(res.body).toEqual([]);
    });

    it('requires authentication', async () => {
      await http('get', '/v1/orgs').expect(401);
    });
  });

  describe('GET /v1/orgs/:orgId', () => {
    it.each(['OWNER', 'ADMIN', 'MEMBER'] as const)(
      'a %s can read their organisation, including their own role, plan and size',
      async (role) => {
        const { id } = await createOrgWith(db, 'acme', [
          { user: cleo, role: 'OWNER' },
          { user: bob, role: 'MEMBER' },
          { user: ada, role },
        ]);
        const res = await http('get', `/v1/orgs/${id}`, {
          bearer: ada.token,
        }).expect(200);
        expect(res.body).toMatchObject({
          id,
          slug: 'acme',
          role,
          plan: 'FREE',
          memberCount: 3,
        });
      },
    );

    it('answers 404 to a non-member exactly as it does for an organisation that does not exist', async () => {
      const { id } = await createOrgWith(db, 'secret', [
        { user: ada, role: 'OWNER' },
      ]);
      const asOutsider = await http('get', `/v1/orgs/${id}`, {
        bearer: outsider.token,
      }).expect(404);
      const missing = await http('get', `/v1/orgs/${NO_SUCH_ORG}`, {
        bearer: outsider.token,
      }).expect(404);
      const malformed = await http('get', '/v1/orgs/not-a-uuid', {
        bearer: outsider.token,
      }).expect(404);

      expect(withoutRequestId(asOutsider.body)).toEqual(
        withoutRequestId(missing.body),
      );
      expect(withoutRequestId(malformed.body)).toEqual(
        withoutRequestId(missing.body),
      );
      expect(asOutsider.body.code).toBe('NOT_FOUND');
    });

    it('requires authentication (401, not 404)', async () => {
      const { id } = await createOrgWith(db, 'acme', [
        { user: ada, role: 'OWNER' },
      ]);
      await http('get', `/v1/orgs/${id}`).expect(401);
    });
  });

  describe('PATCH /v1/orgs/:orgId', () => {
    let orgId: string;
    beforeEach(async () => {
      ({ id: orgId } = await createOrgWith(db, 'acme', [
        { user: ada, role: 'OWNER' },
        { user: bob, role: 'ADMIN' },
        { user: cleo, role: 'MEMBER' },
      ]));
    });
    const rename = (user: TestUser, name: string, id = orgId) =>
      http('patch', `/v1/orgs/${id}`, { bearer: user.token, body: { name } });

    it.each([
      ['owner', () => ada],
      ['admin', () => bob],
    ])(
      'lets the %s rename it, and keeps the slug stable',
      async (_who, user) => {
        const res = await rename(user(), '  New Name ').expect(200);
        expect(res.body).toMatchObject({ name: 'New Name', slug: 'acme' });
        expect(
          (await db.organization.findUniqueOrThrow({ where: { id: orgId } }))
            .name,
        ).toBe('New Name');
      },
    );

    it('forbids a member (403) and changes nothing', async () => {
      const res = await rename(cleo, 'Hacked').expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect(
        (await db.organization.findUniqueOrThrow({ where: { id: orgId } }))
          .name,
      ).toBe('acme');
    });

    it('answers 404 to a non-member and changes nothing', async () => {
      await rename(outsider, 'Hacked').expect(404);
      expect(
        (await db.organization.findUniqueOrThrow({ where: { id: orgId } }))
          .name,
      ).toBe('acme');
    });

    it('rejects an invalid name, and fields that must not be changed', async () => {
      await rename(ada, '').expect(400);
      await http('patch', `/v1/orgs/${orgId}`, {
        bearer: ada.token,
        body: { name: 'Ok', slug: 'taken-over' },
      }).expect(400);
      await http('patch', `/v1/orgs/${orgId}`, {
        bearer: ada.token,
        body: { name: 'Ok', isDemo: true },
      }).expect(400);
    });
  });

  describe('DELETE /v1/orgs/:orgId', () => {
    let orgId: string;
    let otherId: string;
    beforeEach(async () => {
      ({ id: orgId } = await createOrgWith(db, 'doomed', [
        { user: ada, role: 'OWNER' },
        { user: bob, role: 'ADMIN' },
        { user: cleo, role: 'MEMBER' },
      ]));
      ({ id: otherId } = await createOrgWith(db, 'survivor', [
        { user: ada, role: 'OWNER' },
      ]));
      const client = await db.client.create({
        data: { organizationId: orgId, name: 'C', email: 'c@client.example' },
      });
      await db.task.create({ data: { organizationId: orgId, title: 'T' } });
      await db.invoice.create({
        data: {
          organizationId: orgId,
          clientId: client.id,
          number: 'INV-0001',
          totalCents: 100,
        },
      });
      await db.task.create({
        data: { organizationId: otherId, title: 'Keep me' },
      });
    });

    it('lets only the owner delete it, removing everything it owns and nothing else', async () => {
      await http('delete', `/v1/orgs/${orgId}`, { bearer: ada.token }).expect(
        204,
      );

      expect(
        await db.organization.findUnique({ where: { id: orgId } }),
      ).toBeNull();
      expect(
        await db.membership.count({ where: { organizationId: orgId } }),
      ).toBe(0);
      expect(await db.task.count({ where: { organizationId: orgId } })).toBe(0);
      expect(await db.invoice.count({ where: { organizationId: orgId } })).toBe(
        0,
      );
      expect(await db.client.count({ where: { organizationId: orgId } })).toBe(
        0,
      );
      expect(
        await db.subscription.count({ where: { organizationId: orgId } }),
      ).toBe(0);

      // The other organisation, and every user, are untouched.
      expect(await db.task.count({ where: { organizationId: otherId } })).toBe(
        1,
      );
      expect(await db.user.count()).toBe(4);
    });

    it.each([
      ['an admin', () => bob, 403],
      ['a member', () => cleo, 403],
      ['a non-member', () => outsider, 404],
    ])('refuses %s (%d) and deletes nothing', async (_who, user, status) => {
      await http('delete', `/v1/orgs/${orgId}`, {
        bearer: user().token,
      }).expect(status);
      expect(await db.organization.count()).toBe(2);
      expect(await db.task.count({ where: { organizationId: orgId } })).toBe(1);
    });

    it('after deletion everyone who was in it gets 404, and the owner can still create a new one', async () => {
      await http('delete', `/v1/orgs/${orgId}`, { bearer: ada.token }).expect(
        204,
      );
      await http('get', `/v1/orgs/${orgId}`, { bearer: bob.token }).expect(404);
      await http('get', `/v1/orgs/${orgId}`, { bearer: ada.token }).expect(404);
      await http('delete', `/v1/orgs/${orgId}`, { bearer: ada.token }).expect(
        404,
      );
      await http('post', '/v1/orgs', {
        bearer: ada.token,
        body: { name: 'Fresh start' },
      }).expect(201);
    });
  });
});
