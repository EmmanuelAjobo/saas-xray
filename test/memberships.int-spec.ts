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

const NO_SUCH_MEMBER = '0198a2b4-5d6e-7f80-9a1b-2c3d4e5f6a7b';

describe('members and roles (HTTP + real Postgres)', () => {
  let app: NestExpressApplication;
  let db: PrismaService;
  let client: ReturnType<typeof createHttpClient>;
  const http = (...args: Parameters<typeof client.call>) =>
    client.call(...args);

  // owner, a second owner, an admin, two members, and someone in no organisation
  let owner: TestUser;
  let owner2: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let member2: TestUser;
  let outsider: TestUser;
  let orgId: string;
  let mid: (user: TestUser) => string;

  const roleOf = async (user: TestUser) =>
    (
      await db.membership.findUnique({
        where: {
          userId_organizationId: { userId: user.id, organizationId: orgId },
        },
      })
    )?.role ?? null;
  const ownerCount = () =>
    db.membership.count({ where: { organizationId: orgId, role: 'OWNER' } });

  const setRole = (actor: TestUser, target: TestUser, role: string) =>
    http('patch', `/v1/orgs/${orgId}/members/${mid(target)}`, {
      bearer: actor.token,
      body: { role },
    });
  const remove = (actor: TestUser, target: TestUser) =>
    http('delete', `/v1/orgs/${orgId}/members/${mid(target)}`, {
      bearer: actor.token,
    });
  const leave = (actor: TestUser) =>
    http('post', `/v1/orgs/${orgId}/members/leave`, { bearer: actor.token });

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
    owner2 = await createAuthedUser(app, db, 'owner2@example.com');
    admin = await createAuthedUser(app, db, 'admin@example.com');
    member = await createAuthedUser(app, db, 'member@example.com');
    member2 = await createAuthedUser(app, db, 'member2@example.com');
    outsider = await createAuthedUser(app, db, 'outsider@example.com');
    const org = await createOrgWith(db, 'acme', [
      { user: owner, role: 'OWNER' },
      { user: owner2, role: 'OWNER' },
      { user: admin, role: 'ADMIN' },
      { user: member, role: 'MEMBER' },
      { user: member2, role: 'MEMBER' },
    ]);
    orgId = org.id;
    mid = org.membershipOf;
  });

  describe('GET members', () => {
    it('shows the team to any member (name, email, role), and never anything secret', async () => {
      const res = await http('get', `/v1/orgs/${orgId}/members`, {
        bearer: member.token,
      }).expect(200);
      expect(res.body).toHaveLength(5);
      expect(res.body[0]).toEqual({
        id: mid(owner),
        userId: owner.id,
        name: 'owner',
        email: 'owner@example.com',
        role: 'OWNER',
        joinedAt: expect.any(String),
      });
      expect(JSON.stringify(res.body)).not.toMatch(/password|hash|token/i);
    });

    it('is invisible to non-members (404) and anonymous callers (401)', async () => {
      await http('get', `/v1/orgs/${orgId}/members`, {
        bearer: outsider.token,
      }).expect(404);
      await http('get', `/v1/orgs/${orgId}/members`).expect(401);
    });
  });

  describe('changing a role', () => {
    it('lets an owner promote and demote anyone below them', async () => {
      await setRole(owner, member, 'ADMIN').expect(200);
      expect(await roleOf(member)).toBe('ADMIN');
      await setRole(owner, admin, 'MEMBER').expect(200);
      expect(await roleOf(admin)).toBe('MEMBER');
    });

    it('returns the updated member', async () => {
      const res = await setRole(owner, member, 'ADMIN').expect(200);
      expect(res.body).toMatchObject({
        id: mid(member),
        email: 'member@example.com',
        role: 'ADMIN',
      });
    });

    it('lets an admin manage members, but not owners and not ownership', async () => {
      await setRole(admin, member, 'ADMIN').expect(200);
      await setRole(admin, member, 'MEMBER').expect(200);

      const touchOwner = await setRole(admin, owner, 'MEMBER').expect(403);
      expect(touchOwner.body.code).toBe('FORBIDDEN');
      await setRole(admin, member, 'OWNER').expect(403);
      expect(await roleOf(owner)).toBe('OWNER');
      expect(await roleOf(member)).toBe('MEMBER');
    });

    it('never lets a member change anyone’s role', async () => {
      await setRole(member, member2, 'ADMIN').expect(403);
      await setRole(member, member, 'OWNER').expect(403);
      expect(await roleOf(member2)).toBe('MEMBER');
      expect(await roleOf(member)).toBe('MEMBER');
    });

    it.each([
      ['owner', () => owner],
      ['admin', () => admin],
    ])('stops the %s changing their own role', async (_who, actor) => {
      const res = await setRole(actor(), actor(), 'MEMBER').expect(403);
      expect(res.body.detail).toMatch(/own role/);
      const res2 = await setRole(actor(), actor(), 'OWNER').expect(403);
      expect(res2.body.detail).toMatch(/own role/);
    });

    it('transfers ownership in two steps: promote the successor, then they step the old owner down', async () => {
      await setRole(owner, member, 'OWNER').expect(200);
      expect(await ownerCount()).toBe(3);
      await setRole(member, owner, 'MEMBER').expect(200);
      await setRole(member, owner2, 'MEMBER').expect(200);
      expect(await ownerCount()).toBe(1);
      expect(await roleOf(member)).toBe('OWNER');
    });

    it('is harmless to set a role someone already has', async () => {
      await setRole(owner, member, 'MEMBER').expect(200);
      expect(await roleOf(member)).toBe('MEMBER');
    });

    it('rejects an invalid role, and extra fields', async () => {
      await setRole(owner, member, 'SUPERUSER').expect(400);
      await setRole(owner, member, 'owner').expect(400);
      await http('patch', `/v1/orgs/${orgId}/members/${mid(member)}`, {
        bearer: owner.token,
        body: { role: 'ADMIN', userId: outsider.id },
      }).expect(400);
      await http('patch', `/v1/orgs/${orgId}/members/${mid(member)}`, {
        bearer: owner.token,
        body: {},
      }).expect(400);
      expect(await roleOf(member)).toBe('MEMBER');
    });

    it('treats another organisation’s membership, an unknown id and a malformed id the same: 404', async () => {
      const other = await createOrgWith(db, 'other', [
        { user: outsider, role: 'OWNER' },
        {
          user: await createAuthedUser(app, db, 'x@example.com'),
          role: 'MEMBER',
        },
      ]);
      const foreign = other.org.memberships[1]!.id;
      for (const id of [foreign, NO_SUCH_MEMBER, 'not-a-uuid']) {
        const res = await http('patch', `/v1/orgs/${orgId}/members/${id}`, {
          bearer: owner.token,
          body: { role: 'ADMIN' },
        }).expect(404);
        expect(res.body.code).toBe('NOT_FOUND');
      }
      expect(
        (await db.membership.findUniqueOrThrow({ where: { id: foreign } }))
          .role,
      ).toBe('MEMBER');
    });

    it('cannot be used from outside: a non-member of this organisation gets 404', async () => {
      await setRole(outsider, member, 'ADMIN').expect(404);
      expect(await roleOf(member)).toBe('MEMBER');
    });

    it('cannot reach into another organisation by using its id in the URL', async () => {
      // owner owns "acme" but is nobody in "other": acting on other's members must fail.
      const other = await createOrgWith(db, 'other', [
        { user: outsider, role: 'OWNER' },
        { user: member2, role: 'MEMBER' },
      ]);
      await http(
        'patch',
        `/v1/orgs/${other.id}/members/${other.membershipOf(member2)}`,
        { bearer: owner.token, body: { role: 'ADMIN' } },
      ).expect(404);
      expect(
        (
          await db.membership.findUniqueOrThrow({
            where: { id: other.membershipOf(member2) },
          })
        ).role,
      ).toBe('MEMBER');
    });
  });

  describe('the organisation always keeps an owner', () => {
    it('two owners demoting each other at the same instant: exactly one wins, an owner remains', async () => {
      for (let round = 0; round < 5; round++) {
        await db.membership.updateMany({
          where: {
            organizationId: orgId,
            userId: { in: [owner.id, owner2.id] },
          },
          data: { role: 'OWNER' },
        });
        const [a, b] = await Promise.all([
          setRole(owner, owner2, 'MEMBER'),
          setRole(owner2, owner, 'MEMBER'),
        ]);
        expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 403]);
        expect(await ownerCount()).toBeGreaterThanOrEqual(1);
      }
    });

    it('two owners removing each other at the same instant: exactly one wins', async () => {
      const [a, b] = await Promise.all([
        remove(owner, owner2),
        remove(owner2, owner),
      ]);
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([204, 404]);
      expect(await ownerCount()).toBe(1);
    });

    it('an owner cannot leave while they are the only one', async () => {
      await db.membership.delete({ where: { id: mid(owner2) } });
      const res = await leave(owner).expect(409);
      expect(res.body.detail).toMatch(/only owner/);
      expect(await roleOf(owner)).toBe('OWNER');
    });

    it('an owner can leave once another owner exists', async () => {
      await leave(owner).expect(204);
      expect(await roleOf(owner)).toBeNull();
      expect(await ownerCount()).toBe(1);
    });
  });

  describe('a demoted admin loses the power immediately, even mid-request', () => {
    it('is refused on the very next call with the SAME access token', async () => {
      await setRole(admin, member, 'ADMIN').expect(200); // admin can, for now
      await setRole(owner, admin, 'MEMBER').expect(200);
      await setRole(admin, member2, 'ADMIN').expect(403); // same token, no re-login
      expect(await roleOf(member2)).toBe('MEMBER');
    });

    it('a request that already passed the guard is re-checked under the lock', async () => {
      // Hold the organisation lock in a transaction that demotes the admin, so the admin's
      // request passes the guard (still ADMIN) but must wait, then sees the demotion.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const gotLock = new Promise<void>((resolve) => (locked = resolve));
      const holder = db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${orgId}::uuid FOR UPDATE`;
        await tx.membership.update({
          where: { id: mid(admin) },
          data: { role: 'MEMBER' },
        });
        locked();
        await held;
      });
      await gotLock;
      const pending = setRole(admin, member2, 'ADMIN').then((r) => r);
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      await holder;
      const res = await pending;
      expect(res.status).toBe(403);
      expect(await roleOf(member2)).toBe('MEMBER');
    });
  });

  describe('removing a member', () => {
    it('lets an owner and an admin remove ordinary members', async () => {
      await remove(owner, member).expect(204);
      await remove(admin, member2).expect(204);
      expect(await roleOf(member)).toBeNull();
      expect(await roleOf(member2)).toBeNull();
    });

    it('lets an admin remove another admin or themselves-not, but never an owner', async () => {
      await remove(admin, owner).expect(403);
      expect(await roleOf(owner)).toBe('OWNER');
    });

    it('lets an owner remove another owner', async () => {
      await remove(owner, owner2).expect(204);
      expect(await ownerCount()).toBe(1);
    });

    it('never lets a member remove anyone', async () => {
      await remove(member, member2).expect(403);
      await remove(member, admin).expect(403);
      expect(await roleOf(member2)).toBe('MEMBER');
    });

    it('sends you to "leave" instead of removing yourself here', async () => {
      const res = await remove(admin, admin).expect(409);
      expect(res.body.detail).toMatch(/leave/);
      expect(await roleOf(admin)).toBe('ADMIN');
    });

    it('takes effect immediately: the removed person’s valid token now gets 404', async () => {
      await http('get', `/v1/orgs/${orgId}`, { bearer: member.token }).expect(
        200,
      );
      await remove(owner, member).expect(204);
      await http('get', `/v1/orgs/${orgId}`, { bearer: member.token }).expect(
        404,
      );
      await http('get', `/v1/orgs/${orgId}/members`, {
        bearer: member.token,
      }).expect(404);
      // Their account and other organisations are untouched.
      expect(
        await db.user.findUnique({ where: { id: member.id } }),
      ).not.toBeNull();
    });

    it('keeps their tasks, now unassigned', async () => {
      const task = await db.task.create({
        data: {
          organizationId: orgId,
          title: 'Orphan me',
          assigneeId: mid(member),
        },
      });
      await remove(owner, member).expect(204);
      const after = await db.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(after.assigneeId).toBeNull();
    });

    it('can be repeated safely: the second attempt is a plain 404', async () => {
      await remove(owner, member).expect(204);
      await remove(owner, member).expect(404);
    });
  });

  describe('leaving', () => {
    it('lets a member leave, and the door closes immediately', async () => {
      await leave(member).expect(204);
      expect(await roleOf(member)).toBeNull();
      await http('get', `/v1/orgs/${orgId}`, { bearer: member.token }).expect(
        404,
      );
      await leave(member).expect(404);
    });

    it('is refused for a non-member', async () => {
      await leave(outsider).expect(404);
    });
  });
});
