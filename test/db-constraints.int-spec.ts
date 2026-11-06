import {
  InvitationStatus,
  Role,
  type PrismaClient,
} from '../src/generated/prisma/client.js';
import {
  createClient,
  createInvoice,
  createOrg,
  createTestDb,
  createUser,
  resetDb,
} from './support/db.js';

/**
 * These tests try to put bad data into a real Postgres. Each rule is enforced by the
 * database itself, so even a buggy service (or a manual SQL session) cannot break it.
 */
describe('database integrity rules', () => {
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

  describe('identity', () => {
    it('stores emails lower-case only', async () => {
      await expect(createUser(db, 'Ada@Example.com')).rejects.toThrow();
      await expect(createUser(db, 'ada@example.com')).resolves.toBeDefined();
    });

    it('forbids two users with the same email', async () => {
      await createUser(db, 'ada@example.com');
      await expect(createUser(db, 'ada@example.com')).rejects.toThrow();
    });

    it('generates UUID v7 primary keys', async () => {
      const user = await createUser(db);
      // The version digit is the first character of the third group.
      expect(user.id.split('-')[2]?.[0]).toBe('7');
    });

    it('keeps updatedAt moving forward on update', async () => {
      const user = await createUser(db);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const updated = await db.user.update({
        where: { id: user.id },
        data: { name: 'Ada L.' },
      });
      expect(updated.updatedAt.getTime()).toBeGreaterThan(
        user.updatedAt.getTime(),
      );
    });
  });

  describe('invitations', () => {
    const invite = (
      organizationId: string,
      email: string,
      status: InvitationStatus,
      token: string,
    ) =>
      db.invitation.create({
        data: {
          organizationId,
          email,
          role: Role.MEMBER,
          tokenHash: token,
          status,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });

    it('allows only one PENDING invitation per email per organisation', async () => {
      const org = await createOrg(db);
      await invite(org.id, 'new@example.com', 'PENDING', 't1');
      await expect(
        invite(org.id, 'new@example.com', 'PENDING', 't2'),
      ).rejects.toThrow();
    });

    it('allows the same email to be invited to a different organisation', async () => {
      const a = await createOrg(db, 'org-a');
      const b = await createOrg(db, 'org-b');
      await invite(a.id, 'new@example.com', 'PENDING', 't1');
      await expect(
        invite(b.id, 'new@example.com', 'PENDING', 't2'),
      ).resolves.toBeDefined();
    });

    it('allows a fresh invite after the previous one was revoked, expired or accepted', async () => {
      const org = await createOrg(db);
      await invite(org.id, 'new@example.com', 'REVOKED', 't1');
      await invite(org.id, 'new@example.com', 'EXPIRED', 't2');
      await invite(org.id, 'new@example.com', 'ACCEPTED', 't3');
      await expect(
        invite(org.id, 'new@example.com', 'PENDING', 't4'),
      ).resolves.toBeDefined();
    });

    it('stores invitation emails lower-case only', async () => {
      const org = await createOrg(db);
      await expect(
        invite(org.id, 'New@Example.com', 'PENDING', 't1'),
      ).rejects.toThrow();
    });
  });

  describe('money', () => {
    it('rejects a negative invoice total', async () => {
      const org = await createOrg(db);
      const client = await createClient(db, org.id);
      await expect(
        db.invoice.create({
          data: {
            organizationId: org.id,
            clientId: client.id,
            number: 'INV-1',
            totalCents: -1,
          },
        }),
      ).rejects.toThrow();
    });

    it('rejects a currency that is not three upper-case letters', async () => {
      const org = await createOrg(db);
      const client = await createClient(db, org.id);
      for (const currency of ['usd', 'US', 'USDX', '123']) {
        await expect(
          db.invoice.create({
            data: {
              organizationId: org.id,
              clientId: client.id,
              number: `INV-${currency}`,
              totalCents: 100,
              currency,
            },
          }),
        ).rejects.toThrow();
      }
    });

    it('rejects line items with zero quantity or a negative price', async () => {
      const org = await createOrg(db);
      const client = await createClient(db, org.id);
      const invoice = await createInvoice(db, org.id, client.id);
      const item = (quantity: number, unitPriceCents: number) =>
        db.invoiceLineItem.create({
          data: {
            invoiceId: invoice.id,
            description: 'x',
            quantity,
            unitPriceCents,
          },
        });
      await expect(item(0, 100)).rejects.toThrow();
      await expect(item(-1, 100)).rejects.toThrow();
      await expect(item(1, -100)).rejects.toThrow();
      await expect(item(1, 0)).resolves.toBeDefined(); // a free line is fine
    });

    it('rejects a negative invoice counter, file size or report progress outside 0-100', async () => {
      const org = await createOrg(db);
      await expect(
        db.organization.update({
          where: { id: org.id },
          data: { invoiceSeq: -1 },
        }),
      ).rejects.toThrow();
      await expect(
        db.fileObject.create({
          data: {
            organizationId: org.id,
            storageKey: 'k1',
            mimeType: 'text/plain',
            sizeBytes: -5,
          },
        }),
      ).rejects.toThrow();
      for (const progress of [-1, 101]) {
        await expect(
          db.reportJob.create({
            data: { organizationId: org.id, type: 'x', progress },
          }),
        ).rejects.toThrow();
      }
    });
  });

  describe('per-organisation uniqueness', () => {
    it('numbers invoices uniquely within an org, but two orgs may both have INV-0001', async () => {
      const a = await createOrg(db, 'org-a');
      const b = await createOrg(db, 'org-b');
      const clientA = await createClient(db, a.id);
      const clientB = await createClient(db, b.id);
      await createInvoice(db, a.id, clientA.id, 'INV-0001');
      await expect(
        createInvoice(db, a.id, clientA.id, 'INV-0001'),
      ).rejects.toThrow();
      await expect(
        createInvoice(db, b.id, clientB.id, 'INV-0001'),
      ).resolves.toBeDefined();
    });

    it('keeps client emails unique within an org, but not across orgs', async () => {
      const a = await createOrg(db, 'org-a');
      const b = await createOrg(db, 'org-b');
      await createClient(db, a.id, 'same@example.com');
      await expect(
        createClient(db, a.id, 'same@example.com'),
      ).rejects.toThrow();
      await expect(
        createClient(db, b.id, 'same@example.com'),
      ).resolves.toBeDefined();
    });

    it('allows a user to join an organisation only once', async () => {
      const org = await createOrg(db);
      const user = await createUser(db);
      await db.membership.create({
        data: { userId: user.id, organizationId: org.id, role: Role.MEMBER },
      });
      await expect(
        db.membership.create({
          data: { userId: user.id, organizationId: org.id, role: Role.ADMIN },
        }),
      ).rejects.toThrow();
    });

    it('allows exactly one subscription per organisation', async () => {
      const org = await createOrg(db);
      await db.subscription.create({ data: { organizationId: org.id } });
      await expect(
        db.subscription.create({ data: { organizationId: org.id } }),
      ).rejects.toThrow();
    });
  });

  describe('webhook idempotency', () => {
    it('rejects a Stripe event id it has already stored', async () => {
      await db.stripeEvent.create({
        data: { id: 'evt_1', type: 'invoice.paid' },
      });
      await expect(
        db.stripeEvent.create({
          data: { id: 'evt_1', type: 'invoice.paid' },
        }),
      ).rejects.toThrow();
    });
  });

  describe('referential integrity', () => {
    it('rejects tenant rows that point at a non-existent organisation', async () => {
      await expect(
        db.task.create({
          data: {
            organizationId: '01900000-0000-7000-8000-000000000000',
            title: 'orphan',
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses to delete a client that still has invoices, then allows it once they are gone', async () => {
      const org = await createOrg(db);
      const client = await createClient(db, org.id);
      const invoice = await createInvoice(db, org.id, client.id);
      await expect(
        db.client.delete({ where: { id: client.id } }),
      ).rejects.toThrow();
      await db.invoice.delete({ where: { id: invoice.id } });
      await expect(
        db.client.delete({ where: { id: client.id } }),
      ).resolves.toBeDefined();
    });

    it('unassigns (not deletes) a member’s tasks when they leave the organisation', async () => {
      const org = await createOrg(db);
      const user = await createUser(db);
      const membership = await db.membership.create({
        data: { userId: user.id, organizationId: org.id, role: Role.MEMBER },
      });
      const task = await db.task.create({
        data: {
          organizationId: org.id,
          title: 'keep me',
          assigneeId: membership.id,
        },
      });
      await db.membership.delete({ where: { id: membership.id } });
      const after = await db.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(after.assigneeId).toBeNull();
    });

    it('deleting a user removes their memberships and tokens, and keeps files they uploaded', async () => {
      const org = await createOrg(db);
      const user = await createUser(db);
      await db.membership.create({
        data: { userId: user.id, organizationId: org.id, role: Role.MEMBER },
      });
      await db.refreshToken.create({
        data: {
          userId: user.id,
          familyId: '01900000-0000-7000-8000-000000000001',
          tokenHash: 'h1',
          expiresAt: new Date(Date.now() + 1000),
        },
      });
      const file = await db.fileObject.create({
        data: {
          organizationId: org.id,
          storageKey: 'k1',
          mimeType: 'text/plain',
          sizeBytes: 1,
          uploadedById: user.id,
        },
      });
      await db.user.delete({ where: { id: user.id } });
      expect(await db.membership.count()).toBe(0);
      expect(await db.refreshToken.count()).toBe(0);
      const kept = await db.fileObject.findUniqueOrThrow({
        where: { id: file.id },
      });
      expect(kept.uploadedById).toBeNull();
    });

    it('deleting an organisation removes everything it owns, and nothing else', async () => {
      // Two orgs with a full set of data each; delete one; the other must be untouched.
      async function populate(slug: string) {
        const org = await createOrg(db, slug);
        const user = await createUser(db, `${slug}@example.com`);
        const membership = await db.membership.create({
          data: { userId: user.id, organizationId: org.id, role: Role.OWNER },
        });
        const client = await createClient(db, org.id);
        const invoice = await createInvoice(db, org.id, client.id);
        await db.invoiceLineItem.create({
          data: {
            invoiceId: invoice.id,
            description: 'x',
            quantity: 1,
            unitPriceCents: 1,
          },
        });
        const task = await db.task.create({
          data: {
            organizationId: org.id,
            title: 't',
            assigneeId: membership.id,
          },
        });
        await db.fileObject.create({
          data: {
            organizationId: org.id,
            storageKey: `${slug}/k`,
            mimeType: 'text/plain',
            sizeBytes: 1,
            taskId: task.id,
          },
        });
        await db.subscription.create({ data: { organizationId: org.id } });
        await db.apiKey.create({
          data: {
            organizationId: org.id,
            name: 'k',
            prefix: `sk_${slug}`,
            keyHash: 'h',
            scopes: ['tasks:read'],
          },
        });
        await db.invitation.create({
          data: {
            organizationId: org.id,
            email: 'i@example.com',
            role: Role.MEMBER,
            tokenHash: `t-${slug}`,
            expiresAt: new Date(Date.now() + 1000),
          },
        });
        await db.auditLog.create({
          data: {
            organizationId: org.id,
            actorType: 'USER',
            action: 'x.y',
            entityType: 'X',
          },
        });
        await db.notification.create({
          data: {
            organizationId: org.id,
            userId: user.id,
            type: 't',
            payload: {},
          },
        });
        await db.reportJob.create({
          data: { organizationId: org.id, type: 'x' },
        });
        return org;
      }

      const doomed = await populate('doomed');
      await populate('survivor');
      await db.organization.delete({ where: { id: doomed.id } });

      const where = { organizationId: doomed.id };
      expect(await db.membership.count({ where })).toBe(0);
      expect(await db.client.count({ where })).toBe(0);
      expect(await db.invoice.count({ where })).toBe(0);
      expect(await db.task.count({ where })).toBe(0);
      expect(await db.fileObject.count({ where })).toBe(0);
      expect(await db.subscription.count({ where })).toBe(0);
      expect(await db.apiKey.count({ where })).toBe(0);
      expect(await db.invitation.count({ where })).toBe(0);
      expect(await db.auditLog.count({ where })).toBe(0);
      expect(await db.notification.count({ where })).toBe(0);
      expect(await db.reportJob.count({ where })).toBe(0);
      expect(await db.invoiceLineItem.count()).toBe(1); // the survivor's line item remains

      // The survivor is complete, and users (global rows) are never cascaded away.
      expect(await db.organization.count()).toBe(1);
      expect(await db.task.count()).toBe(1);
      expect(await db.invoice.count()).toBe(1);
      expect(await db.user.count()).toBe(2);
    });
  });
});
