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

const GHOST = '0198a2b4-5d6e-7f80-9a1b-2c3d4e5f6a7b';
const strip = ({ requestId: _id, ...rest }: Record<string, unknown>) => rest;

describe('clients (HTTP + real Postgres)', () => {
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
  let otherOrgId: string;
  const base = () => `/v1/orgs/${orgId}/clients`;

  const create = (actor: TestUser, body: object, id = orgId) =>
    http('post', `/v1/orgs/${id}/clients`, { bearer: actor.token, body });

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
    ({ id: otherOrgId } = await createOrgWith(db, 'other', [
      { user: outsider, role: 'OWNER' },
    ]));
  });

  describe('creating', () => {
    it('lets owners and admins create a client; the organisation comes from the URL, never the body', async () => {
      const res = await create(owner, {
        name: '  Northwind  ',
        email: ' Billing@Northwind.EXAMPLE ',
      }).expect(201);
      expect(res.body).toMatchObject({
        name: 'Northwind',
        email: 'billing@northwind.example',
      });
      expect(res.body).not.toHaveProperty('organizationId');
      await create(admin, { name: 'B', email: 'b@b.example' }).expect(201);
      expect(await db.client.count({ where: { organizationId: orgId } })).toBe(
        2,
      );
    });

    it('keeps members read-only (403), outsiders out (404), anonymous callers out (401)', async () => {
      const body = { name: 'X', email: 'x@x.example' };
      await create(member, body).expect(403);
      await create(outsider, body).expect(404);
      await http('post', base(), { body }).expect(401);
      expect(await db.client.count()).toBe(0);
    });

    it('rejects a duplicate email in the same organisation (409), ignoring case', async () => {
      await create(owner, { name: 'A', email: 'dup@x.example' }).expect(201);
      const res = await create(admin, {
        name: 'B',
        email: 'DUP@x.example',
      }).expect(409);
      expect(res.body.code).toBe('CONFLICT');
      expect(await db.client.count()).toBe(1);
    });

    it('allows the same email in a different organisation', async () => {
      await create(owner, { name: 'A', email: 'same@x.example' }).expect(201);
      await create(
        outsider,
        { name: 'A', email: 'same@x.example' },
        otherOrgId,
      ).expect(201);
    });

    it.each([
      ['an empty name', { name: '', email: 'a@a.example' }],
      ['a blank name', { name: '   ', email: 'a@a.example' }],
      ['a 101-character name', { name: 'x'.repeat(101), email: 'a@a.example' }],
      ['an invalid email', { name: 'A', email: 'nope' }],
      ['a missing email', { name: 'A' }],
      [
        'organizationId in the body',
        { name: 'A', email: 'a@a.example', organizationId: GHOST },
      ],
      ['an id in the body', { name: 'A', email: 'a@a.example', id: GHOST }],
    ])('rejects %s with 400 and creates nothing', async (_label, body) => {
      const res = await create(owner, body).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(await db.client.count()).toBe(0);
    });
  });

  describe('reading', () => {
    it('lists A to Z ignoring case ("alpha" before "Charlie"), for any member, without organizationId', async () => {
      for (const name of ['Charlie', 'alpha', 'Bravo', 'delta']) {
        await create(owner, {
          name,
          email: `${name.toLowerCase()}@x.example`,
        }).expect(201);
      }
      const res = await http('get', base(), { bearer: member.token }).expect(
        200,
      );
      expect(res.body.data.map((c: { name: string }) => c.name)).toEqual([
        'alpha',
        'Bravo',
        'Charlie',
        'delta',
      ]);
      expect(res.body.nextCursor).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain('organizationId');
    });

    it('pages through everything exactly once, in order, with no duplicates or gaps', async () => {
      for (let i = 0; i < 25; i++) {
        await db.client.create({
          data: {
            organizationId: orgId,
            name: `Client ${String(i).padStart(2, '0')}`,
            email: `c${i}@x.example`,
          },
        });
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: {
          body: {
            data: Array<{ id: string; name: string }>;
            nextCursor: string | null;
          };
        } = await http(
          'get',
          `${base()}?limit=10${cursor ? `&cursor=${cursor}` : ''}`,
          {
            bearer: owner.token,
          },
        ).expect(200);
        seen.push(...res.body.data.map((c) => c.name));
        cursor = res.body.nextCursor;
        pages++;
      } while (cursor && pages < 10);

      expect(pages).toBe(3);
      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);
      expect(seen).toEqual([...seen].sort((a, b) => a.localeCompare(b, 'en')));
    });

    it('is not thrown off by rows added or deleted between pages (keyset, not offset)', async () => {
      for (let i = 0; i < 6; i++) {
        await db.client.create({
          data: {
            organizationId: orgId,
            name: `N${i}`,
            email: `n${i}@x.example`,
          },
        });
      }
      const first = await http('get', `${base()}?limit=3`, {
        bearer: owner.token,
      }).expect(200);
      expect(first.body.data.map((c: { name: string }) => c.name)).toEqual([
        'N0',
        'N1',
        'N2',
      ]);

      // Delete the row the cursor points at, and add one that sorts before it.
      await db.client.delete({ where: { id: first.body.data[2].id } });
      await db.client.create({
        data: { organizationId: orgId, name: 'A-new', email: 'new@x.example' },
      });

      const second = await http(
        'get',
        `${base()}?limit=3&cursor=${first.body.nextCursor}`,
        {
          bearer: owner.token,
        },
      ).expect(200);
      expect(second.body.data.map((c: { name: string }) => c.name)).toEqual([
        'N3',
        'N4',
        'N5',
      ]);
    });

    it('searches name and email, case-insensitively, treating wildcards literally', async () => {
      await db.client.createMany({
        data: [
          { organizationId: orgId, name: 'Northwind', email: 'a@nw.example' },
          {
            organizationId: orgId,
            name: 'Contoso',
            email: 'hello@northern.example',
          },
          { organizationId: orgId, name: '100% Real', email: 'p@x.example' },
          { organizationId: orgId, name: 'Fabrikam', email: 'f@x.example' },
        ],
      });
      const names = async (q: string) =>
        (
          await http('get', `${base()}?q=${encodeURIComponent(q)}`, {
            bearer: owner.token,
          }).expect(200)
        ).body.data
          .map((c: { name: string }) => c.name)
          .sort();
      expect(await names('NORTH')).toEqual(['Contoso', 'Northwind']);
      expect(await names('fabri')).toEqual(['Fabrikam']);
      expect(await names('%')).toEqual(['100% Real']); // "%" is not "match everything"
      expect(await names('_')).toEqual([]); // "_" is not "any one character"
      expect(await names('zzz')).toEqual([]);
    });

    it('rejects a bad limit and a bad cursor with 400, and clamps a huge limit', async () => {
      await http('get', `${base()}?limit=0`, { bearer: owner.token }).expect(
        400,
      );
      await http('get', `${base()}?limit=abc`, { bearer: owner.token }).expect(
        400,
      );
      const bad = await http('get', `${base()}?cursor=garbage`, {
        bearer: owner.token,
      }).expect(400);
      expect(bad.body.errors).toEqual([
        { field: 'cursor', message: 'is not a valid cursor' },
      ]);
      await http('get', `${base()}?limit=100000`, {
        bearer: owner.token,
      }).expect(200);
      await http('get', `${base()}?sort=email`, { bearer: owner.token }).expect(
        400,
      ); // unknown params are refused
    });

    it('never leaks across organisations, even with another organisation’s cursor', async () => {
      await db.client.createMany({
        data: [
          { organizationId: orgId, name: 'Mine1', email: 'm1@x.example' },
          { organizationId: orgId, name: 'Mine2', email: 'm2@x.example' },
          {
            organizationId: otherOrgId,
            name: 'Secret1',
            email: 's1@x.example',
          },
          {
            organizationId: otherOrgId,
            name: 'Secret2',
            email: 's2@x.example',
          },
        ],
      });
      const theirs = await http(
        'get',
        `/v1/orgs/${otherOrgId}/clients?limit=1`,
        {
          bearer: outsider.token,
        },
      ).expect(200);
      const res = await http(
        'get',
        `${base()}?cursor=${theirs.body.nextCursor}`,
        {
          bearer: owner.token,
        },
      ).expect(200);
      const names = res.body.data.map((c: { name: string }) => c.name);
      expect(
        names.every(
          (n: string) =>
            n.startsWith('Mine') || n.startsWith('Secret') === false,
        ),
      ).toBe(true);
      expect(names.some((n: string) => n.startsWith('Secret'))).toBe(false);
    });

    it('gets one client; a foreign, unknown or malformed id is the same 404', async () => {
      const mine = await create(owner, {
        name: 'Mine',
        email: 'mine@x.example',
      }).expect(201);
      const theirs = await db.client.create({
        data: {
          organizationId: otherOrgId,
          name: 'Theirs',
          email: 't@x.example',
        },
      });
      await http('get', `${base()}/${mine.body.id}`, {
        bearer: member.token,
      }).expect(200);
      const foreign = await http('get', `${base()}/${theirs.id}`, {
        bearer: owner.token,
      }).expect(404);
      const unknown = await http('get', `${base()}/${GHOST}`, {
        bearer: owner.token,
      }).expect(404);
      const malformed = await http('get', `${base()}/not-a-uuid`, {
        bearer: owner.token,
      }).expect(404);
      expect(strip(foreign.body)).toEqual(strip(unknown.body));
      expect(strip(malformed.body)).toEqual(strip(unknown.body));
    });
  });

  describe('changing and deleting', () => {
    let clientId: string;
    beforeEach(async () => {
      clientId = (
        await create(owner, { name: 'Old', email: 'old@x.example' }).expect(201)
      ).body.id;
    });
    const patch = (actor: TestUser, body: object, id = clientId) =>
      http('patch', `${base()}/${id}`, { bearer: actor.token, body });

    it('lets owners and admins change name and email (partially), but not members', async () => {
      const res = await patch(admin, { name: 'New' }).expect(200);
      expect(res.body).toMatchObject({ name: 'New', email: 'old@x.example' });
      await patch(owner, { email: 'NEW@x.example' }).expect(200);
      expect(
        (await db.client.findUniqueOrThrow({ where: { id: clientId } })).email,
      ).toBe('new@x.example');
      await patch(member, { name: 'X' }).expect(403);
      await patch(outsider, { name: 'X' }).expect(404);
    });

    it('refuses an email that another client already has (409) and fields that cannot change', async () => {
      await create(owner, { name: 'Other', email: 'taken@x.example' }).expect(
        201,
      );
      await patch(owner, { email: 'taken@x.example' }).expect(409);
      await patch(owner, { organizationId: otherOrgId }).expect(400);
      await patch(owner, { id: GHOST }).expect(400);
      await patch(owner, { email: 'nope' }).expect(400);
    });

    it('cannot change a foreign client, and says 404', async () => {
      const theirs = await db.client.create({
        data: {
          organizationId: otherOrgId,
          name: 'Theirs',
          email: 't@x.example',
        },
      });
      await patch(owner, { name: 'hacked' }, theirs.id).expect(404);
      expect(
        (await db.client.findUniqueOrThrow({ where: { id: theirs.id } })).name,
      ).toBe('Theirs');
    });

    it('deletes a client with no invoices (owner, admin), not for members', async () => {
      await http('delete', `${base()}/${clientId}`, {
        bearer: member.token,
      }).expect(403);
      await http('delete', `${base()}/${clientId}`, {
        bearer: admin.token,
      }).expect(204);
      expect(await db.client.count()).toBe(0);
      await http('delete', `${base()}/${clientId}`, {
        bearer: admin.token,
      }).expect(404);
    });

    it('refuses to delete a client that has invoices, even deleted ones (409)', async () => {
      const invoice = await db.invoice.create({
        data: {
          organizationId: orgId,
          clientId,
          number: 'INV-0001',
          totalCents: 100,
        },
      });
      const res = await http('delete', `${base()}/${clientId}`, {
        bearer: owner.token,
      }).expect(409);
      expect(res.body.detail).toMatch(/has invoices/);
      await db.invoice.update({
        where: { id: invoice.id },
        data: { deletedAt: new Date() },
      });
      await http('delete', `${base()}/${clientId}`, {
        bearer: owner.token,
      }).expect(409);
      expect(await db.client.count()).toBe(1);
    });

    it('cannot delete a foreign client', async () => {
      const theirs = await db.client.create({
        data: {
          organizationId: otherOrgId,
          name: 'Theirs',
          email: 't@x.example',
        },
      });
      await http('delete', `${base()}/${theirs.id}`, {
        bearer: owner.token,
      }).expect(404);
      expect(await db.client.count({ where: { id: theirs.id } })).toBe(1);
    });
  });
});
