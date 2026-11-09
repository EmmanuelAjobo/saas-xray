import type { NestExpressApplication } from '@nestjs/platform-express';
import type { BackgroundTasks } from '../src/core/background/background-tasks.service.js';
import { PrismaService } from '../src/core/prisma/prisma.service.js';
import type { InvoiceStatus } from '../src/generated/prisma/client.js';
import { createTestApp } from './support/create-test-app.js';
import { resetDb } from './support/db.js';
import type { FakeMailTransport } from './support/fake-mail.js';
import {
  createAuthedUser,
  createHttpClient,
  createOrgWith,
  type TestUser,
} from './support/http-client.js';

const GHOST = '0198a2b4-5d6e-7f80-9a1b-2c3d4e5f6a7b';
const DAY = 86_400_000;
const strip = ({ requestId: _id, ...rest }: Record<string, unknown>) => rest;
const ITEMS = [
  { description: 'Design', quantity: 10, unitPriceCents: 9_500 },
  { description: 'Hosting', quantity: 3, unitPriceCents: 1_200 },
];
const ITEMS_TOTAL = 10 * 9_500 + 3 * 1_200; // 98 600

describe('invoices (HTTP + real Postgres)', () => {
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
  let otherOrgId: string;
  let clientId: string;
  let foreignClientId: string;
  const base = () => `/v1/orgs/${orgId}/invoices`;

  const create = (actor: TestUser, body: object, id = orgId) =>
    http('post', `/v1/orgs/${id}/invoices`, { bearer: actor.token, body });
  const action = (actor: TestUser, id: string, verb: 'send' | 'pay' | 'void') =>
    http('post', `${base()}/${id}/${verb}`, { bearer: actor.token });
  const draft = async (items: object[] = ITEMS) =>
    (await create(owner, { clientId, items }).expect(201)).body as {
      id: string;
      number: string;
    };
  /** An invoice forced into a status (the OVERDUE job does not exist yet). */
  const withStatus = async (status: InvoiceStatus) => {
    const invoice = await draft();
    await db.invoice.update({ where: { id: invoice.id }, data: { status } });
    return invoice;
  };

  beforeAll(async () => {
    ({ app, mail, background } = await createTestApp({
      realDatabase: true,
      env: {
        TRUST_PROXY_HOPS: '1',
        // The burst tests below check CORRECTNESS under concurrency, not speed: a slow
        // machine must not turn a slow answer into a 408 and a false failure.
        REQUEST_TIMEOUT_MS: '60000',
      },
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
    ({ id: otherOrgId } = await createOrgWith(db, 'other', [
      { user: outsider, role: 'OWNER' },
    ]));
    clientId = (
      await db.client.create({
        data: {
          organizationId: orgId,
          name: 'Northwind',
          email: 'billing@northwind.example',
        },
      })
    ).id;
    foreignClientId = (
      await db.client.create({
        data: {
          organizationId: otherOrgId,
          name: 'Theirs',
          email: 'theirs@x.example',
        },
      })
    ).id;
  });

  describe('creating', () => {
    it('creates a DRAFT; the server computes the number and the total', async () => {
      const res = await create(owner, { clientId, items: ITEMS }).expect(201);
      expect(res.body).toMatchObject({
        number: 'INV-0001',
        status: 'DRAFT',
        totalCents: ITEMS_TOTAL,
        currency: 'USD',
        dueDate: null,
        lineItemCount: 2,
        client: {
          id: clientId,
          name: 'Northwind',
          email: 'billing@northwind.example',
        },
      });
      expect(res.body.lineItems).toEqual([
        expect.objectContaining({
          description: 'Design',
          quantity: 10,
          unitPriceCents: 9_500,
          amountCents: 95_000,
        }),
        expect.objectContaining({
          description: 'Hosting',
          quantity: 3,
          unitPriceCents: 1_200,
          amountCents: 3_600,
        }),
      ]);
      expect(res.body).not.toHaveProperty('organizationId');
      expect(res.body).not.toHaveProperty('deletedAt');
    });

    it('lets admins create, but not members (403), outsiders (404) or anonymous callers (401)', async () => {
      await create(admin, { clientId }).expect(201);
      await create(member, { clientId }).expect(403);
      await create(outsider, { clientId }).expect(404);
      await http('post', base(), { body: { clientId } }).expect(401);
      expect(await db.invoice.count()).toBe(1);
    });

    it('allows an empty draft, a custom currency and a due date', async () => {
      const res = await create(owner, {
        clientId,
        currency: 'EUR',
        dueDate: '2027-03-01T00:00:00Z',
      }).expect(201);
      expect(res.body).toMatchObject({
        totalCents: 0,
        lineItemCount: 0,
        lineItems: [],
        currency: 'EUR',
        dueDate: '2027-03-01T00:00:00.000Z',
      });
    });

    it('numbers invoices per organisation, with no gaps and no clashes between organisations', async () => {
      const a1 = await draft();
      const a2 = await draft();
      const b1 = (
        await create(
          outsider,
          { clientId: foreignClientId },
          otherOrgId,
        ).expect(201)
      ).body;
      expect([a1.number, a2.number, b1.number]).toEqual([
        'INV-0001',
        'INV-0002',
        'INV-0001',
      ]);
      expect(
        (await db.organization.findUniqueOrThrow({ where: { id: orgId } }))
          .invoiceSeq,
      ).toBe(2);
    });

    it('gives simultaneous creates unique, consecutive numbers (no duplicates, no gaps)', async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          create(owner, { clientId, items: ITEMS }),
        ),
      );
      // Compared as a whole so a failure shows every status, not just "false".
      expect(results.map((r) => r.status)).toEqual(Array(12).fill(201));
      const numbers = results.map((r) => r.body.number as string).sort();
      expect(numbers).toEqual(
        Array.from(
          { length: 12 },
          (_u, i) => `INV-${String(i + 1).padStart(4, '0')}`,
        ),
      );
    });

    it('a rejected request does not use up a number', async () => {
      await create(owner, { clientId: foreignClientId }).expect(400);
      await create(owner, {
        clientId,
        items: [{ description: 'x', quantity: 0, unitPriceCents: 1 }],
      }).expect(400);
      expect((await draft()).number).toBe('INV-0001');
    });

    it('refuses a client from another organisation or one that does not exist, naming the field', async () => {
      for (const id of [foreignClientId, GHOST]) {
        const res = await create(owner, { clientId: id }).expect(400);
        expect(res.body.errors).toEqual([
          {
            field: 'clientId',
            message: 'must be a client of this organization',
          },
        ]);
      }
      expect(await db.invoice.count()).toBe(0);
    });

    it.each([
      [
        'a zero quantity',
        { description: 'x', quantity: 0, unitPriceCents: 100 },
      ],
      [
        'a negative quantity',
        { description: 'x', quantity: -1, unitPriceCents: 100 },
      ],
      [
        'a fractional quantity',
        { description: 'x', quantity: 1.5, unitPriceCents: 100 },
      ],
      [
        'a negative price',
        { description: 'x', quantity: 1, unitPriceCents: -1 },
      ],
      [
        'a fractional price (cents are whole numbers)',
        { description: 'x', quantity: 1, unitPriceCents: 10.5 },
      ],
      [
        'a price as text',
        { description: 'x', quantity: 1, unitPriceCents: '100' },
      ],
      [
        'a price above 32-bit',
        { description: 'x', quantity: 1, unitPriceCents: 2_147_483_648 },
      ],
      [
        'a quantity above the maximum',
        { description: 'x', quantity: 1_000_001, unitPriceCents: 1 },
      ],
      [
        'an empty description',
        { description: '', quantity: 1, unitPriceCents: 1 },
      ],
      [
        'a description over 200 characters',
        { description: 'x'.repeat(201), quantity: 1, unitPriceCents: 1 },
      ],
      [
        'an unknown field on an item',
        { description: 'x', quantity: 1, unitPriceCents: 1, amountCents: 5 },
      ],
    ])('rejects %s with 400', async (_label, item) => {
      await create(owner, { clientId, items: [item] }).expect(400);
      expect(await db.invoice.count()).toBe(0);
    });

    it('rejects a total that does not fit in 32-bit cents, without storing anything', async () => {
      const res = await create(owner, {
        clientId,
        items: [
          { description: 'big', quantity: 1, unitPriceCents: 2_000_000_000 },
          { description: 'big', quantity: 1, unitPriceCents: 2_000_000_000 },
        ],
      }).expect(400);
      expect(res.body.errors[0]).toEqual({
        field: 'items',
        message: 'the invoice total is too large',
      });
      await create(owner, {
        clientId,
        items: [
          {
            description: 'big',
            quantity: 1_000_000,
            unitPriceCents: 1_000_000,
          },
        ],
      }).expect(400);
      expect(await db.invoice.count()).toBe(0);
    });

    it('rejects too many line items (limit 100 by default)', async () => {
      const items = Array.from({ length: 101 }, () => ({
        description: 'x',
        quantity: 1,
        unitPriceCents: 1,
      }));
      const res = await create(owner, { clientId, items }).expect(400);
      expect(res.body.errors[0].field).toBe('items');
      const ok = Array.from({ length: 100 }, () => ({
        description: 'x',
        quantity: 1,
        unitPriceCents: 1,
      }));
      await create(owner, { clientId, items: ok }).expect(201);
    });

    it('never trusts the client for numbers, totals, status or ownership', async () => {
      for (const extra of [
        { number: 'INV-9999' },
        { totalCents: 1 },
        { status: 'PAID' },
        { organizationId: otherOrgId },
        { deletedAt: null },
        { id: GHOST },
      ]) {
        await create(owner, { clientId, ...extra }).expect(400);
      }
      await create(owner, { clientId, currency: 'usd' }).expect(400);
      await create(owner, { clientId, currency: 'DOLLARS' }).expect(400);
      expect(await db.invoice.count()).toBe(0);
    });

    it('stores a total that always equals the sum of its lines (and the database agrees)', async () => {
      const inv = await draft();
      const row = await db.invoice.findUniqueOrThrow({
        where: { id: inv.id },
        include: { lineItems: true },
      });
      expect(row.totalCents).toBe(
        row.lineItems.reduce((n, l) => n + l.quantity * l.unitPriceCents, 0),
      );
    });
  });

  describe('reading', () => {
    it('lists newest first, without line items but with their count, and hides deleted drafts', async () => {
      const a = await draft();
      const b = await draft([]);
      const c = await draft();
      await http('delete', `${base()}/${c.id}`, { bearer: owner.token }).expect(
        204,
      );

      const res = await http('get', base(), { bearer: member.token }).expect(
        200,
      );
      expect(res.body.data.map((i: { number: string }) => i.number)).toEqual([
        b.number,
        a.number,
      ]);
      expect(res.body.data[1]).toMatchObject({
        lineItemCount: 2,
        totalCents: ITEMS_TOTAL,
      });
      expect(res.body.data[0]).not.toHaveProperty('lineItems');
    });

    it('filters by status, client and invoice number (wildcards literal), and pages', async () => {
      const other = await db.client.create({
        data: {
          organizationId: orgId,
          name: 'Contoso',
          email: 'c@contoso.example',
        },
      });
      await draft();
      const second = await draft();
      await create(owner, { clientId: other.id }).expect(201);
      await db.invoice.update({
        where: { id: second.id },
        data: { status: 'SENT' },
      });

      const numbers = async (query: string) =>
        (
          await http('get', `${base()}?${query}`, {
            bearer: owner.token,
          }).expect(200)
        ).body.data
          .map((i: { number: string }) => i.number)
          .sort();
      expect(await numbers('status=SENT')).toEqual(['INV-0002']);
      expect(await numbers(`clientId=${other.id}`)).toEqual(['INV-0003']);
      expect(await numbers('q=0002')).toEqual(['INV-0002']);
      expect(await numbers('q=%25')).toEqual([]);
      expect(await numbers('limit=2')).toHaveLength(2);
      await http('get', `${base()}?status=NOPE`, {
        bearer: owner.token,
      }).expect(400);
      await http('get', `${base()}?clientId=abc`, {
        bearer: owner.token,
      }).expect(400);

      const first = await http('get', `${base()}?limit=2`, {
        bearer: owner.token,
      }).expect(200);
      const next = await http(
        'get',
        `${base()}?limit=2&cursor=${first.body.nextCursor}`,
        {
          bearer: owner.token,
        },
      ).expect(200);
      expect(next.body.data).toHaveLength(1);
      expect(next.body.nextCursor).toBeNull();
    });

    it('shows one invoice with its lines; a foreign, unknown, malformed or deleted id is the same 404', async () => {
      const mine = await draft();
      const gone = await draft();
      await http('delete', `${base()}/${gone.id}`, {
        bearer: owner.token,
      }).expect(204);
      const theirs = await db.invoice.create({
        data: {
          organizationId: otherOrgId,
          clientId: foreignClientId,
          number: 'INV-0001',
          totalCents: 5,
        },
      });

      const res = await http('get', `${base()}/${mine.id}`, {
        bearer: member.token,
      }).expect(200);
      expect(res.body.lineItems).toHaveLength(2);
      const bodies = [];
      for (const id of [theirs.id, GHOST, 'not-a-uuid', gone.id]) {
        bodies.push(
          JSON.stringify(
            strip(
              (
                await http('get', `${base()}/${id}`, {
                  bearer: owner.token,
                }).expect(404)
              ).body,
            ),
          ),
        );
      }
      expect(new Set(bodies).size).toBe(1);
    });
  });

  describe('editing a DRAFT', () => {
    it('changes fields partially and recomputes the total when items are replaced', async () => {
      const inv = await draft();
      const other = await db.client.create({
        data: {
          organizationId: orgId,
          name: 'Contoso',
          email: 'c@contoso.example',
        },
      });
      const res = await http('patch', `${base()}/${inv.id}`, {
        bearer: admin.token,
        body: {
          clientId: other.id,
          currency: 'GBP',
          items: [
            { description: 'One thing', quantity: 2, unitPriceCents: 500 },
          ],
        },
      }).expect(200);
      expect(res.body).toMatchObject({
        number: inv.number,
        totalCents: 1_000,
        currency: 'GBP',
        lineItemCount: 1,
        client: { id: other.id },
      });
      expect(
        await db.invoiceLineItem.count({ where: { invoiceId: inv.id } }),
      ).toBe(1);
    });

    it('leaves the lines alone when `items` is not sent, and can clear them with an empty list', async () => {
      const inv = await draft();
      const kept = await http('patch', `${base()}/${inv.id}`, {
        bearer: owner.token,
        body: { dueDate: '2027-05-05T00:00:00Z' },
      }).expect(200);
      expect(kept.body).toMatchObject({
        totalCents: ITEMS_TOTAL,
        lineItemCount: 2,
      });
      const cleared = await http('patch', `${base()}/${inv.id}`, {
        bearer: owner.token,
        body: { items: [], dueDate: null },
      }).expect(200);
      expect(cleared.body).toMatchObject({
        totalCents: 0,
        lineItemCount: 0,
        dueDate: null,
      });
    });

    it('refuses invalid edits atomically: nothing is half-applied', async () => {
      const inv = await draft();
      await http('patch', `${base()}/${inv.id}`, {
        bearer: owner.token,
        body: {
          currency: 'GBP',
          items: [{ description: 'x', quantity: 0, unitPriceCents: 1 }],
        },
      }).expect(400);
      await http('patch', `${base()}/${inv.id}`, {
        bearer: owner.token,
        body: { currency: 'GBP', clientId: foreignClientId },
      }).expect(400);
      const row = await db.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      expect(row).toMatchObject({
        currency: 'USD',
        clientId,
        totalCents: ITEMS_TOTAL,
      });
      expect(
        await db.invoiceLineItem.count({ where: { invoiceId: inv.id } }),
      ).toBe(2);
    });

    it.each(['SENT', 'PAID', 'OVERDUE', 'VOID'] as const)(
      'refuses to edit a %s invoice (409)',
      async (status) => {
        const inv = await withStatus(status);
        const res = await http('patch', `${base()}/${inv.id}`, {
          bearer: owner.token,
          body: { currency: 'GBP' },
        }).expect(409);
        expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
        expect(res.body.detail).toContain(status);
        expect(
          (await db.invoice.findUniqueOrThrow({ where: { id: inv.id } }))
            .currency,
        ).toBe('USD');
      },
    );

    it('is limited to owners and admins; foreign and unknown invoices are 404', async () => {
      const inv = await draft();
      await http('patch', `${base()}/${inv.id}`, {
        bearer: member.token,
        body: { currency: 'GBP' },
      }).expect(403);
      await http('patch', `${base()}/${inv.id}`, {
        bearer: outsider.token,
        body: { currency: 'GBP' },
      }).expect(404);
      const theirs = await db.invoice.create({
        data: {
          organizationId: otherOrgId,
          clientId: foreignClientId,
          number: 'INV-0009',
          totalCents: 5,
        },
      });
      await http('patch', `${base()}/${theirs.id}`, {
        bearer: owner.token,
        body: { currency: 'GBP' },
      }).expect(404);
      await http('patch', `${base()}/${GHOST}`, {
        bearer: owner.token,
        body: { currency: 'GBP' },
      }).expect(404);
      expect(
        (await db.invoice.findUniqueOrThrow({ where: { id: theirs.id } }))
          .currency,
      ).toBe('USD');
    });

    it('lets an edit and a send race: exactly one coherent outcome', async () => {
      for (let round = 0; round < 4; round++) {
        const inv = await draft();
        const [edit, sent] = await Promise.all([
          http('patch', `${base()}/${inv.id}`, {
            bearer: owner.token,
            body: {
              items: [
                { description: 'new', quantity: 1, unitPriceCents: 7_000 },
              ],
            },
          }),
          action(owner, inv.id, 'send'),
        ]);
        const row = await db.invoice.findUniqueOrThrow({
          where: { id: inv.id },
          include: { lineItems: true },
        });
        // Whatever the interleaving, the stored total matches the stored lines.
        expect(row.totalCents).toBe(
          row.lineItems.reduce((n, l) => n + l.quantity * l.unitPriceCents, 0),
        );
        expect([200, 409]).toContain(edit.status);
        expect([200, 409]).toContain(sent.status);
        if (sent.status === 200) expect(row.status).toBe('SENT');
      }
    });
  });

  describe('deleting', () => {
    it('soft-deletes a DRAFT (the row remains), and only once', async () => {
      const inv = await draft();
      await http('delete', `${base()}/${inv.id}`, {
        bearer: admin.token,
      }).expect(204);
      expect(
        (await db.invoice.findUniqueOrThrow({ where: { id: inv.id } }))
          .deletedAt,
      ).not.toBeNull();
      await http('delete', `${base()}/${inv.id}`, {
        bearer: admin.token,
      }).expect(404);
    });

    it.each(['SENT', 'PAID', 'OVERDUE', 'VOID'] as const)(
      'never deletes a %s invoice (409): financial records are voided, not erased',
      async (status) => {
        const inv = await withStatus(status);
        await http('delete', `${base()}/${inv.id}`, {
          bearer: owner.token,
        }).expect(409);
        expect(
          (await db.invoice.findUniqueOrThrow({ where: { id: inv.id } }))
            .deletedAt,
        ).toBeNull();
      },
    );

    it('is limited to owners and admins; a foreign invoice is 404', async () => {
      const inv = await draft();
      await http('delete', `${base()}/${inv.id}`, {
        bearer: member.token,
      }).expect(403);
      const theirs = await db.invoice.create({
        data: {
          organizationId: otherOrgId,
          clientId: foreignClientId,
          number: 'INV-0009',
          totalCents: 5,
        },
      });
      await http('delete', `${base()}/${theirs.id}`, {
        bearer: owner.token,
      }).expect(404);
      expect(
        (await db.invoice.findUniqueOrThrow({ where: { id: theirs.id } }))
          .deletedAt,
      ).toBeNull();
    });
  });

  describe('the state machine', () => {
    // [starting status, send, pay, void] → expected HTTP status for each action
    it.each([
      ['DRAFT', 200, 409, 200],
      ['SENT', 409, 200, 200],
      ['OVERDUE', 409, 200, 200],
      ['PAID', 409, 409, 409],
      ['VOID', 409, 409, 409],
    ] as const)(
      '%s: send→%d pay→%d void→%d',
      async (from, send, pay, voidStatus) => {
        const results: number[] = [];
        for (const verb of ['send', 'pay', 'void'] as const) {
          const inv = await withStatus(from);
          results.push((await action(owner, inv.id, verb)).status);
        }
        expect(results).toEqual([send, pay, voidStatus]);
      },
    );

    it('lands in the right status after each legal move', async () => {
      const a = await draft();
      expect((await action(owner, a.id, 'send').expect(200)).body.status).toBe(
        'SENT',
      );
      expect((await action(owner, a.id, 'pay').expect(200)).body.status).toBe(
        'PAID',
      );
      const b = await draft();
      expect((await action(admin, b.id, 'void').expect(200)).body.status).toBe(
        'VOID',
      );
      const c = await withStatus('OVERDUE');
      expect((await action(owner, c.id, 'pay').expect(200)).body.status).toBe(
        'PAID',
      );
    });

    it('explains an illegal move with the current status (409 INVALID_STATE_TRANSITION)', async () => {
      const inv = await withStatus('PAID');
      const res = await action(owner, inv.id, 'void').expect(409);
      expect(res.body).toMatchObject({
        status: 409,
        code: 'INVALID_STATE_TRANSITION',
      });
      expect(res.body.detail).toContain('PAID');
    });

    it('limits actions by role: members cannot send, pay or void (403); outsiders get 404', async () => {
      const inv = await draft();
      for (const verb of ['send', 'pay', 'void'] as const) {
        await action(member, inv.id, verb).expect(403);
        await action(outsider, inv.id, verb).expect(404);
      }
      expect(
        (await db.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status,
      ).toBe('DRAFT');
    });

    it('answers 404 for an unknown, deleted or foreign invoice on every action', async () => {
      const gone = await draft();
      await http('delete', `${base()}/${gone.id}`, {
        bearer: owner.token,
      }).expect(204);
      const theirs = await db.invoice.create({
        data: {
          organizationId: otherOrgId,
          clientId: foreignClientId,
          number: 'INV-0009',
          totalCents: 5,
          status: 'SENT',
        },
      });
      for (const verb of ['send', 'pay', 'void'] as const) {
        for (const id of [GHOST, gone.id, theirs.id, 'not-a-uuid']) {
          await action(owner, id, verb).expect(404);
        }
      }
      expect(
        (await db.invoice.findUniqueOrThrow({ where: { id: theirs.id } }))
          .status,
      ).toBe('SENT');
    });

    it('lets exactly one of two simultaneous sends win (and one email goes out)', async () => {
      const inv = await draft();
      const results = await Promise.all([
        action(owner, inv.id, 'send'),
        action(admin, inv.id, 'send'),
      ]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 409,
      ]);
      await background.drain();
      expect(mail.to('billing@northwind.example')).toHaveLength(1);
    });

    it('lets pay and void race: exactly one wins and the result is consistent', async () => {
      for (let round = 0; round < 4; round++) {
        const inv = await withStatus('SENT');
        const [pay, voidRes] = await Promise.all([
          action(owner, inv.id, 'pay'),
          action(owner, inv.id, 'void'),
        ]);
        expect([pay.status, voidRes.status].sort((a, b) => a - b)).toEqual([
          200, 409,
        ]);
        const status = (
          await db.invoice.findUniqueOrThrow({ where: { id: inv.id } })
        ).status;
        expect(status).toBe(pay.status === 200 ? 'PAID' : 'VOID');
      }
    });
  });

  describe('sending', () => {
    it('sets a due date when none was given, and emails the client', async () => {
      const inv = await draft();
      const res = await action(owner, inv.id, 'send').expect(200);
      expect(res.body.status).toBe('SENT');
      const days = (new Date(res.body.dueDate).getTime() - Date.now()) / DAY;
      expect(days).toBeGreaterThan(13.9);
      expect(days).toBeLessThanOrEqual(14);

      await background.drain();
      const [email] = mail.to('billing@northwind.example');
      expect(email?.subject).toBe('Invoice INV-0001 from acme');
      expect(email?.text).toContain('$986.00');
      expect(email?.text).toContain('INV-0001');
    });

    it('keeps a due date that was set', async () => {
      const inv = (
        await create(owner, {
          clientId,
          items: ITEMS,
          dueDate: '2030-01-15T00:00:00Z',
        }).expect(201)
      ).body;
      const res = await action(owner, inv.id, 'send').expect(200);
      expect(res.body.dueDate).toBe('2030-01-15T00:00:00.000Z');
    });

    it('refuses an empty invoice or a zero total, and the invoice stays a DRAFT', async () => {
      const empty = await draft([]);
      const zero = await draft([
        { description: 'free', quantity: 1, unitPriceCents: 0 },
      ]);
      for (const inv of [empty, zero]) {
        const res = await action(owner, inv.id, 'send').expect(409);
        expect(res.body.detail).toMatch(/at least one line item/);
        expect(
          (await db.invoice.findUniqueOrThrow({ where: { id: inv.id } }))
            .status,
        ).toBe('DRAFT');
      }
      await background.drain();
      expect(mail.sent).toHaveLength(0);
    });

    it('still succeeds when the mail provider is down', async () => {
      mail.failWith = new Error('SMTP connection refused');
      const inv = await draft();
      await action(owner, inv.id, 'send').expect(200);
      await background.drain();
      expect(
        (await db.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status,
      ).toBe('SENT');
    });

    it('sends no real email from a demo organisation', async () => {
      await db.organization.update({
        where: { id: orgId },
        data: { isDemo: true },
      });
      const inv = await draft();
      await action(owner, inv.id, 'send').expect(200);
      await background.drain();
      expect(mail.sent).toHaveLength(0);
    });

    it('survives an unusual currency code when formatting the email', async () => {
      const inv = (
        await create(owner, { clientId, currency: 'XXX', items: ITEMS }).expect(
          201,
        )
      ).body;
      await action(owner, inv.id, 'send').expect(200);
      await background.drain();
      expect(mail.to('billing@northwind.example')).toHaveLength(1);
    });
  });

  describe('clients and invoices together', () => {
    it('a client with invoices cannot be deleted, until its invoices are gone', async () => {
      const inv = await draft();
      await http('delete', `/v1/orgs/${orgId}/clients/${clientId}`, {
        bearer: owner.token,
      }).expect(409);
      await http('delete', `${base()}/${inv.id}`, {
        bearer: owner.token,
      }).expect(204);
      // Soft-deleted drafts still reference the client, so it still cannot be deleted.
      await http('delete', `/v1/orgs/${orgId}/clients/${clientId}`, {
        bearer: owner.token,
      }).expect(409);
    });
  });
});
