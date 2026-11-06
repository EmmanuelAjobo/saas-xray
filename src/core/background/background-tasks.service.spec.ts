import { Logger } from '@nestjs/common';
import { BackgroundTasks } from './background-tasks.service.js';

describe('BackgroundTasks', () => {
  // Failures are logged on purpose; keep the test output quiet.
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the task and drain waits for it', async () => {
    const tasks = new BackgroundTasks();
    let done = false;
    tasks.run('slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      done = true;
    });
    expect(done).toBe(false);
    await tasks.drain();
    expect(done).toBe(true);
  });

  it('swallows a failing task: the caller never sees it, and later tasks still run', async () => {
    const tasks = new BackgroundTasks();
    let ran = false;
    tasks.run('boom', () => Promise.reject(new Error('smtp down')));
    tasks.run('fine', async () => {
      ran = true;
    });
    await expect(tasks.drain()).resolves.toBeUndefined();
    expect(ran).toBe(true);
  });

  it('swallows a task that throws synchronously', async () => {
    const tasks = new BackgroundTasks();
    tasks.run('sync-boom', () => {
      throw new Error('bad');
    });
    await expect(tasks.drain()).resolves.toBeUndefined();
  });

  it('drain also waits for tasks started by other tasks', async () => {
    const tasks = new BackgroundTasks();
    const order: string[] = [];
    tasks.run('outer', async () => {
      order.push('outer');
      tasks.run('inner', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('inner');
      });
    });
    await tasks.drain();
    expect(order).toEqual(['outer', 'inner']);
  });

  it('forgets finished tasks (no memory growth) and drain with nothing pending is instant', async () => {
    const tasks = new BackgroundTasks();
    for (let i = 0; i < 50; i++) tasks.run('t', async () => undefined);
    await tasks.drain();
    expect((tasks as unknown as { pending: Set<unknown> }).pending.size).toBe(
      0,
    );
    await expect(tasks.drain()).resolves.toBeUndefined();
  });

  it('does not log the failure payload, only the task name and message', async () => {
    const tasks = new BackgroundTasks();
    const logged: string[] = [];
    (tasks as unknown as { logger: { error: (m: string) => void } }).logger = {
      error: (message) => logged.push(message),
    };
    tasks.run('mail', () => Promise.reject(new Error('refused')));
    await tasks.drain();
    expect(logged).toEqual(['Background task "mail" failed: refused']);
  });
});
