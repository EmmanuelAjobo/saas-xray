import { Logger } from '@nestjs/common';
import { testConfig } from '../../../test/support/test-config.js';
import { BackgroundTasks } from '../background/background-tasks.service.js';
import type { RequestContextService } from '../context/request-context.service.js';
import { MemoryXrayStore } from '../xray/memory-xray.store.js';
import { eventTime } from '../xray/xray.clock.js';
import { XrayService } from '../xray/xray.service.js';
import { XrayTrace, runInTrace } from '../xray/xray.trace.js';
import { JobRunner } from './job-runner.service.js';
import { JobsService } from './jobs.service.js';
import type { InvoiceEmailJob, JobQueue } from './jobs.types.js';

const data = (): InvoiceEmailJob => ({
  organizationId: 'org-a',
  invoiceId: 'inv-1',
  delivery: 'send',
  to: 'client@example.com',
  organizationName: 'Acme',
  clientName: 'Client',
  number: 'INV-0001',
  amount: '$50.00',
  dueDate: '2026-12-01',
});

/** `null` means "no request is running" (a scheduled job), unlike the default. */
function setup(requestId: string | null = 'req-12345678') {
  const config = testConfig();
  const added: Array<{ name: string; data: unknown; options: unknown }> = [];
  let failWith: Error | undefined;
  const queue: JobQueue = {
    add: (name, jobData, options) => {
      if (failWith) return Promise.reject(failWith);
      added.push({ name, data: jobData, options });
      return Promise.resolve();
    },
  };
  const store = new MemoryXrayStore(config);
  const xray = new XrayService(store, config);
  const runner = new JobRunner(xray, config);
  const handler = vi.fn().mockResolvedValue(undefined);
  runner.register('invoice-email', handler);
  const background = new BackgroundTasks();
  const context = {
    requestId: requestId ?? undefined,
  } as unknown as RequestContextService;
  const service = new JobsService(queue, runner, background, config, context);
  return {
    service,
    added,
    handler,
    background,
    breakQueue: () => (failWith = new Error('redis is down')),
  };
}

describe('JobsService.enqueue', () => {
  it('queues the job with the given id, and ties it to the current request', async () => {
    const { service, added } = setup();
    await service.enqueue('invoice-email', data(), {
      jobId: 'invoice-email-inv-1',
    });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      name: 'invoice-email',
      options: { jobId: 'invoice-email-inv-1' },
      data: { organizationId: 'org-a', requestId: 'req-12345678' },
    });
  });

  it('adds no request id when there is no request (a scheduled job)', async () => {
    const { service, added } = setup(null);
    await service.enqueue('invoice-email', data());
    expect(added[0]?.data).not.toHaveProperty('requestId');
  });

  it("tells the click's X-ray card that the work was queued", async () => {
    const { service } = setup();
    const trace = new XrayTrace('req-12345678');
    await runInTrace(trace, () => service.enqueue('invoice-email', data()));
    const events = trace.summarise({
      method: 'POST',
      route: '/x',
      status: 200,
      durationMs: 1,
    });
    expect(events.map((e) => e.kind)).toEqual(['job.queued', 'http.request']);
    expect(events[0]?.summary).toContain('so your click is not kept waiting');
  });

  it('timestamps "queued" BEFORE the queue takes the job (a worker can start before add() returns)', async () => {
    const config = testConfig();
    let queueSawTime = 0;
    const slowQueue: JobQueue = {
      add: async () => {
        queueSawTime = eventTime();
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    };
    const xray = new XrayService(new MemoryXrayStore(config), config);
    const service = new JobsService(
      slowQueue,
      new JobRunner(xray, config),
      new BackgroundTasks(),
      config,
      { requestId: 'req-12345678' } as unknown as RequestContextService,
    );
    const trace = new XrayTrace('req-12345678');
    await runInTrace(trace, () => service.enqueue('invoice-email', data()));
    const [queued] = trace.summarise({
      method: 'POST',
      route: '/x',
      status: 200,
      durationMs: 1,
    });
    expect(queued?.kind).toBe('job.queued');
    // Stamped when the work was handed over, not 30 ms later when add() finished.
    expect(queued?.ts).toBeLessThanOrEqual(queueSawTime);
  });

  it('puts nothing but its own label in the queued event (no payload)', async () => {
    const { service } = setup();
    const trace = new XrayTrace('req-12345678');
    await runInTrace(trace, () => service.enqueue('invoice-email', data()));
    const text = JSON.stringify(
      trace.summarise({
        method: 'POST',
        route: '/x',
        status: 200,
        durationMs: 1,
      }),
    );
    expect(text).not.toContain('client@example.com');
    expect(text).not.toContain('$50.00');
  });

  describe('when the queue is unreachable (Redis down)', () => {
    it('runs the work in-process instead, so the email is not lost to an outage', async () => {
      const { service, handler, background, breakQueue } = setup();
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      breakQueue();
      await expect(
        service.enqueue('invoice-email', data()),
      ).resolves.toBeUndefined();
      await background.drain();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]?.[0]).toMatchObject({
        organizationId: 'org-a',
        requestId: 'req-12345678',
      });
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('does not claim it was queued', async () => {
      const { service, breakQueue } = setup();
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      breakQueue();
      const trace = new XrayTrace('req-12345678');
      await runInTrace(trace, () => service.enqueue('invoice-email', data()));
      const kinds = trace
        .summarise({ method: 'POST', route: '/x', status: 200, durationMs: 1 })
        .map((e) => e.kind);
      expect(kinds).not.toContain('job.queued');
    });
  });
});
