import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { BullMqJobQueue } from '../src/core/jobs/bullmq-job-queue.js';
import { JobRunner } from '../src/core/jobs/job-runner.service.js';
import type { InvoiceEmailJob } from '../src/core/jobs/jobs.types.js';
import { MemoryXrayStore } from '../src/core/xray/memory-xray.store.js';
import { XrayService } from '../src/core/xray/xray.service.js';
import { testConfig } from './support/test-config.js';

const ORG = 'org-a';
const redisUrl = () => process.env.REDIS_URL as string;
const job = (n = 1): InvoiceEmailJob => ({
  organizationId: ORG,
  invoiceId: `inv-${n}`,
  delivery: 'send',
  to: 'client@example.com',
  organizationName: 'Acme',
  clientName: 'Client',
  number: `INV-000${n}`,
  amount: '$10.00',
  dueDate: '2026-12-01',
});
const until = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
  const stop = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > stop) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The REAL queue: BullMQ on real Redis, with a worker. Every test gets its own queue name and
 * removes everything it made, so nothing else in Redis is touched.
 */
describe('BullMqJobQueue (real Redis)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function harness(
    env: Record<string, string> = {},
    name = `test-jobs-${randomUUID()}`,
  ) {
    const config = testConfig({
      REDIS_URL: redisUrl(),
      JOBS_QUEUE_NAME: name,
      JOB_BACKOFF_MS: '100',
      EMAIL_JOB_ATTEMPTS: '3',
      OVERDUE_SWEEP_INTERVAL_MINUTES: '0',
      ...env,
    });
    const store = new MemoryXrayStore(config);
    const xray = new XrayService(store, config);
    const runner = new JobRunner(xray, config);
    const queue = new BullMqJobQueue(config, runner);
    cleanups.push(() => queue.onModuleDestroy());
    const kinds = async () => {
      await xray.flush();
      return (await store.latest(ORG, 50)).map((e) => e.kind);
    };
    return { config, store, xray, runner, queue, kinds, name };
  }

  /** Looks at the queue from outside, and removes everything in it afterwards. */
  function inspect(name: string) {
    const connection = new Redis(redisUrl(), { maxRetriesPerRequest: null });
    const inspector = new Queue(name, { connection });
    cleanups.unshift(async () => {
      await inspector.obliterate({ force: true });
      await inspector.close();
      connection.disconnect();
    });
    return inspector;
  }

  it('runs a queued job in the worker, once, with its data and attempt numbers', async () => {
    const h = harness();
    inspect(h.name);
    const handler = vi.fn().mockResolvedValue(undefined);
    h.runner.register('invoice-email', handler);
    await h.queue.onModuleInit();

    await h.queue.add('invoice-email', job());
    await until(() => handler.mock.calls.length > 0);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      organizationId: ORG,
      invoiceId: 'inv-1',
    });
    expect(handler.mock.calls[0]?.[1]).toEqual({ attempt: 1, attempts: 3 });
    await until(async () => (await h.kinds()).includes('job.completed'));
    expect(await h.kinds()).toEqual(['job.active', 'job.completed']);
  });

  it('retries a failing job with doubling back-off, and narrates every step', async () => {
    const h = harness();
    inspect(h.name);
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('blip 1'))
      .mockRejectedValueOnce(new Error('blip 2'))
      .mockResolvedValue(undefined);
    h.runner.register('invoice-email', handler);
    await h.queue.onModuleInit();

    const started = Date.now();
    await h.queue.add('invoice-email', job());
    await until(async () => (await h.kinds()).includes('job.completed'));

    expect(await h.kinds()).toEqual([
      'job.active',
      'job.retry',
      'job.active',
      'job.retry',
      'job.active',
      'job.completed',
    ]);
    expect(handler.mock.calls.map((c) => c[1].attempt)).toEqual([1, 2, 3]);
    // Waited about 100 ms, then about 200 ms (the back-off doubles).
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    const retries = (await h.store.latest(ORG, 50)).filter(
      (e) => e.kind === 'job.retry',
    );
    expect(retries.map((e) => e.meta.nextDelayMs)).toEqual([100, 200]);
  });

  it('gives up after EMAIL_JOB_ATTEMPTS, says so, and keeps the job in the failed set', async () => {
    const h = harness();
    const inspector = inspect(h.name);
    const handler = vi.fn().mockRejectedValue(new Error('smtp down'));
    h.runner.register('invoice-email', handler);
    await h.queue.onModuleInit();

    await h.queue.add('invoice-email', job());
    await until(async () => (await h.kinds()).includes('job.failed'));
    await until(async () => (await inspector.getFailedCount()) === 1);

    expect(handler).toHaveBeenCalledTimes(3);
    expect((await h.kinds()).at(-1)).toBe('job.failed');
    expect(await h.kinds()).not.toContain('job.completed');
    const [failed] = await inspector.getFailed();
    expect(failed?.failedReason).toBe('smtp down');
    expect(failed?.attemptsMade).toBe(3);
  });

  it('ignores a second job with the same id (the same invoice is never emailed twice)', async () => {
    const h = harness();
    inspect(h.name);
    const handler = vi.fn().mockResolvedValue(undefined);
    h.runner.register('invoice-email', handler);
    await h.queue.onModuleInit();

    await h.queue.add('invoice-email', job(), { jobId: 'invoice-email-inv-1' });
    await h.queue.add('invoice-email', job(), { jobId: 'invoice-email-inv-1' });
    await until(() => handler.mock.calls.length > 0);
    await pause(400);
    // Even after the first finished, the id is still known, so a late duplicate is ignored too.
    await h.queue.add('invoice-email', job(), { jobId: 'invoice-email-inv-1' });
    await pause(400);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('runs different jobs independently', async () => {
    const h = harness();
    inspect(h.name);
    const handler = vi.fn().mockResolvedValue(undefined);
    h.runner.register('invoice-email', handler);
    await h.queue.onModuleInit();
    await h.queue.add('invoice-email', job(1), { jobId: 'invoice-email-1' });
    await h.queue.add('invoice-email', job(2), { jobId: 'invoice-email-2' });
    await until(() => handler.mock.calls.length === 2);
    expect(
      handler.mock.calls
        .map((c) => c[0].invoiceId)
        .sort((a: string, b: string) => a.localeCompare(b)),
    ).toEqual(['inv-1', 'inv-2']);
  });

  it('with WORKER_ENABLED=false this process only queues; another process runs the job', async () => {
    const apiOnly = harness({ WORKER_ENABLED: 'false' });
    const inspector = inspect(apiOnly.name);
    const apiHandler = vi.fn().mockResolvedValue(undefined);
    apiOnly.runner.register('invoice-email', apiHandler);
    await apiOnly.queue.onModuleInit();

    await apiOnly.queue.add('invoice-email', job());
    await pause(600);
    expect(apiHandler).not.toHaveBeenCalled();
    expect(await inspector.getWaitingCount()).toBe(1);

    // A separate worker process (same queue name) picks it up.
    const worker = harness({ WORKER_ENABLED: 'true' }, apiOnly.name);
    const workerHandler = vi.fn().mockResolvedValue(undefined);
    worker.runner.register('invoice-email', workerHandler);
    await worker.queue.onModuleInit();
    await until(() => workerHandler.mock.calls.length > 0);
    expect(workerHandler).toHaveBeenCalledTimes(1);
    expect(apiHandler).not.toHaveBeenCalled();
  });

  describe('the overdue sweep schedule', () => {
    const schedulers = async (inspector: Queue) =>
      (await inspector.getJobSchedulers()).map((s) => ({
        key: s.key,
        every: s.every,
      }));

    it('is created once, at the configured interval, and survives restarts without duplicates', async () => {
      const h = harness({ OVERDUE_SWEEP_INTERVAL_MINUTES: '5' });
      const inspector = inspect(h.name);
      h.runner.register('overdue-sweep', vi.fn().mockResolvedValue(undefined));
      await h.queue.onModuleInit();
      expect(await schedulers(inspector)).toEqual([
        { key: 'overdue-sweep', every: 5 * 60_000 },
      ]);

      // A second process starting (or this one restarting) must not add another.
      const second = harness({ OVERDUE_SWEEP_INTERVAL_MINUTES: '5' }, h.name);
      second.runner.register(
        'overdue-sweep',
        vi.fn().mockResolvedValue(undefined),
      );
      await second.queue.onModuleInit();
      expect(await schedulers(inspector)).toHaveLength(1);
    });

    it('is removed when the interval is set to 0 (the sweep is switched off)', async () => {
      const on = harness({ OVERDUE_SWEEP_INTERVAL_MINUTES: '5' });
      const inspector = inspect(on.name);
      on.runner.register('overdue-sweep', vi.fn().mockResolvedValue(undefined));
      await on.queue.onModuleInit();
      expect(await schedulers(inspector)).toHaveLength(1);

      const off = harness({ OVERDUE_SWEEP_INTERVAL_MINUTES: '0' }, on.name);
      off.runner.register(
        'overdue-sweep',
        vi.fn().mockResolvedValue(undefined),
      );
      await off.queue.onModuleInit();
      expect(await schedulers(inspector)).toEqual([]);
    });

    it('is still created when Redis is not ready at start-up: boot is not blocked, a background retry finishes the job', async () => {
      const h = harness({ OVERDUE_SWEEP_INTERVAL_MINUTES: '5' });
      const inspector = inspect(h.name);
      h.runner.register('overdue-sweep', vi.fn().mockResolvedValue(undefined));
      // The first attempt fails; after that the spy passes straight through to the real method.
      const spy = vi
        .spyOn(Queue.prototype, 'upsertJobScheduler')
        .mockRejectedValueOnce(new Error('not ready'));
      cleanups.push(async () => {
        spy.mockRestore();
      });

      const started = Date.now();
      await h.queue.onModuleInit(); // does not wait for the retry
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(await schedulers(inspector)).toEqual([]);

      // The retry runs on its own a few seconds later and creates it.
      await until(
        async () => (await schedulers(inspector)).length === 1,
        12_000,
      );
      expect(spy).toHaveBeenCalledTimes(2);
    }, 30_000);

    it('does not create a schedule from an API-only process (the worker owns it)', async () => {
      const h = harness({
        OVERDUE_SWEEP_INTERVAL_MINUTES: '5',
        WORKER_ENABLED: 'false',
      });
      const inspector = inspect(h.name);
      await h.queue.onModuleInit();
      expect(await schedulers(inspector)).toEqual([]);
    });
  });

  it('fails fast, instead of hanging, when Redis is unreachable (so a request is never stuck on it)', async () => {
    const h = harness({
      REDIS_URL: 'redis://127.0.0.1:1',
      WORKER_ENABLED: 'false',
    });
    const started = Date.now();
    await expect(h.queue.add('invoice-email', job())).rejects.toBeInstanceOf(
      Error,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('shuts down cleanly, letting a running job finish', async () => {
    const h = harness();
    inspect(h.name);
    let finished = false;
    h.runner.register('invoice-email', async () => {
      await pause(300);
      finished = true;
    });
    await h.queue.onModuleInit();
    await h.queue.add('invoice-email', job());
    await until(async () => (await h.kinds()).includes('job.active'));
    await h.queue.onModuleDestroy(); // waits for the in-flight job
    expect(finished).toBe(true);
  });
});
