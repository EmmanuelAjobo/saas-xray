import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { RedisThrottlerStorage } from '../src/core/rate-limit/redis-throttler.storage.js';
import { RedisService } from '../src/core/redis/redis.service.js';
import { testConfig } from './support/test-config.js';

/** The real Redis-backed rate limiter. Each test uses a unique name, so runs never collide. */
describe('RedisThrottlerStorage (real Redis)', () => {
  let redis: RedisService;
  let storage: RedisThrottlerStorage;
  const name = () => `test-${randomUUID()}`;

  beforeAll(() => {
    redis = new RedisService(
      testConfig({ REDIS_URL: process.env.REDIS_URL as string }),
    );
    storage = new RedisThrottlerStorage(redis);
  });
  afterAll(async () => {
    await redis.onModuleDestroy();
  });

  it('counts hits and blocks only after the limit is exceeded', async () => {
    const n = name();
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await storage.increment('1.2.3.4', 60_000, 3, 0, n));
    }
    expect(results.map((r) => r.totalHits)).toEqual([1, 2, 3, 4]);
    expect(results.map((r) => r.isBlocked)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it('reports the time left in the window in seconds', async () => {
    const result = await storage.increment('k', 60_000, 5, 0, name());
    expect(result.timeToExpire).toBeGreaterThan(55);
    expect(result.timeToExpire).toBeLessThanOrEqual(60);
  });

  it('keeps separate counters per key and per throttler name', async () => {
    const n = name();
    await storage.increment('a', 60_000, 1, 0, n);
    expect((await storage.increment('a', 60_000, 1, 0, n)).isBlocked).toBe(
      true,
    );
    expect((await storage.increment('b', 60_000, 1, 0, n)).isBlocked).toBe(
      false,
    );
    expect((await storage.increment('a', 60_000, 1, 0, name())).isBlocked).toBe(
      false,
    );
  });

  it('the window resets after it elapses', async () => {
    const n = name();
    await storage.increment('k', 1500, 1, 0, n);
    expect((await storage.increment('k', 1500, 1, 0, n)).isBlocked).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1700));
    const after = await storage.increment('k', 1500, 1, 0, n);
    expect(after).toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('is atomic under concurrency: exactly `limit` requests get through', async () => {
    const n = name();
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        storage.increment('burst', 60_000, 10, 0, n),
      ),
    );
    expect(results.filter((r) => !r.isBlocked)).toHaveLength(10);
    expect(results.filter((r) => r.isBlocked)).toHaveLength(40);
  });

  it('holds a block for blockDuration even after the window would have reset', async () => {
    const n = name();
    await storage.increment('k', 1000, 1, 6_000, n);
    const blocked = await storage.increment('k', 1000, 1, 6_000, n);
    expect(blocked.isBlocked).toBe(true);
    expect(blocked.timeToBlockExpire).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect((await storage.increment('k', 1000, 1, 6_000, n)).isBlocked).toBe(
      true,
    );
  });

  it('fails open, not closed, when Redis is unreachable', async () => {
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const broken = new RedisThrottlerStorage({
      client: { eval: () => Promise.reject(new Error('ECONNREFUSED')) },
    } as unknown as RedisService);
    expect(await broken.increment('k', 60_000, 1, 0, 'x')).toEqual({
      totalHits: 0,
      timeToExpire: 0,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('allowing request'),
    );
    log.mockRestore();
  });
});
