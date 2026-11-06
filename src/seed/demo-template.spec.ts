import { InvoiceStatus, TaskStatus } from '../generated/prisma/client.js';
import {
  DEMO_CLIENTS,
  DEMO_INVOICES,
  DEMO_PEOPLE,
  DEMO_TASKS,
  invoiceNumber,
  invoiceTotalCents,
  seedDemoOrganization,
} from './demo-template.js';

/** Pure checks on the template data: no database needed. */
describe('demo template data', () => {
  it('matches the shape promised in ARCHITECTURE.md §18', () => {
    expect(DEMO_PEOPLE).toHaveLength(3);
    expect(DEMO_TASKS).toHaveLength(25);
    expect(DEMO_CLIENTS).toHaveLength(6);
    expect(DEMO_INVOICES).toHaveLength(10);
  });

  it('has exactly one owner, listed first (code relies on index 0)', () => {
    expect(DEMO_PEOPLE.filter((p) => p.role === 'OWNER')).toHaveLength(1);
    expect(DEMO_PEOPLE[0].role).toBe('OWNER');
  });

  it('only references people and clients that exist', () => {
    for (const task of DEMO_TASKS) {
      if (task.assignee !== null)
        expect(DEMO_PEOPLE[task.assignee]).toBeDefined();
    }
    for (const invoice of DEMO_INVOICES) {
      expect(DEMO_CLIENTS[invoice.client]).toBeDefined();
    }
  });

  it('uses lower-case emails on reserved .example domains only (the DB enforces lower-case)', () => {
    for (const client of DEMO_CLIENTS) {
      expect(client.email).toBe(client.email.toLowerCase());
      expect(client.email).toMatch(/\.example$/);
    }
    expect(new Set(DEMO_CLIENTS.map((c) => c.email)).size).toBe(
      DEMO_CLIENTS.length,
    );
  });

  it('covers every task status so every column of the board has cards', () => {
    const statuses = new Set(DEMO_TASKS.map((t) => t.status));
    for (const status of Object.values(TaskStatus))
      expect(statuses).toContain(status);
  });

  it('covers every invoice status so every UI state is demoable', () => {
    const statuses = new Set(DEMO_INVOICES.map((i) => i.status));
    for (const status of Object.values(InvoiceStatus))
      expect(statuses).toContain(status);
  });

  it('keeps invoice dates logically consistent with their status', () => {
    for (const invoice of DEMO_INVOICES) {
      if (invoice.status === 'OVERDUE')
        expect(invoice.dueInDays).toBeLessThan(0);
      if (invoice.status === 'SENT' || invoice.status === 'DRAFT') {
        expect(invoice.dueInDays).toBeGreaterThan(0);
      }
      expect(invoice.ageInDays).toBeGreaterThan(0);
    }
  });

  it('uses valid money: positive whole quantities, non-negative integer cents', () => {
    for (const invoice of DEMO_INVOICES) {
      expect(invoice.items.length).toBeGreaterThan(0);
      for (const [description, quantity, unitCents] of invoice.items) {
        expect(description.length).toBeGreaterThan(0);
        expect(Number.isInteger(quantity) && quantity > 0).toBe(true);
        expect(Number.isInteger(unitCents) && unitCents >= 0).toBe(true);
      }
      expect(Number.isSafeInteger(invoiceTotalCents(invoice.items))).toBe(true);
    }
  });

  it('computes totals as the sum of quantity x unit price', () => {
    expect(
      invoiceTotalCents([
        ['a', 2, 1_500],
        ['b', 3, 250],
      ]),
    ).toBe(3_750);
  });

  it('numbers invoices INV-0001, INV-0002, ...', () => {
    expect(invoiceNumber(1)).toBe('INV-0001');
    expect(invoiceNumber(10)).toBe('INV-0010');
    expect(invoiceNumber(12345)).toBe('INV-12345');
  });
});

describe('seedDemoOrganization input validation', () => {
  // The tag becomes part of a slug and emails, so a bad one must be rejected before any
  // database call (this throws before the client is touched).
  it.each(['', 'Has Caps', 'has space', 'semi;colon', 'a'.repeat(33), '../x'])(
    'rejects tag %j',
    async (tag) => {
      await expect(seedDemoOrganization({} as never, { tag })).rejects.toThrow(
        /Invalid demo tag/,
      );
    },
  );
});
