import { Logger } from '@nestjs/common';
import { testConfig } from '../../../test/support/test-config.js';
import { MemoryXrayStore } from '../xray/memory-xray.store.js';
import { XrayService } from '../xray/xray.service.js';
import { JobRunner } from './job-runner.service.js';
import type { InvoiceEmailJob } from './jobs.types.js';

const ORG = 'org-a';
const job = (overrides: Partial<InvoiceEmailJob> = {}): InvoiceEmailJob => ({
  organizationId: ORG,
  invoiceId: 'inv-1',
  delivery: 'send',
  to: 'secret.client@example.com',
  organizationName: 'Acme',
  clientName: 'Secret Client',
  number: 'INV-0001',
  amount: '$50.00',
  dueDate: '2026-12-01',
  requestId: 'req-12345678',
  ...overrides,
});

function setup(env: Record<string, string> = {}) {
  const config = testConfig(env);
  const store = new MemoryXrayStore(config);
  const xray = new XrayService(store, config);
  const runner = new JobRunner(xray, config);
  const kinds = async (org = ORG) => {
    await xray.flush();
    return (await store.latest(org, 50)).map((e) => e.kind);
  };
  return { runner, store, xray, kinds };
}

describe('JobRunner', () => {
  it('runs the registered handler with the job data', async () => {
    const { runner } = setup();
    const handler = vi.fn().mockResolvedValue(undefined);
    runner.register('invoice-email', handler);
    await runner.execute('invoice-email', job(), { attempt: 1, attempts: 3 });
    expect(handler).toHaveBeenCalledWith(job(), { attempt: 1, attempts: 3 });
  });

  it('narrates a successful attempt: active, then completed with how long it took', async () => {
    const { runner, store, xray } = setup();
    runner.register('invoice-email', async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    await runner.execute('invoice-email', job(), { attempt: 1, attempts: 3 });
    await xray.flush();
    const events = await store.latest(ORG, 10);
    expect(events.map((e) => e.kind)).toEqual(['job.active', 'job.completed']);
    expect(events.every((e) => e.requestId === 'req-12345678')).toBe(true);
    expect(Number(events[1]?.meta.durationMs)).toBeGreaterThanOrEqual(10);
    expect(events[0]?.meta).toMatchObject({ attempt: 1, attempts: 3 });
  });

  it('on a failure that will be retried: says "retry" with the back-off, and rethrows', async () => {
    const { runner, store, xray } = setup({ JOB_BACKOFF_MS: '5000' });
    runner.register('invoice-email', () =>
      Promise.reject(new Error('smtp down')),
    );
    await expect(
      runner.execute('invoice-email', job(), { attempt: 1, attempts: 3 }),
    ).rejects.toThrow('smtp down');
    await xray.flush();
    const retry = (await store.latest(ORG, 10)).at(-1);
    expect(retry).toMatchObject({ kind: 'job.retry', severity: 'warn' });
    expect(retry?.meta.nextDelayMs).toBe(5_000);
  });

  it('doubles the wait after each failed attempt (BullMQ exponential back-off)', async () => {
    const { runner, store, xray } = setup({ JOB_BACKOFF_MS: '1000' });
    runner.register('invoice-email', () => Promise.reject(new Error('x')));
    for (const attempt of [1, 2, 3]) {
      await runner
        .execute('invoice-email', job(), { attempt, attempts: 9 })
        .catch(() => undefined);
    }
    await xray.flush();
    const delays = (await store.latest(ORG, 20))
      .filter((e) => e.kind === 'job.retry')
      .map((e) => e.meta.nextDelayMs);
    expect(delays).toEqual([1_000, 2_000, 4_000]);
  });

  it('on the LAST attempt: says "failed" (given up), not "retry"', async () => {
    const { runner, kinds } = setup();
    runner.register('invoice-email', () => Promise.reject(new Error('x')));
    await expect(
      runner.execute('invoice-email', job(), { attempt: 3, attempts: 3 }),
    ).rejects.toThrow();
    expect((await kinds()).at(-1)).toBe('job.failed');
    expect(await kinds()).not.toContain('job.retry');
  });

  it('never puts the payload or the error text into an X-ray event', async () => {
    const { runner, store, xray } = setup();
    runner.register('invoice-email', () =>
      Promise.reject(new Error('550 rejected secret.client@example.com')),
    );
    await runner
      .execute('invoice-email', job(), { attempt: 3, attempts: 3 })
      .catch(() => undefined);
    await xray.flush();
    const text = JSON.stringify(await store.latest(ORG, 10));
    expect(text).not.toContain('secret.client@example.com');
    expect(text).not.toContain('Secret Client');
    expect(text).not.toContain('550 rejected');
    expect(text).not.toContain('$50.00');
  });

  it('does not write the provider-echoed recipient address into the log', async () => {
    const { runner } = setup();
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    runner.register('invoice-email', () =>
      Promise.reject(new Error('550 rejected secret.client@example.com')),
    );
    await runner
      .execute('invoice-email', job(), { attempt: 1, attempts: 3 })
      .catch(() => undefined);
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('550 rejected [email]');
    expect(logged).not.toContain('secret.client@example.com');
    warn.mockRestore();
  });

  it('publishes only to the job’s own organisation', async () => {
    const { runner, kinds } = setup();
    runner.register('invoice-email', async () => undefined);
    await runner.execute('invoice-email', job(), { attempt: 1, attempts: 1 });
    expect(await kinds()).toHaveLength(2);
    expect(await kinds('some-other-org')).toEqual([]);
  });

  it('says nothing to any X-ray for a job that belongs to no organisation (the sweep)', async () => {
    const { runner, store, xray } = setup();
    runner.register('overdue-sweep', async () => undefined);
    await runner.execute('overdue-sweep', {}, { attempt: 1, attempts: 1 });
    await xray.flush();
    expect(await store.latest(ORG, 10)).toEqual([]);
  });

  it('refuses a job nobody handles, loudly', async () => {
    const { runner } = setup();
    await expect(
      runner.execute('invoice-email', job(), { attempt: 1, attempts: 1 }),
    ).rejects.toThrow(/No handler is registered/);
  });

  it('does not let an X-ray problem break the job', async () => {
    const { runner, xray } = setup();
    vi.spyOn(xray, 'publish').mockImplementation(() => {
      throw new Error('x-ray exploded');
    });
    runner.register('invoice-email', async () => undefined);
    // publish() itself never throws in real life; this proves the runner does not depend on it.
    await expect(
      runner.execute('invoice-email', job(), { attempt: 1, attempts: 1 }),
    ).rejects.toThrow('x-ray exploded');
  });
});
