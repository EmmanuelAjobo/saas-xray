import type { NestExpressApplication } from '@nestjs/platform-express';
import { RequestContextService } from '../src/core/context/request-context.service.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/core/prisma/prisma.service.js';
import {
  TenantContextMissingError,
  TenantViolationError,
} from '../src/core/prisma/tenant-errors.js';
import { createTenantClient } from '../src/core/prisma/tenant-client.js';
import { TenantPrismaService } from '../src/core/prisma/tenant-prisma.service.js';
import { createTestApp } from './support/create-test-app.js';
import { createTestDb, resetDb } from './support/db.js';
import { testDatabaseUrl } from './support/test-database-url.js';

/**
 * The tenant-scoped data layer against a real database. Two organisations, each with data;
 * acting as A, nothing of B may be visible or changeable, whatever the query says.
 */
describe('tenant-scoped Prisma client (real Postgres)', () => {
  let base: PrismaClient;
  let current: string | undefined;
  let db: ReturnType<typeof createTenantClient>;

  interface World {
    id: string;
    memberId: string;
    clientId: string;
    taskId: string;
    invoiceId: string;
    lineItemId: string;
  }
  let A: World;
  let B: World;

  async function buildWorld(slug: string): Promise<World> {
    const user = await base.user.create({
      data: { email: `${slug}@example.com`, name: slug },
    });
    const org = await base.organization.create({
      data: {
        name: slug,
        slug,
        subscription: { create: {} },
        memberships: { create: { userId: user.id, role: 'OWNER' } },
      },
      include: { memberships: true },
    });
    const client = await base.client.create({
      data: {
        organizationId: org.id,
        name: `${slug} client`,
        email: `c@${slug}.example`,
      },
    });
    const task = await base.task.create({
      data: {
        organizationId: org.id,
        title: `${slug} task`,
        assigneeId: org.memberships[0]!.id,
      },
    });
    const invoice = await base.invoice.create({
      data: {
        organizationId: org.id,
        clientId: client.id,
        number: 'INV-0001',
        totalCents: 100,
        lineItems: {
          create: { description: 'work', quantity: 1, unitPriceCents: 100 },
        },
      },
      include: { lineItems: true },
    });
    return {
      id: org.id,
      memberId: org.memberships[0]!.id,
      clientId: client.id,
      taskId: task.id,
      invoiceId: invoice.id,
      lineItemId: invoice.lineItems[0]!.id,
    };
  }

  /** Runs `fn` as organisation `world`. */
  const as = async <T>(world: World, fn: () => Promise<T>): Promise<T> => {
    current = world.id;
    try {
      return await fn();
    } finally {
      current = undefined;
    }
  };

  beforeAll(() => {
    base = createTestDb();
    db = createTenantClient(base, () => current);
  });
  afterAll(async () => {
    await base.$disconnect();
  });
  beforeEach(async () => {
    await resetDb(base);
    A = await buildWorld('alpha');
    B = await buildWorld('beta');
    current = undefined;
  });

  describe('reads see only the current organisation', () => {
    it('findMany / findFirst / count / aggregate / groupBy', async () => {
      await as(A, async () => {
        expect((await db.task.findMany()).map((t) => t.id)).toEqual([A.taskId]);
        expect(await db.task.count()).toBe(1);
        expect((await db.task.aggregate({ _count: true }))._count).toBe(1);
        const groups = await db.task.groupBy({ by: ['status'], _count: true });
        expect(groups.reduce((n, g) => n + g._count, 0)).toBe(1);
        expect((await db.client.findFirst())?.id).toBe(A.clientId);
      });
    });

    it('findUnique / findUniqueOrThrow by ANOTHER organisation’s id find nothing', async () => {
      await as(A, async () => {
        expect(
          await db.task.findUnique({ where: { id: B.taskId } }),
        ).toBeNull();
        await expect(
          db.client.findUniqueOrThrow({ where: { id: B.clientId } }),
        ).rejects.toThrow();
        expect(
          await db.invoice.findFirst({ where: { id: B.invoiceId } }),
        ).toBeNull();
      });
    });

    it('cannot be widened by the query itself: OR, NOT, explicit organizationId, or a huge take', async () => {
      await as(A, async () => {
        const attempts = [
          { OR: [{ organizationId: B.id }, { organizationId: A.id }] },
          { organizationId: B.id },
          { organizationId: { in: [A.id, B.id] } },
          { NOT: { organizationId: A.id } },
          { id: { in: [A.taskId, B.taskId] } },
        ];
        for (const where of attempts) {
          const rows = await db.task.findMany({ where, take: 1000 });
          expect(
            rows.every((r) => r.organizationId === A.id),
            JSON.stringify(where),
          ).toBe(true);
        }
        expect(
          await db.task.findMany({ where: { organizationId: B.id } }),
        ).toEqual([]);
      });
    });

    it('works through relations a service would include', async () => {
      await as(A, async () => {
        const invoice = await db.invoice.findFirstOrThrow({
          where: { id: A.invoiceId },
          include: { client: true, lineItems: true },
        });
        expect(invoice.client.id).toBe(A.clientId);
        expect(invoice.lineItems).toHaveLength(1);
      });
    });

    it('scopes the Organization row and the invoice line items too', async () => {
      await as(A, async () => {
        expect((await db.organization.findMany()).map((o) => o.id)).toEqual([
          A.id,
        ]);
        expect(
          await db.organization.findUnique({ where: { id: B.id } }),
        ).toBeNull();
        expect((await db.invoiceLineItem.findMany()).map((l) => l.id)).toEqual([
          A.lineItemId,
        ]);
        expect(
          await db.invoiceLineItem.findUnique({ where: { id: B.lineItemId } }),
        ).toBeNull();
        expect(
          await db.invoiceLineItem.count({ where: { invoiceId: B.invoiceId } }),
        ).toBe(0);
      });
    });

    it('scopes subscriptions and memberships (sensitive tenant tables)', async () => {
      await as(A, async () => {
        expect(await db.membership.findMany()).toHaveLength(1);
        expect((await db.membership.findMany())[0]!.organizationId).toBe(A.id);
        expect(await db.subscription.findMany()).toHaveLength(1);
      });
    });
  });

  describe('writes cannot touch another organisation', () => {
    it('update / delete by another organisation’s id fail and change nothing', async () => {
      await as(A, async () => {
        await expect(
          db.task.update({
            where: { id: B.taskId },
            data: { title: 'hacked' },
          }),
        ).rejects.toThrow();
        await expect(
          db.client.delete({ where: { id: B.clientId } }),
        ).rejects.toThrow();
      });
      expect(
        (await base.task.findUniqueOrThrow({ where: { id: B.taskId } })).title,
      ).toBe('beta task');
      expect(await base.client.count({ where: { id: B.clientId } })).toBe(1);
    });

    it('updateMany / deleteMany touch only my rows, even with a filter that names theirs', async () => {
      await as(A, async () => {
        const updated = await db.task.updateMany({
          where: { organizationId: B.id },
          data: { title: 'hacked' },
        });
        expect(updated.count).toBe(0);
        const wide = await db.task.updateMany({ data: { title: 'mine' } });
        expect(wide.count).toBe(1);
        expect(
          (await db.task.deleteMany({ where: { id: B.taskId } })).count,
        ).toBe(0);
      });
      expect(
        (await base.task.findUniqueOrThrow({ where: { id: B.taskId } })).title,
      ).toBe('beta task');
      expect(
        (await base.task.findUniqueOrThrow({ where: { id: A.taskId } })).title,
      ).toBe('mine');
    });

    it('create is stamped with my organisation, and naming another one is refused', async () => {
      await as(A, async () => {
        const made = await db.task.create({ data: { title: 'new' } as never });
        expect(made.organizationId).toBe(A.id);
        await expect(
          db.task.create({ data: { title: 'x', organizationId: B.id } }),
        ).rejects.toBeInstanceOf(TenantViolationError);
        await expect(
          db.task.create({
            data: {
              title: 'x',
              organization: { connect: { id: B.id } },
            } as never,
          }),
        ).rejects.toThrow(/relation form/);
      });
      expect(await base.task.count({ where: { organizationId: B.id } })).toBe(
        1,
      );
    });

    it('createMany is stamped, and one foreign row fails the whole batch', async () => {
      await as(A, async () => {
        await db.client.createMany({
          data: [
            { name: 'x', email: 'x@a.example' },
            { name: 'y', email: 'y@a.example' },
          ] as never,
        });
        expect(await db.client.count()).toBe(3);
        await expect(
          db.client.createMany({
            data: [
              { name: 'z', email: 'z@a.example' },
              { name: 'w', email: 'w@a.example', organizationId: B.id },
            ] as never,
          }),
        ).rejects.toBeInstanceOf(TenantViolationError);
        expect(await db.client.count()).toBe(3);
      });
    });

    it('a row cannot be moved to another organisation by an update', async () => {
      await as(A, async () => {
        await expect(
          db.task.update({
            where: { id: A.taskId },
            data: { organizationId: B.id },
          }),
        ).rejects.toBeInstanceOf(TenantViolationError);
        await expect(
          db.task.updateMany({ data: { organizationId: B.id } }),
        ).rejects.toBeInstanceOf(TenantViolationError);
      });
      expect(
        (await base.task.findUniqueOrThrow({ where: { id: A.taskId } }))
          .organizationId,
      ).toBe(A.id);
    });

    it('upsert cannot overwrite another organisation’s row', async () => {
      await as(A, async () => {
        // The lookup is scoped, so B's row is not found and a NEW row is created in A
        // (whose id collides with B's primary key, so the database refuses it).
        await expect(
          db.client.upsert({
            where: { id: B.clientId },
            create: {
              id: B.clientId,
              name: 'taken',
              email: 't@a.example',
            } as never,
            update: { name: 'hacked' },
          }),
        ).rejects.toThrow();
      });
      expect(
        (await base.client.findUniqueOrThrow({ where: { id: B.clientId } }))
          .name,
      ).toBe('beta client');
    });

    it('line items: cannot be added to, changed in, or removed from another organisation’s invoice', async () => {
      await as(A, async () => {
        await expect(
          db.invoiceLineItem.create({
            data: {
              invoiceId: B.invoiceId,
              description: 'x',
              quantity: 1,
              unitPriceCents: 1,
            },
          }),
        ).rejects.toBeInstanceOf(TenantViolationError);
        await expect(
          db.invoiceLineItem.update({
            where: { id: B.lineItemId },
            data: { description: 'hacked' },
          }),
        ).rejects.toThrow();
        expect(
          (
            await db.invoiceLineItem.deleteMany({
              where: { invoiceId: B.invoiceId },
            })
          ).count,
        ).toBe(0);
        await expect(
          db.invoiceLineItem.create({
            data: {
              invoice: { connect: { id: B.invoiceId } },
              description: 'x',
              quantity: 1,
              unitPriceCents: 1,
            } as never,
          }),
        ).rejects.toThrow(/relation form/);
      });
      expect(
        await base.invoiceLineItem.count({ where: { invoiceId: B.invoiceId } }),
      ).toBe(1);
      expect(
        (
          await base.invoiceLineItem.findUniqueOrThrow({
            where: { id: B.lineItemId },
          })
        ).description,
      ).toBe('work');
    });

    it('the Organization row: I can rename mine, but cannot touch theirs or create/delete organisations wholesale', async () => {
      await as(A, async () => {
        await db.organization.update({
          where: { id: A.id },
          data: { name: 'renamed' },
        });
        await expect(
          db.organization.update({
            where: { id: B.id },
            data: { name: 'hacked' },
          }),
        ).rejects.toThrow();
        expect(
          (await db.organization.deleteMany({ where: { id: B.id } })).count,
        ).toBe(0);
        await expect(
          db.organization.create({ data: { name: 'x', slug: 'x' } }),
        ).rejects.toBeInstanceOf(TenantViolationError);
      });
      expect(
        (await base.organization.findUniqueOrThrow({ where: { id: B.id } }))
          .name,
      ).toBe('beta');
      expect(
        (await base.organization.findUniqueOrThrow({ where: { id: A.id } }))
          .name,
      ).toBe('renamed');
    });
  });

  describe('foreign keys must stay inside the organisation (the Milestone 2 limitation, closed)', () => {
    it('a task cannot be assigned to another organisation’s member', async () => {
      await as(A, async () => {
        await expect(
          db.task.create({
            data: { title: 'x', assigneeId: B.memberId } as never,
          }),
        ).rejects.toThrow(/outside the current organisation/);
        await expect(
          db.task.update({
            where: { id: A.taskId },
            data: { assigneeId: B.memberId },
          }),
        ).rejects.toThrow(/outside the current organisation/);
        await expect(
          db.task.update({
            where: { id: A.taskId },
            data: { assigneeId: { set: B.memberId } },
          }),
        ).rejects.toThrow(/outside the current organisation/);
        // Assigning to my own member, or clearing the assignee, is fine.
        await db.task.update({
          where: { id: A.taskId },
          data: { assigneeId: A.memberId },
        });
        await db.task.update({
          where: { id: A.taskId },
          data: { assigneeId: null },
        });
      });
      expect(
        (await base.task.findUniqueOrThrow({ where: { id: A.taskId } }))
          .assigneeId,
      ).toBeNull();
    });

    it('an invoice cannot be created or re-pointed at another organisation’s client', async () => {
      await as(A, async () => {
        await expect(
          db.invoice.create({
            data: {
              clientId: B.clientId,
              number: 'INV-0002',
              totalCents: 1,
            } as never,
          }),
        ).rejects.toThrow(/outside the current organisation/);
        await expect(
          db.invoice.update({
            where: { id: A.invoiceId },
            data: { clientId: B.clientId },
          }),
        ).rejects.toThrow(/outside the current organisation/);
        await db.invoice.create({
          data: {
            clientId: A.clientId,
            number: 'INV-0002',
            totalCents: 1,
          } as never,
        });
      });
      expect(
        await base.invoice.count({ where: { clientId: B.clientId } }),
      ).toBe(1);
    });

    it('upsert checks the foreign keys on both the create and the update side', async () => {
      await as(A, async () => {
        await expect(
          db.task.upsert({
            where: { id: A.taskId },
            create: { title: 'c' } as never,
            update: { assigneeId: B.memberId },
          }),
        ).rejects.toThrow(/outside the current organisation/);
      });
    });
  });

  describe('it fails closed', () => {
    it('refuses to run with no organisation in context, for every operation', async () => {
      current = undefined;
      await expect(db.task.findMany()).rejects.toBeInstanceOf(
        TenantContextMissingError,
      );
      await expect(db.task.count()).rejects.toBeInstanceOf(
        TenantContextMissingError,
      );
      await expect(
        db.task.create({ data: { title: 'x' } as never }),
      ).rejects.toBeInstanceOf(TenantContextMissingError);
      await expect(db.task.deleteMany()).rejects.toBeInstanceOf(
        TenantContextMissingError,
      );
      await expect(db.organization.findMany()).rejects.toBeInstanceOf(
        TenantContextMissingError,
      );
      // …and it changed nothing.
      expect(await base.task.count()).toBe(2);
    });

    it('refuses global models (users, tokens) and raw SQL', async () => {
      await as(A, async () => {
        await expect(db.user.findMany()).rejects.toThrow(/not tenant data/);
        await expect(db.refreshToken.deleteMany()).rejects.toThrow(
          /not tenant data/,
        );
        await expect(
          db.stripeEvent.create({ data: { id: 'e', type: 't' } }),
        ).rejects.toThrow(/not tenant data/);
        expect(
          () => (db as unknown as PrismaClient).$queryRaw`SELECT 1`,
        ).toThrow(/not available on the tenant client/);
        expect(() =>
          (db as unknown as PrismaClient).$executeRawUnsafe(
            'DELETE FROM "Task"',
          ),
        ).toThrow(/not available/);
      });
      expect(await base.user.count()).toBe(2);
      expect(await base.task.count()).toBe(2);
    });

    it('context does not leak between calls: switching organisation switches the data', async () => {
      const aTasks = await as(A, () => db.task.findMany());
      const bTasks = await as(B, () => db.task.findMany());
      expect(aTasks.map((t) => t.id)).toEqual([A.taskId]);
      expect(bTasks.map((t) => t.id)).toEqual([B.taskId]);
      await expect(db.task.findMany()).rejects.toBeInstanceOf(
        TenantContextMissingError,
      );
    });
  });

  describe('connections', () => {
    it('never needs a second connection inside a transaction (no pool deadlock)', async () => {
      // A pool of ONE connection: if the foreign-key check borrowed another connection while
      // the transaction held this one, it would wait forever. This is the production bug
      // that a burst of concurrent invoice creations used to trigger.
      const single = new PrismaClient({
        adapter: new PrismaPg({
          connectionString: testDatabaseUrl(),
          max: 1,
          connectionTimeoutMillis: 3000,
        }),
      });
      try {
        const one = createTenantClient(single, () => A.id);
        const started = Date.now();
        await one.$transaction(async (tx) => {
          const made = await tx.task.create({
            data: { title: 'fk-checked', assigneeId: A.memberId } as never,
          });
          await tx.task.update({
            where: { id: made.id },
            data: { assigneeId: A.memberId },
          });
        });
        expect(Date.now() - started).toBeLessThan(2000);
        // And the check still bites inside the transaction, on the same connection.
        await expect(
          one.$transaction(async (tx) => {
            await tx.task.create({
              data: { title: 'x', assigneeId: B.memberId } as never,
            });
          }),
        ).rejects.toThrow(/outside the current organisation/);
      } finally {
        await single.$disconnect();
      }
    });

    it('only interactive transactions are allowed (array form is refused)', async () => {
      await as(A, async () => {
        expect(() => db.$transaction([] as never)).toThrow(
          /interactive transaction/,
        );
      });
    });

    it('the transaction client has no raw SQL either', async () => {
      await as(A, async () => {
        await db.$transaction(async (tx) => {
          expect(
            () => (tx as unknown as PrismaClient).$queryRaw`SELECT 1`,
          ).toThrow(/not available on the tenant client/);
        });
      });
    });
  });

  describe('transactions stay scoped', () => {
    it('an interactive transaction on the tenant client is still confined', async () => {
      await as(A, async () => {
        await db.$transaction(async (tx) => {
          expect(await tx.task.count()).toBe(1);
          await expect(
            tx.task.findUnique({ where: { id: B.taskId } }),
          ).resolves.toBeNull();
          await tx.task.create({ data: { title: 'in tx' } as never });
        });
        expect(await db.task.count()).toBe(2);
      });
      expect(await base.task.count({ where: { organizationId: B.id } })).toBe(
        1,
      );
    });

    it('a failed transaction rolls everything back', async () => {
      await as(A, async () => {
        await expect(
          db.$transaction(async (tx) => {
            await tx.task.create({ data: { title: 'doomed' } as never });
            await tx.task.update({
              where: { id: B.taskId },
              data: { title: 'x' },
            }); // not found → throws
          }),
        ).rejects.toThrow();
        expect(await db.task.count()).toBe(1);
      });
    });
  });
});

describe('TenantPrismaService + request context (through the real app)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantDb: TenantPrismaService;
  let context: RequestContextService;
  let a: { id: string; membershipId: string };
  let b: { id: string; membershipId: string };

  beforeAll(async () => {
    ({ app } = await createTestApp({ realDatabase: true }));
    prisma = app.get(PrismaService);
    tenantDb = app.get(TenantPrismaService);
    context = app.get(RequestContextService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(prisma);
    const mk = async (slug: string) => {
      const user = await prisma.user.create({
        data: { email: `${slug}@x.example`, name: slug },
      });
      const org = await prisma.organization.create({
        data: {
          name: slug,
          slug,
          memberships: { create: { userId: user.id, role: 'OWNER' } },
          clients: { create: { name: slug, email: `${slug}@c.example` } },
        },
        include: { memberships: true },
      });
      return { id: org.id, membershipId: org.memberships[0]!.id };
    };
    a = await mk('alpha');
    b = await mk('beta');
  });

  const asTenant = <T>(
    t: { id: string; membershipId: string },
    fn: () => Promise<T>,
  ) =>
    context.runWithTenant(
      { organizationId: t.id, membershipId: t.membershipId, role: 'OWNER' },
      fn,
    );

  it('runWithTenant scopes work across awaits, like a background job would need', async () => {
    const names = await asTenant(a, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const first = await tenantDb.client.client.findMany();
      await Promise.resolve();
      const second = await tenantDb.client.client.findMany({
        where: { organizationId: b.id },
      });
      return { first: first.map((c) => c.name), second };
    });
    expect(names).toEqual({ first: ['alpha'], second: [] });
  });

  it('two organisations running at the same time never see each other’s data', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_u, i) => {
        const t = i % 2 === 0 ? a : b;
        return asTenant(t, async () => {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.random() * 15),
          );
          const rows = await tenantDb.client.client.findMany();
          return { expected: t.id, got: rows.map((r) => r.organizationId) };
        });
      }),
    );
    for (const r of results) expect(r.got).toEqual([r.expected]);
  });

  it('outside any context it refuses (no tenant → no data)', async () => {
    await expect(tenantDb.client.client.findMany()).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
  });
});
