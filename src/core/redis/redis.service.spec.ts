import { Logger } from '@nestjs/common';
import { testConfig } from '../../../test/support/test-config.js';
import { RedisService } from './redis.service.js';

const unreachable = testConfig({ REDIS_URL: 'redis://127.0.0.1:1' });

describe('RedisService (Redis unreachable)', () => {
  // The service logs every failed reconnect; keep that out of the test output.
  beforeAll(() => Logger.overrideLogger(false));

  it('does not crash the process: connection errors are handled, not thrown', async () => {
    const unhandled = vi.fn();
    process.on('uncaughtException', unhandled);
    const redis = new RedisService(unreachable);
    try {
      // Give ioredis time to attempt (and fail) a few connections.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('uncaughtException', unhandled);
      await redis.onModuleDestroy();
    }
  });

  it('fails commands quickly instead of hanging requests forever', async () => {
    const redis = new RedisService(unreachable);
    try {
      const started = Date.now();
      await expect(redis.client.ping()).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await redis.onModuleDestroy();
    }
  });

  it('shuts down cleanly', async () => {
    const redis = new RedisService(unreachable);
    await expect(redis.onModuleDestroy()).resolves.toBeUndefined();
  });
});
