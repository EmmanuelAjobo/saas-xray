import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../src/core/prisma/prisma.service.js';
import { XrayService } from '../src/core/xray/xray.service.js';
import type { InvoiceStatus } from '../src/generated/prisma/client.js';
import { OverdueSweepService } from '../src/modules/jobs/overdue-sweep.service.js';
import { createTestApp } from './support/create-test-app.js';
import { createClient, resetDb } from './support/db.js';
import {
  createAuthedUser,
  createHttpClient,
  createOrgWith,
  type TestUser,
} from './support/http-client.js';

const NOW = new Date('2026-11-09T12:00:00Z');
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe('the overdue sweep (real Postgres)', () => {
  let app: NestExpressApplication;
  let db: PrismaService;
  let sweep: OverdueSweepService;
  let xray: XrayService;
  let client: ReturnType<typeof createHttpClient>;

  beforeAll(async () => {
    ({ app } = await createTestApp({
      realDatabase: true,
      env: {
        TRUST_PROXY_HOPS: '1',
        REQUEST_TIMEOUT_MS: '60000',
        OVERDUE_SWEEP_ORG_BATCH: '2',
      },
    }));
    db = app.get(PrismaService);
    sweep = app.get(OverdueSweepService);
    xray = app.get(XrayService);
    client = createHttpClient(app);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(db);
  });

  let seq = 0;
  async function org(slug: string) {
    const owner = await createAuthedUser(app, db, `${slug}@example.com`);
    const { id } = await createOrgWith(db, slug, [
      { user: owner, role: 'OWNER' },
    ]);
    const c = await createClient(db, id, `client-${slug}@example.com`);
    return { owner, id, clientId: c.id };
  }
  async function invoice(
    o: { id: string; clientId: string },
    status: InvoiceStatus,
    dueDate: Date | null,
    extra: { deletedAt?: Date } = {},
  ) {
    seq += 1;
    return db.invoice.create({
      data: {
        organizationId: o.id,
        clientId: o.clientId,
        number: `INV-${String(seq).padStart(4, '0')}`,
        status,
        totalCents: 1000,
        dueDate,
        ...extra,
      },
    });
  }
  const statusOf = async (id: string) =>
    (await db.invoice.findUniqueOrThrow({ where: { id } })).status;

  it('marks exactly the SENT, past-due, not-deleted invoices as OVERDUE and touches nothing else', async () => {
    const a = await org('acme');
    const target = await invoice(a, 'SENT', day(-1));
    const notDueYet = await invoice(a, 'SENT', day(5));
    const dueExactlyNow = await invoice(a, 'SENT', NOW);
    const noDueDate = await invoice(a, 'SENT', null);
    const draft = await invoice(a, 'DRAFT', day(-10));
    const paid = await invoice(a, 'PAID', day(-10));
    const voided = await invoice(a, 'VOID', day(-10));
    const alreadyOverdue = await invoice(a, 'OVERDUE', day(-10));
    const deleted = await invoice(a, 'SENT', day(-10), { deletedAt: day(-2) });

    const result = await sweep.run(NOW);

    expect(result).toEqual({ organizations: 1, invoices: 1 });
    expect(await statusOf(target.id)).toBe('OVERDUE');
    expect(await statusOf(notDueYet.id)).toBe('SENT');
    expect(await statusOf(dueExactlyNow.id)).toBe('SENT'); // strictly past due
    expect(await statusOf(noDueDate.id)).toBe('SENT');
    expect(await statusOf(draft.id)).toBe('DRAFT');
    expect(await statusOf(paid.id)).toBe('PAID');
    expect(await statusOf(voided.id)).toBe('VOID');
    expect(await statusOf(alreadyOverdue.id)).toBe('OVERDUE');
    expect(await statusOf(deleted.id)).toBe('SENT');
  });

  it('is safe to run again: the second run changes nothing', async () => {
    const a = await org('acme');
    await invoice(a, 'SENT', day(-1));
    expect((await sweep.run(NOW)).invoices).toBe(1);
    expect(await sweep.run(NOW)).toEqual({ organizations: 0, invoices: 0 });
  });

  it('handles every organisation, each only in its own data', async () => {
    const a = await org('acme');
    const b = await org('bravo');
    const aInvoice = await invoice(a, 'SENT', day(-1));
    const bInvoice = await invoice(b, 'SENT', day(-3));
    const bFuture = await invoice(b, 'SENT', day(9));
    const result = await sweep.run(NOW);
    expect(result).toEqual({ organizations: 2, invoices: 2 });
    expect(await statusOf(aInvoice.id)).toBe('OVERDUE');
    expect(await statusOf(bInvoice.id)).toBe('OVERDUE');
    expect(await statusOf(bFuture.id)).toBe('SENT');
  });

  it('tells each organisation’s own X-ray, and no other', async () => {
    const a = await org('acme');
    const b = await org('bravo');
    const quiet = await org('quiet');
    await invoice(a, 'SENT', day(-1));
    await invoice(a, 'SENT', day(-2));
    await invoice(b, 'SENT', day(-1));
    await invoice(quiet, 'SENT', day(4));
    await sweep.run(NOW);
    await xray.flush();

    const eventsOf = async (o: { owner: TestUser; id: string }) =>
      (
        await client
          .call('get', `/v1/orgs/${o.id}/xray/events`, {
            bearer: o.owner.token,
          })
          .expect(200)
      ).body.data as Array<{ kind: string; summary: string }>;
    const aEvents = await eventsOf(a);
    expect(aEvents.map((e) => e.kind)).toEqual(['job.completed']);
    expect(aEvents[0]?.summary).toContain('2 invoices marked overdue');
    expect((await eventsOf(b))[0]?.summary).toContain(
      '1 invoice marked overdue',
    );
    expect(await eventsOf(quiet)).toEqual([]);
  });

  it('does at most OVERDUE_SWEEP_ORG_BATCH organisations per run; the next run continues', async () => {
    const orgs = [await org('o1'), await org('o2'), await org('o3')];
    for (const o of orgs) await invoice(o, 'SENT', day(-1));
    expect(await sweep.run(NOW)).toEqual({ organizations: 2, invoices: 2 });
    expect(await sweep.run(NOW)).toEqual({ organizations: 1, invoices: 1 });
    expect(await sweep.run(NOW)).toEqual({ organizations: 0, invoices: 0 });
  });

  it('never overwrites a payment that lands at the same moment (pay and sweep race, many rounds)', async () => {
    const a = await org('acme');
    for (let round = 0; round < 4; round++) {
      const invoices = await Promise.all(
        Array.from({ length: 6 }, () => invoice(a, 'SENT', day(-1))),
      );
      await Promise.all([
        ...invoices.map((i) =>
          client.call('post', `/v1/orgs/${a.id}/invoices/${i.id}/pay`, {
            bearer: a.owner.token,
          }),
        ),
        sweep.run(NOW),
      ]);
      // Whichever came first, the payment must have won: an OVERDUE invoice can still be paid,
      // and a PAID invoice is never turned back into OVERDUE.
      for (const i of invoices) expect(await statusOf(i.id)).toBe('PAID');
    }
  });
});
