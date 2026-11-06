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

/**
 * The tenant and permission guards, exercised through the real app with test-only routes
 * that need each kind of permission. This is what protects every future tenant endpoint.
 */
describe('tenant and permission guards (HTTP + real Postgres)', () => {
  let app: NestExpressApplication;
  let db: PrismaService;
  let client: ReturnType<typeof createHttpClient>;
  const http = (...args: Parameters<typeof client.call>) =>
    client.call(...args);

  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let orgId: string;
  const probe = (user: TestUser | null, path: string, id = orgId) =>
    http('get', `/v1/orgs/${id}/probe/${path}`, { bearer: user?.token });

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
    owner = await createAuthedUser(app, db, 'owner@example.com');
    admin = await createAuthedUser(app, db, 'admin@example.com');
    member = await createAuthedUser(app, db, 'member@example.com');
    outsider = await createAuthedUser(app, db, 'outsider@example.com');
    ({ id: orgId } = await createOrgWith(db, 'acme', [
      { user: owner, role: 'OWNER' },
      { user: admin, role: 'ADMIN' },
      { user: member, role: 'MEMBER' },
    ]));
  });

  describe('permission matrix, as enforced on live routes', () => {
    // [route, required permission, status for OWNER, ADMIN, MEMBER]
    it.each([
      ['anyone', 'org:read', 200, 200, 200],
      ['managers', 'invoice:send', 200, 200, 403],
      ['owner', 'billing:manage', 200, 403, 403],
    ] as const)(
      '%s (%s): owner %d, admin %d, member %d',
      async (route, _perm, o, a, m) => {
        await probe(owner, route).expect(o);
        await probe(admin, route).expect(a);
        await probe(member, route).expect(m);
      },
    );

    it('gives a 403 problem+json that does not reveal what permission was missing', async () => {
      const res = await probe(member, 'owner').expect(403);
      expect(res.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      expect(res.body).toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect(JSON.stringify(res.body)).not.toMatch(/billing/);
    });
  });

  describe('fail closed', () => {
    it('refuses a tenant route that forgot to declare a permission, even for the owner', async () => {
      const res = await probe(owner, 'forgot-permission').expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });
  });

  describe('who gets which status', () => {
    it('anonymous or bad token: 401, never 404/403 (does not leak that the org exists)', async () => {
      await probe(null, 'anyone').expect(401);
      await http('get', `/v1/orgs/${orgId}/probe/anyone`, {
        bearer: 'garbage',
      }).expect(401);
    });

    it('non-member: 404 for every route, identical to a made-up organisation', async () => {
      const ghost = '0198a2b4-5d6e-7f80-9a1b-2c3d4e5f6a7b';
      for (const route of [
        'anyone',
        'managers',
        'owner',
        'forgot-permission',
      ]) {
        const real = await probe(outsider, route).expect(404);
        const fake = await probe(outsider, route, ghost).expect(404);
        const strip = ({ requestId: _id, ...rest }: Record<string, unknown>) =>
          rest;
        expect(strip(real.body)).toEqual(strip(fake.body));
      }
    });

    it('member without permission: 403', async () => {
      await probe(member, 'managers').expect(403);
    });
  });

  describe('the role is per organisation', () => {
    it('the same person is OWNER here, MEMBER there, and a stranger elsewhere', async () => {
      const second = await createOrgWith(db, 'second', [
        { user: outsider, role: 'OWNER' },
        { user: owner, role: 'MEMBER' },
      ]);
      const third = await createOrgWith(db, 'third', [
        { user: outsider, role: 'OWNER' },
      ]);

      const here = await probe(owner, 'anyone').expect(200);
      expect(here.body).toMatchObject({ organizationId: orgId, role: 'OWNER' });
      await probe(owner, 'owner').expect(200);

      const there = await probe(owner, 'anyone', second.id).expect(200);
      expect(there.body).toMatchObject({
        organizationId: second.id,
        role: 'MEMBER',
      });
      await probe(owner, 'owner', second.id).expect(403);

      await probe(owner, 'anyone', third.id).expect(404);
    });

    it('reports the membership id of the caller in that organisation', async () => {
      const res = await probe(admin, 'anyone').expect(200);
      const m = await db.membership.findFirstOrThrow({
        where: { organizationId: orgId, userId: admin.id },
      });
      expect(res.body.membershipId).toBe(m.id);
    });
  });

  describe('changes take effect on the very next request, with the same access token', () => {
    it('a demotion', async () => {
      await probe(admin, 'managers').expect(200);
      await db.membership.updateMany({
        where: { organizationId: orgId, userId: admin.id },
        data: { role: 'MEMBER' },
      });
      await probe(admin, 'managers').expect(403);
    });

    it('a promotion', async () => {
      await probe(member, 'managers').expect(403);
      await db.membership.updateMany({
        where: { organizationId: orgId, userId: member.id },
        data: { role: 'ADMIN' },
      });
      await probe(member, 'managers').expect(200);
    });

    it('removal from the organisation', async () => {
      await probe(member, 'anyone').expect(200);
      await db.membership.deleteMany({
        where: { organizationId: orgId, userId: member.id },
      });
      await probe(member, 'anyone').expect(404);
    });

    it('deletion of the whole organisation', async () => {
      await db.organization.delete({ where: { id: orgId } });
      await probe(owner, 'anyone').expect(404);
    });
  });

  describe('hostile organisation ids', () => {
    it.each([
      "' OR 1=1 --",
      '../../etc/passwd',
      '%00',
      '0198a2b4-5d6e-7f80-9a1b-2c3d4e5f6a7bzz',
      'ALL',
      '*',
    ])('%j is a plain 404 and never an error', async (id) => {
      const res = await http(
        'get',
        `/v1/orgs/${encodeURIComponent(id)}/probe/anyone`,
        {
          bearer: owner.token,
        },
      );
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });
});
