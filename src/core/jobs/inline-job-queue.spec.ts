import { testConfig } from '../../../test/support/test-config.js';
import { BackgroundTasks } from '../background/background-tasks.service.js';
import { MemoryXrayStore } from '../xray/memory-xray.store.js';
import { XrayService } from '../xray/xray.service.js';
import { InlineJobQueue } from './inline-job-queue.js';
import { JobRunner } from './job-runner.service.js';
import type { InvoiceEmailJob } from './jobs.types.js';

const data = (): InvoiceEmailJob => ({
  organizationId: 'org-a',
  invoiceId: 'inv-1',
  delivery: 'send',
  to: 'c@example.com',
  organizationName: 'Acme',
  clientName: 'C',
  number: 'INV-0001',
  amount: '$1.00',
  dueDate: '2026-12-01',
});

function setup(env: Record<string, string> = {}) {
  const config = testConfig(env);
  const xray = new XrayService(new MemoryXrayStore(config), config);
  const runner = new JobRunner(xray, config);
  const background = new BackgroundTasks();
  return {
    runner,
    background,
    queue: new InlineJobQueue(runner, background, config),
  };
}

describe('InlineJobQueue', () => {
  it('runs the job once when it works, with attempt 1 of EMAIL_JOB_ATTEMPTS', async () => {
    const { runner, queue, background } = setup({ EMAIL_JOB_ATTEMPTS: '3' });
    const handler = vi.fn().mockResolvedValue(undefined);
    runner.register('invoice-email', handler);
    await queue.add('invoice-email', data());
    await background.drain();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[1]).toEqual({ attempt: 1, attempts: 3 });
  });

  it('retries a failing job up to EMAIL_JOB_ATTEMPTS times in total, then stops', async () => {
    const { runner, queue, background } = setup({ EMAIL_JOB_ATTEMPTS: '3' });
    const handler = vi.fn().mockRejectedValue(new Error('smtp down'));
    runner.register('invoice-email', handler);
    await queue.add('invoice-email', data());
    await background.drain();
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls.map((c) => c[1].attempt)).toEqual([1, 2, 3]);
  });

  it('stops retrying as soon as an attempt works', async () => {
    const { runner, queue, background } = setup({ EMAIL_JOB_ATTEMPTS: '5' });
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue(undefined);
    runner.register('invoice-email', handler);
    await queue.add('invoice-email', data());
    await background.drain();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('lets a caller wait for the work through BackgroundTasks, and never rejects', async () => {
    const { runner, queue, background } = setup({ EMAIL_JOB_ATTEMPTS: '1' });
    runner.register('invoice-email', () => Promise.reject(new Error('x')));
    await expect(queue.add('invoice-email', data())).resolves.toBeUndefined();
    await expect(background.drain()).resolves.toBeUndefined();
  });
});
