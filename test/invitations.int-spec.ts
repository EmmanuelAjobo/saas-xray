import { createHash } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { BackgroundTasks } from '../src/core/background/background-tasks.service.js';
import { PrismaService } from '../src/core/prisma/prisma.service.js';
import { createTestApp } from './support/create-test-app.js';
import { resetDb } from './support/db.js';
import type { FakeMailTransport } from './support/fake-mail.js';
import {
  createAuthedUser,
  createHttpClient,
  createOrgWith,
  type TestUser,
} from './support/http-client.js';

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const DAY = 86_400_000;
const strip = ({ requestId: _id, ...rest }: Record<string, unknown>) => rest;

describe('invitations (HTTP + real Postgres)', () => {
  let app: NestExpressApplication;
  let db: PrismaService;
  let mail: FakeMailTransport;
  let background: BackgroundTasks;
  let client: ReturnType<typeof createHttpClient>;
  const http = (...args: Parameters<typeof client.call>) =>
    client.call(...args);

  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let orgId: string;

  const invite = (
    actor: TestUser,
    email: string,
    role = 'MEMBER',
    id = orgId,
  ) =>
    http('post', `/v1/orgs/${id}/invitations`, {
      bearer: actor.token,
      body: { email, role },
    });
  const accept = (actor: TestUser | null, token: string) =>
    http('post', '/v1/invitations/accept', {
      bearer: actor?.token,
      body: { token },
    });
  const preview = (token: string) =>
    http('post', '/v1/invitations/preview', { body: { token } });
  const upgradeToPro = () =>
    db.subscription.update({
      where: { organizationId: orgId },
      data: { plan: 'PRO' },
    });
  /** Invites and returns the token that was emailed. */
  const inviteAndGetToken = async (email: string, role = 'MEMBER') => {
    const res = await invite(owner, email, role).expect(201);
    await background.drain();
    return { id: res.body.id as string, token: mail.lastToken(email) };
  };

  beforeAll(async () => {
    ({ app, mail, background } = await createTestApp({
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
    mail.clear();
    mail.failWith = undefined;
    owner = await createAuthedUser(app, db, 'owner@example.com');
    admin = await createAuthedUser(app, db, 'admin@example.com');
    member = await createAuthedUser(app, db, 'member@example.com');
    outsider = await createAuthedUser(app, db, 'outsider@example.com');
    ({ id: orgId } = await createOrgWith(db, 'acme', [
      { user: owner, role: 'OWNER' },
      { user: admin, role: 'ADMIN' },
      { user: member, role: 'MEMBER' },
    ]));
    // The default FREE plan has 3 seats and this org already uses them; most tests need room.
    await upgradeToPro();
  });

  describe('sending an invitation', () => {
    it('creates it, emails a link, and stores only a hash of the token', async () => {
      const res = await invite(owner, 'newhire@example.com', 'MEMBER').expect(
        201,
      );
      await background.drain();

      expect(res.body).toMatchObject({
        email: 'newhire@example.com',
        role: 'MEMBER',
        status: 'PENDING',
      });
      expect(res.body).not.toHaveProperty('tokenHash');
      expect(JSON.stringify(res.body)).not.toContain(
        mail.lastToken('newhire@example.com'),
      );
      const days = (new Date(res.body.expiresAt).getTime() - Date.now()) / DAY;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThanOrEqual(7);

      const sent = mail.to('newhire@example.com');
      expect(sent).toHaveLength(1);
      expect(sent[0]?.subject).toBe('owner invited you to acme');
      expect(sent[0]?.text).toContain(
        'http://localhost:3001/invite/accept?token=',
      );
      expect(sent[0]?.text).toContain('as member');
      expect(sent[0]?.text).toContain('7 days');

      const row = await db.invitation.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(row.tokenHash).toBe(sha256(mail.lastToken('newhire@example.com')));
      expect(row.invitedById).toBe(owner.id);
    });

    it('normalises the email (case and spaces)', async () => {
      const res = await invite(owner, '  New.Hire@Example.COM ').expect(201);
      expect(res.body.email).toBe('new.hire@example.com');
    });

    it('lets owners and admins invite, but not members, outsiders or anonymous callers', async () => {
      await invite(owner, 'a@example.com').expect(201);
      await invite(admin, 'b@example.com', 'ADMIN').expect(201);
      await invite(member, 'c@example.com').expect(403);
      await invite(outsider, 'd@example.com').expect(404);
      await http('post', `/v1/orgs/${orgId}/invitations`, {
        body: { email: 'e@example.com', role: 'MEMBER' },
      }).expect(401);
      expect(await db.invitation.count()).toBe(2);
    });

    it('requires a verified email address (decision D4)', async () => {
      const unverified = await createAuthedUser(
        app,
        db,
        'unverified@example.com',
        {
          verified: false,
        },
      );
      await db.membership.create({
        data: { userId: unverified.id, organizationId: orgId, role: 'ADMIN' },
      });
      const res = await invite(unverified, 'x@example.com').expect(403);
      expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
      expect(await db.invitation.count()).toBe(0);
    });

    it('is not available to demo accounts', async () => {
      const demo = await createAuthedUser(app, db, 'demo@example.com', {
        isDemo: true,
      });
      await db.membership.create({
        data: { userId: demo.id, organizationId: orgId, role: 'ADMIN' },
      });
      await invite(demo, 'x@example.com').expect(403);
      expect(mail.sent).toHaveLength(0);
    });

    it.each([
      [
        'an OWNER invitation (ownership is never invited)',
        { email: 'x@example.com', role: 'OWNER' },
      ],
      ['an unknown role', { email: 'x@example.com', role: 'GOD' }],
      ['a missing role', { email: 'x@example.com' }],
      ['an invalid email', { email: 'nope', role: 'MEMBER' }],
      ['a missing email', { role: 'MEMBER' }],
      [
        'extra fields (status, token, organizationId)',
        { email: 'x@example.com', role: 'MEMBER', status: 'ACCEPTED' },
      ],
    ])('rejects %s with 400 and creates nothing', async (_label, body) => {
      const res = await http('post', `/v1/orgs/${orgId}/invitations`, {
        bearer: owner.token,
        body,
      }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(await db.invitation.count()).toBe(0);
    });

    it('rejects a second pending invitation for the same email (409), ignoring case', async () => {
      await invite(owner, 'dup@example.com').expect(201);
      await invite(admin, 'DUP@example.com').expect(409);
      expect(await db.invitation.count()).toBe(1);
    });

    it('rejects inviting someone who is already a member (409), ignoring case', async () => {
      const res = await invite(owner, 'MEMBER@example.com').expect(409);
      expect(res.body.detail).toMatch(/already a member/);
      await invite(owner, 'owner@example.com').expect(409);
    });

    it('allows inviting again after a revoke, and after an expiry', async () => {
      const first = await invite(owner, 'again@example.com').expect(201);
      await http('delete', `/v1/orgs/${orgId}/invitations/${first.body.id}`, {
        bearer: owner.token,
      }).expect(204);
      const second = await invite(owner, 'again@example.com').expect(201);

      await db.invitation.update({
        where: { id: second.body.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await invite(owner, 'again@example.com').expect(201);
      expect(
        (
          await db.invitation.findUniqueOrThrow({
            where: { id: second.body.id },
          })
        ).status,
      ).toBe('EXPIRED');
    });

    it('still succeeds when the mail provider is down', async () => {
      mail.failWith = new Error('SMTP connection refused');
      await invite(owner, 'x@example.com').expect(201);
      await background.drain();
      expect(await db.invitation.count()).toBe(1);
    });

    it('never reveals a token in any response', async () => {
      const res = await invite(owner, 'x@example.com').expect(201);
      const list = await http('get', `/v1/orgs/${orgId}/invitations`, {
        bearer: owner.token,
      }).expect(200);
      expect(JSON.stringify([res.body, list.body])).not.toMatch(/token/i);
    });
  });

  describe('seats and plan limits', () => {
    beforeEach(async () => {
      // Back to the FREE plan (3 seats). The org has 3 members, so it is full.
      await db.subscription.update({
        where: { organizationId: orgId },
        data: { plan: 'FREE' },
      });
    });

    it('refuses with 402 and an upgrade link when the plan is full', async () => {
      const res = await invite(owner, 'x@example.com').expect(402);
      expect(res.body).toMatchObject({
        status: 402,
        code: 'PLAN_LIMIT_EXCEEDED',
        upgradeUrl: 'http://localhost:3001/settings/billing',
      });
      expect(res.body.detail).toMatch(/FREE plan allows 3 seats/);
      expect(await db.invitation.count()).toBe(0);
      expect(mail.sent).toHaveLength(0);
    });

    it('counts pending invitations as seats, so you cannot out-invite the plan', async () => {
      await db.membership.delete({
        where: {
          userId_organizationId: { userId: member.id, organizationId: orgId },
        },
      });
      await invite(owner, 'one@example.com').expect(201); // 2 members + 1 pending = 3
      await invite(owner, 'two@example.com').expect(402);
    });

    it('frees the seat when an invitation is revoked or expires', async () => {
      await db.membership.delete({
        where: {
          userId_organizationId: { userId: member.id, organizationId: orgId },
        },
      });
      const first = await invite(owner, 'one@example.com').expect(201);
      await invite(owner, 'two@example.com').expect(402);

      await http('delete', `/v1/orgs/${orgId}/invitations/${first.body.id}`, {
        bearer: owner.token,
      }).expect(204);
      const second = await invite(owner, 'two@example.com').expect(201);

      await db.invitation.update({
        where: { id: second.body.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await invite(owner, 'three@example.com').expect(201);
    });

    it('lets the PRO plan have more seats', async () => {
      await upgradeToPro();
      for (let i = 0; i < 5; i++)
        await invite(owner, `p${i}@example.com`).expect(201);
    });

    it('lets simultaneous invitations fill the last seat exactly once (repeated rounds)', async () => {
      await db.membership.delete({
        where: {
          userId_organizationId: { userId: member.id, organizationId: orgId },
        },
      });
      // One free seat. Many requests at once, several times over: without the lock on the
      // organisation, the check-then-insert race overshoots in at least one round.
      for (let round = 0; round < 6; round++) {
        await db.invitation.deleteMany();
        const results = await Promise.all(
          Array.from({ length: 12 }, (_u, i) =>
            invite(owner, `race${round}-${i}@example.com`),
          ),
        );
        const created = results.filter((r) => r.status === 201).length;
        const refused = results.filter((r) => r.status === 402).length;
        expect({ created, refused }).toEqual({ created: 1, refused: 11 });
        expect(
          await db.invitation.count({ where: { status: 'PENDING' } }),
        ).toBe(1);
      }
    });

    it('lets a member who was invited accept even though the plan is full (the invitation held the seat)', async () => {
      await db.membership.delete({
        where: {
          userId_organizationId: { userId: member.id, organizationId: orgId },
        },
      });
      const { token } = await inviteAndGetToken('joiner@example.com');
      const joiner = await createAuthedUser(app, db, 'joiner@example.com');
      await accept(joiner, token).expect(200);
      expect(
        await db.membership.count({ where: { organizationId: orgId } }),
      ).toBe(3);
    });
  });

  describe('listing', () => {
    it('shows owners and admins every invitation, newest first, with expired ones marked', async () => {
      const a = await invite(owner, 'a@example.com').expect(201);
      const b = await invite(owner, 'b@example.com', 'ADMIN').expect(201);
      await db.invitation.update({
        where: { id: a.body.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await http('get', `/v1/orgs/${orgId}/invitations`, {
        bearer: admin.token,
      }).expect(200);
      expect(
        res.body.map((i: { email: string; status: string }) => [
          i.email,
          i.status,
        ]),
      ).toEqual([
        ['b@example.com', 'PENDING'],
        ['a@example.com', 'EXPIRED'],
      ]);
      expect(b.body.role).toBe('ADMIN');
    });

    it('is hidden from members (403), outsiders (404) and anonymous callers (401)', async () => {
      await http('get', `/v1/orgs/${orgId}/invitations`, {
        bearer: member.token,
      }).expect(403);
      await http('get', `/v1/orgs/${orgId}/invitations`, {
        bearer: outsider.token,
      }).expect(404);
      await http('get', `/v1/orgs/${orgId}/invitations`).expect(401);
    });

    it('never shows another organisation’s invitations', async () => {
      const other = await createOrgWith(db, 'other', [
        { user: outsider, role: 'OWNER' },
      ]);
      await db.subscription.update({
        where: { organizationId: other.id },
        data: { plan: 'PRO' },
      });
      await invite(outsider, 'secret@example.com', 'MEMBER', other.id).expect(
        201,
      );
      await invite(owner, 'mine@example.com').expect(201);
      const res = await http('get', `/v1/orgs/${orgId}/invitations`, {
        bearer: owner.token,
      }).expect(200);
      expect(res.body.map((i: { email: string }) => i.email)).toEqual([
        'mine@example.com',
      ]);
    });
  });

  describe('previewing a link (no login)', () => {
    it('says what the invitation is for', async () => {
      const { token } = await inviteAndGetToken('newhire@example.com', 'ADMIN');
      const res = await preview(token).expect(200);
      expect(res.body).toMatchObject({
        organizationName: 'acme',
        email: 'newhire@example.com',
        role: 'ADMIN',
      });
      expect(JSON.stringify(res.body)).not.toMatch(/token|hash|invitedBy/i);
    });

    it('answers every bad token the same way: garbage, unknown, expired, revoked, used', async () => {
      const expired = await inviteAndGetToken('expired@example.com');
      await db.invitation.update({
        where: { id: expired.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const revoked = await inviteAndGetToken('revoked@example.com');
      await http('delete', `/v1/orgs/${orgId}/invitations/${revoked.id}`, {
        bearer: owner.token,
      }).expect(204);
      const used = await inviteAndGetToken('used@example.com');
      await accept(
        await createAuthedUser(app, db, 'used@example.com'),
        used.token,
      ).expect(200);

      const bodies = [];
      for (const token of [
        'x'.repeat(43),
        expired.token,
        revoked.token,
        used.token,
      ]) {
        const res = await preview(token).expect(400);
        expect(res.body.code).toBe('INVALID_TOKEN');
        bodies.push(strip(res.body));
      }
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
      await preview('short').expect(400);
    });
  });

  describe('accepting', () => {
    it('adds the invited person with the invited role, once', async () => {
      const { id, token } = await inviteAndGetToken(
        'joiner@example.com',
        'ADMIN',
      );
      const joiner = await createAuthedUser(app, db, 'joiner@example.com');

      const res = await accept(joiner, token).expect(200);
      expect(res.body).toMatchObject({
        organizationId: orgId,
        name: 'acme',
        slug: 'acme',
        role: 'ADMIN',
      });

      expect(
        (await db.invitation.findUniqueOrThrow({ where: { id } })).status,
      ).toBe('ACCEPTED');
      const membership = await db.membership.findUniqueOrThrow({
        where: {
          userId_organizationId: { userId: joiner.id, organizationId: orgId },
        },
      });
      expect(membership.role).toBe('ADMIN');

      // They are in, immediately, with the same token.
      await http('get', `/v1/orgs/${orgId}`, { bearer: joiner.token }).expect(
        200,
      );
      await accept(joiner, token).expect(400); // the link is single use
    });

    it('gives a MEMBER invitation only member powers', async () => {
      const { token } = await inviteAndGetToken('joiner@example.com', 'MEMBER');
      const joiner = await createAuthedUser(app, db, 'joiner@example.com');
      await accept(joiner, token).expect(200);
      await invite(joiner, 'x@example.com').expect(403);
    });

    it('works for a brand-new account created through the real sign-up flow', async () => {
      const { token } = await inviteAndGetToken('fresh@example.com');
      const reg = await http('post', '/v1/auth/register', {
        body: {
          email: 'fresh@example.com',
          password: 'a long passphrase',
          name: 'Fresh',
        },
      }).expect(201);
      await accept({ token: reg.body.accessToken } as TestUser, token).expect(
        200,
      );
      const me = await http('get', '/v1/auth/me', {
        bearer: reg.body.accessToken,
      }).expect(200);
      expect(me.body.memberships).toEqual([
        expect.objectContaining({ organizationId: orgId, role: 'MEMBER' }),
      ]);
    });

    it('refuses someone whose account email is different, and leaves the invitation usable', async () => {
      const { id, token } = await inviteAndGetToken('intended@example.com');
      const res = await accept(outsider, token).expect(400);
      expect(res.body.code).toBe('INVALID_TOKEN');
      expect(
        (await db.invitation.findUniqueOrThrow({ where: { id } })).status,
      ).toBe('PENDING');
      expect(
        await db.membership.count({ where: { userId: outsider.id } }),
      ).toBe(0);

      // The same answer as for a token that does not exist at all.
      const unknown = await accept(outsider, 'y'.repeat(43)).expect(400);
      expect(strip(unknown.body)).toEqual(strip(res.body));

      // The intended person can still use it.
      await accept(
        await createAuthedUser(app, db, 'intended@example.com'),
        token,
      ).expect(200);
    });

    it('requires being logged in', async () => {
      const { token } = await inviteAndGetToken('joiner@example.com');
      await accept(null, token).expect(401);
    });

    it('refuses expired and revoked invitations', async () => {
      const expired = await inviteAndGetToken('exp@example.com');
      await db.invitation.update({
        where: { id: expired.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await accept(
        await createAuthedUser(app, db, 'exp@example.com'),
        expired.token,
      ).expect(400);

      const revoked = await inviteAndGetToken('rev@example.com');
      await http('delete', `/v1/orgs/${orgId}/invitations/${revoked.id}`, {
        bearer: owner.token,
      }).expect(204);
      await accept(
        await createAuthedUser(app, db, 'rev@example.com'),
        revoked.token,
      ).expect(400);
    });

    it('lets exactly one of two simultaneous accepts through', async () => {
      const { token } = await inviteAndGetToken('joiner@example.com');
      const joiner = await createAuthedUser(app, db, 'joiner@example.com');
      const results = await Promise.all([
        accept(joiner, token),
        accept(joiner, token),
      ]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 400,
      ]);
      expect(await db.membership.count({ where: { userId: joiner.id } })).toBe(
        1,
      );
    });

    it('answers 409 to someone who is already a member, without burning the invitation', async () => {
      const { id, token } = await inviteAndGetToken('joiner@example.com');
      const joiner = await createAuthedUser(app, db, 'joiner@example.com');
      await db.membership.create({
        data: { userId: joiner.id, organizationId: orgId, role: 'MEMBER' },
      });
      const res = await accept(joiner, token).expect(409);
      expect(res.body.detail).toMatch(/already a member/);
      expect(
        (await db.invitation.findUniqueOrThrow({ where: { id } })).status,
      ).toBe('PENDING');
    });

    it('does not turn an invitation for one organisation into access to another', async () => {
      const other = await createOrgWith(db, 'other', [
        { user: outsider, role: 'OWNER' },
      ]);
      const { token } = await inviteAndGetToken('joiner@example.com');
      const joiner = await createAuthedUser(app, db, 'joiner@example.com');
      await accept(joiner, token).expect(200);
      await http('get', `/v1/orgs/${other.id}`, {
        bearer: joiner.token,
      }).expect(404);
    });
  });

  describe('re-sending', () => {
    it('issues a new link, kills the old one, and extends the expiry', async () => {
      const { id, token: oldToken } =
        await inviteAndGetToken('joiner@example.com');
      await db.invitation.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() + DAY) },
      });
      mail.clear();

      const res = await http(
        'post',
        `/v1/orgs/${orgId}/invitations/${id}/resend`,
        { bearer: admin.token },
      ).expect(200);
      await background.drain();
      const newToken = mail.lastToken('joiner@example.com');

      expect(newToken).not.toBe(oldToken);
      expect(
        (new Date(res.body.expiresAt).getTime() - Date.now()) / DAY,
      ).toBeGreaterThan(6.9);
      await preview(oldToken).expect(400);
      await preview(newToken).expect(200);
      const joiner = await createAuthedUser(app, db, 'joiner@example.com');
      await accept(joiner, oldToken).expect(400);
      await accept(joiner, newToken).expect(200);
    });

    it('revives an expired invitation, if there is room', async () => {
      const { id } = await inviteAndGetToken('late@example.com');
      await db.invitation.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const res = await http(
        'post',
        `/v1/orgs/${orgId}/invitations/${id}/resend`,
        { bearer: owner.token },
      ).expect(200);
      expect(res.body.status).toBe('PENDING');
    });

    it('does not revive an expired invitation on a full plan (402)', async () => {
      const { id } = await inviteAndGetToken('late@example.com');
      await db.invitation.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await db.subscription.update({
        where: { organizationId: orgId },
        data: { plan: 'FREE' },
      });
      await http('post', `/v1/orgs/${orgId}/invitations/${id}/resend`, {
        bearer: owner.token,
      }).expect(402);
    });

    it('refuses accepted and revoked invitations (409), unknown ids (404) and members (403)', async () => {
      const accepted = await inviteAndGetToken('acc@example.com');
      await accept(
        await createAuthedUser(app, db, 'acc@example.com'),
        accepted.token,
      ).expect(200);
      const revoked = await inviteAndGetToken('rev@example.com');
      await http('delete', `/v1/orgs/${orgId}/invitations/${revoked.id}`, {
        bearer: owner.token,
      }).expect(204);
      const live = await inviteAndGetToken('live@example.com');

      const resend = (actor: TestUser, id: string) =>
        http('post', `/v1/orgs/${orgId}/invitations/${id}/resend`, {
          bearer: actor.token,
        });
      await resend(owner, accepted.id).expect(409);
      await resend(owner, revoked.id).expect(409);
      await resend(owner, '0198a2b4-5d6e-7f80-9a1b-2c3d4e5f6a7b').expect(404);
      await resend(owner, 'not-a-uuid').expect(404);
      await resend(member, live.id).expect(403);
    });

    it('cannot touch another organisation’s invitation', async () => {
      const other = await createOrgWith(db, 'other', [
        { user: outsider, role: 'OWNER' },
      ]);
      await db.subscription.update({
        where: { organizationId: other.id },
        data: { plan: 'PRO' },
      });
      const theirs = await invite(
        outsider,
        'theirs@example.com',
        'MEMBER',
        other.id,
      ).expect(201);
      await http(
        'post',
        `/v1/orgs/${orgId}/invitations/${theirs.body.id}/resend`,
        { bearer: owner.token },
      ).expect(404);
      await http('delete', `/v1/orgs/${orgId}/invitations/${theirs.body.id}`, {
        bearer: owner.token,
      }).expect(404);
      expect(
        (
          await db.invitation.findUniqueOrThrow({
            where: { id: theirs.body.id },
          })
        ).status,
      ).toBe('PENDING');
    });
  });

  describe('revoking', () => {
    it('cancels the invitation and its link, and is safe to repeat', async () => {
      const { id, token } = await inviteAndGetToken('joiner@example.com');
      const del = () =>
        http('delete', `/v1/orgs/${orgId}/invitations/${id}`, {
          bearer: admin.token,
        });
      await del().expect(204);
      await del().expect(204);
      expect(
        (await db.invitation.findUniqueOrThrow({ where: { id } })).status,
      ).toBe('REVOKED');
      await preview(token).expect(400);
    });

    it('cannot undo an accepted invitation (409), and members cannot revoke (403)', async () => {
      const { id, token } = await inviteAndGetToken('joiner@example.com');
      await http('delete', `/v1/orgs/${orgId}/invitations/${id}`, {
        bearer: member.token,
      }).expect(403);
      await accept(
        await createAuthedUser(app, db, 'joiner@example.com'),
        token,
      ).expect(200);
      await http('delete', `/v1/orgs/${orgId}/invitations/${id}`, {
        bearer: owner.token,
      }).expect(409);
    });
  });

  describe('deleting the organisation', () => {
    it('removes its invitations with it, and their links stop working', async () => {
      const { token } = await inviteAndGetToken('joiner@example.com');
      await http('delete', `/v1/orgs/${orgId}`, { bearer: owner.token }).expect(
        204,
      );
      expect(await db.invitation.count()).toBe(0);
      await preview(token).expect(400);
    });
  });
});
