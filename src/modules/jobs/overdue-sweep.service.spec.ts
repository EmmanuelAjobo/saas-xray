import { Logger } from '@nestjs/common';
import { testConfig } from '../../../test/support/test-config.js';
import type {
  RequestContextService,
  RequestTenant,
} from '../../core/context/request-context.service.js';
import type { PrismaService } from '../../core/prisma/prisma.service.js';
import { MemoryXrayStore } from '../../core/xray/memory-xray.store.js';
import { XrayService } from '../../core/xray/xray.service.js';
import type { InvoicesService } from '../invoices/invoices.service.js';
import { OverdueSweepService } from './overdue-sweep.service.js';

const NOW = new Date('2026-11-09T12:00:00Z');

function setup(
  orgs: string[],
  marked: Record<string, number | Error>,
  env: Record<string, string> = {},
) {
  const config = testConfig(env);
  const store = new MemoryXrayStore(config);
  const xray = new XrayService(store, config);
  const groupBy = vi
    .fn()
    .mockResolvedValue(orgs.map((organizationId) => ({ organizationId })));
  const prisma = { invoice: { groupBy } } as unknown as PrismaService;

  // The tenant the code is "inside" right now, as the tenant-scoped client would see it.
  let current: RequestTenant | undefined;
  const ran: Array<{ tenant: RequestTenant; at: Date }> = [];
  const context = {
    runWithTenant: async (tenant: RequestTenant, fn: () => Promise<number>) => {
      current = tenant;
      try {
        return await fn();
      } finally {
        current = undefined;
      }
    },
  } as unknown as RequestContextService;
  const invoices = {
    markOverdue: async (at: Date) => {
      const org = current?.organizationId as string;
      ran.push({ tenant: current as RequestTenant, at });
      const result = marked[org] ?? 0;
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as InvoicesService;

  const service = new OverdueSweepService(
    prisma,
    invoices,
    context,
    xray,
    config,
  );
  return { service, store, xray, groupBy, ran };
}

describe('OverdueSweepService', () => {
  it('finds organisations with SENT, past-due, not-deleted invoices (and only those)', async () => {
    const { service, groupBy } = setup([], {});
    await service.run(NOW);
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['organizationId'],
        where: { status: 'SENT', deletedAt: null, dueDate: { lt: NOW } },
      }),
    );
  });

  it('marks each organisation INSIDE that organisation’s own tenant context, as the system', async () => {
    const { service, ran } = setup(['org-a', 'org-b'], {
      'org-a': 2,
      'org-b': 1,
    });
    await service.run(NOW);
    expect(ran.map((r) => r.tenant.organizationId)).toEqual(['org-a', 'org-b']);
    expect(
      ran.every(
        (r) => r.tenant.role === 'OWNER' && r.tenant.membershipId === 'system',
      ),
    ).toBe(true);
    expect(ran.every((r) => r.at === NOW)).toBe(true);
  });

  it('reports how many organisations and invoices it changed', async () => {
    const { service } = setup(['org-a', 'org-b', 'org-c'], {
      'org-a': 2,
      'org-b': 0,
      'org-c': 3,
    });
    expect(await service.run(NOW)).toEqual({ organizations: 2, invoices: 5 });
  });

  it('tells ONLY the organisations that had something changed, each in its own X-ray', async () => {
    const { service, store, xray } = setup(['org-a', 'org-b', 'org-c'], {
      'org-a': 2,
      'org-b': 0,
      'org-c': 1,
    });
    await service.run(NOW);
    await xray.flush();
    const a = await store.latest('org-a', 10);
    expect(a.map((e) => e.kind)).toEqual(['job.completed']);
    expect(a[0]?.summary).toContain('2 invoices marked overdue');
    expect((await store.latest('org-c', 10))[0]?.summary).toContain(
      '1 invoice marked overdue',
    );
    expect(await store.latest('org-b', 10)).toEqual([]);
  });

  it('one organisation failing does not stop the others', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service } = setup(['org-a', 'org-b', 'org-c'], {
      'org-a': 1,
      'org-b': new Error('db hiccup'),
      'org-c': 1,
    });
    expect(await service.run(NOW)).toEqual({ organizations: 2, invoices: 2 });
  });

  it('handles at most OVERDUE_SWEEP_ORG_BATCH organisations per run, in a stable order', async () => {
    const { service, groupBy } = setup(
      [],
      {},
      { OVERDUE_SWEEP_ORG_BATCH: '7' },
    );
    await service.run(NOW);
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ take: 7, orderBy: { organizationId: 'asc' } }),
    );
  });

  it('does nothing, quietly, when nothing is overdue', async () => {
    const { service, xray, store } = setup([], {});
    expect(await service.run(NOW)).toEqual({ organizations: 0, invoices: 0 });
    await xray.flush();
    expect(await store.latest('org-a', 5)).toEqual([]);
  });
});
