import type { PrismaClient } from '../src/generated/prisma/client.js';
import {
  DEMO_CLIENTS,
  DEMO_INVOICES,
  DEMO_TASKS,
  invoiceNumber,
  removeDemoOrganization,
  seedDemoOrganization,
} from '../src/seed/demo-template.js';
import { createTestDb, createUser, resetDb } from './support/db.js';

describe('demo organisation seed (real Postgres)', () => {
  let db: PrismaClient;

  beforeAll(() => {
    db = createTestDb();
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDb(db);
  });

  it('creates the full workspace described in ARCHITECTURE.md §18', async () => {
    const result = await seedDemoOrganization(db);

    expect(result.counts).toEqual({
      users: 3,
      tasks: 25,
      clients: 6,
      invoices: 10,
      lineItems: DEMO_INVOICES.reduce((n, i) => n + i.items.length, 0),
    });
    const where = { organizationId: result.organizationId };
    expect(await db.membership.count({ where })).toBe(3);
    expect(await db.task.count({ where })).toBe(DEMO_TASKS.length);
    expect(await db.client.count({ where })).toBe(DEMO_CLIENTS.length);
    expect(await db.invoice.count({ where })).toBe(DEMO_INVOICES.length);
    expect(await db.invoiceLineItem.count()).toBe(result.counts.lineItems);

    const org = await db.organization.findUniqueOrThrow({
      where: { id: result.organizationId },
      include: { subscription: true },
    });
    expect(org).toMatchObject({
      name: 'Acme Studio (demo)',
      isDemo: true,
      invoiceSeq: 10,
    });
    expect(org.subscription).toMatchObject({ plan: 'FREE', status: 'ACTIVE' });
  });

  it('has exactly one owner, and demo users have no password', async () => {
    const { organizationId } = await seedDemoOrganization(db);
    const memberships = await db.membership.findMany({
      where: { organizationId },
      include: { user: true },
    });
    expect(memberships.filter((m) => m.role === 'OWNER')).toHaveLength(1);
    for (const { user } of memberships) {
      expect(user.passwordHash).toBeNull();
      expect(user.isDemo).toBe(true);
      expect(user.emailVerifiedAt).not.toBeNull();
    }
  });

  it('numbers invoices INV-0001..INV-0010 and the org counter matches the last one', async () => {
    const { organizationId } = await seedDemoOrganization(db);
    const invoices = await db.invoice.findMany({
      where: { organizationId },
      orderBy: { number: 'asc' },
    });
    expect(invoices.map((i) => i.number)).toEqual(
      DEMO_INVOICES.map((_, index) => invoiceNumber(index + 1)),
    );
    const org = await db.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });
    expect(org.invoiceSeq).toBe(invoices.length);
  });

  it('stores invoice totals that equal the sum of their line items, for every invoice', async () => {
    const { organizationId } = await seedDemoOrganization(db);
    const invoices = await db.invoice.findMany({
      where: { organizationId },
      include: { lineItems: true },
    });
    expect(invoices).toHaveLength(10);
    for (const invoice of invoices) {
      const sum = invoice.lineItems.reduce(
        (total, line) => total + line.quantity * line.unitPriceCents,
        0,
      );
      expect(invoice.totalCents, invoice.number).toBe(sum);
      expect(invoice.totalCents).toBeGreaterThan(0);
    }
  });

  it('gives every client at least one invoice, and shows every invoice status', async () => {
    const { organizationId } = await seedDemoOrganization(db);
    const clients = await db.client.findMany({
      where: { organizationId },
      include: { _count: { select: { invoices: true } } },
    });
    for (const client of clients) {
      expect(client._count.invoices, client.name).toBeGreaterThan(0);
    }
    const statuses = await db.invoice.groupBy({
      by: ['status'],
      where: { organizationId },
    });
    expect(statuses.map((s) => s.status).sort()).toEqual(
      ['DRAFT', 'OVERDUE', 'PAID', 'SENT', 'VOID'].sort(),
    );
  });

  it('only ever assigns tasks to members of the same organisation', async () => {
    const { organizationId } = await seedDemoOrganization(db);
    const tasks = await db.task.findMany({
      where: { organizationId },
      include: { assignee: true },
    });
    const assigned = tasks.filter((t) => t.assignee !== null);
    expect(assigned.length).toBeGreaterThan(0);
    for (const task of assigned) {
      expect(task.assignee?.organizationId).toBe(organizationId);
    }
    expect(tasks.some((t) => t.assigneeId === null)).toBe(true); // unassigned work exists too
  });

  it('sets the sandbox expiry from the TTL, relative to the given clock', async () => {
    const now = new Date('2026-01-15T12:00:00.000Z');
    const { organizationId } = await seedDemoOrganization(db, {
      now,
      ttlHours: 6,
    });
    const org = await db.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });
    expect(org.demoExpiresAt?.toISOString()).toBe('2026-01-15T18:00:00.000Z');

    const overdue = await db.invoice.findFirstOrThrow({
      where: { organizationId, status: 'OVERDUE' },
    });
    expect(overdue.dueDate!.getTime()).toBeLessThan(now.getTime());
    const sent = await db.invoice.findFirstOrThrow({
      where: { organizationId, status: 'SENT' },
    });
    expect(sent.dueDate!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('lets many demo organisations coexist (one per visitor) without email or slug clashes', async () => {
    const a = await seedDemoOrganization(db, { tag: 'visitor-a' });
    const b = await seedDemoOrganization(db, { tag: 'visitor-b' });
    expect(a.organizationId).not.toBe(b.organizationId);
    expect(await db.organization.count()).toBe(2);
    expect(await db.user.count()).toBe(6);
    // Same invoice numbers in both orgs: allowed, because uniqueness is per organisation.
    expect(await db.invoice.count({ where: { number: 'INV-0001' } })).toBe(2);
  });

  it('refuses to seed the same tag twice and leaves the first copy intact', async () => {
    await seedDemoOrganization(db, { tag: 'dup' });
    await expect(seedDemoOrganization(db, { tag: 'dup' })).rejects.toThrow();
    expect(await db.organization.count()).toBe(1);
    expect(await db.task.count()).toBe(25);
  });

  it('is atomic: a failure part-way leaves nothing behind', async () => {
    // Block the second person's email, so the seed fails AFTER it has already created the
    // organisation and the owner.
    await createUser(db, 'priya.nair.atomic@demo.local');
    await expect(seedDemoOrganization(db, { tag: 'atomic' })).rejects.toThrow();

    expect(await db.organization.count()).toBe(0);
    expect(await db.membership.count()).toBe(0);
    expect(await db.task.count()).toBe(0);
    expect(await db.user.count()).toBe(1); // only the pre-existing blocker
  });

  describe('removeDemoOrganization', () => {
    it('deletes the organisation, all its data, and its demo users', async () => {
      await seedDemoOrganization(db, { tag: 'gone' });
      expect(await removeDemoOrganization(db, 'gone')).toBe(true);

      expect(await db.organization.count()).toBe(0);
      expect(await db.task.count()).toBe(0);
      expect(await db.invoice.count()).toBe(0);
      expect(await db.invoiceLineItem.count()).toBe(0);
      expect(await db.user.count()).toBe(0);
    });

    it('returns false when there is nothing to remove, and can be repeated safely', async () => {
      expect(await removeDemoOrganization(db, 'never-existed')).toBe(false);
      await seedDemoOrganization(db, { tag: 'once' });
      expect(await removeDemoOrganization(db, 'once')).toBe(true);
      expect(await removeDemoOrganization(db, 'once')).toBe(false);
    });

    it('never touches other demo organisations or real (non-demo) users', async () => {
      await seedDemoOrganization(db, { tag: 'keep' });
      await seedDemoOrganization(db, { tag: 'drop' });
      // A real user whose email merely looks like a demo one must survive.
      await createUser(db, 'someone.drop@demo.local');

      await removeDemoOrganization(db, 'drop');

      expect(await db.organization.count()).toBe(1);
      expect(
        await db.organization.findFirst({
          where: { slug: 'acme-studio-keep' },
        }),
      ).not.toBeNull();
      expect(await db.task.count()).toBe(25);
      expect(
        await db.user.findUnique({
          where: { email: 'someone.drop@demo.local' },
        }),
      ).not.toBeNull();
      expect(await db.user.count()).toBe(4); // 3 from "keep" + the real one
    });

    it('rejects an unsafe tag instead of building a dangerous filter', async () => {
      await expect(removeDemoOrganization(db, '%')).rejects.toThrow(
        /Invalid demo tag/,
      );
      await expect(removeDemoOrganization(db, '')).rejects.toThrow(
        /Invalid demo tag/,
      );
    });
  });
});
