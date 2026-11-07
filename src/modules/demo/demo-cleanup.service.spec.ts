import { Logger } from '@nestjs/common';
import { testConfig } from '../../../test/support/test-config.js';
import type { PrismaService } from '../../core/prisma/prisma.service.js';
import { DemoCleanupService } from './demo-cleanup.service.js';

function fakePrisma(overrides: { findMany?: () => Promise<unknown> } = {}) {
  const findMany = vi.fn(overrides.findMany ?? (() => Promise.resolve([])));
  const deleteMany = vi.fn(() => Promise.resolve({ count: 0 }));
  const prisma = {
    organization: { findMany },
    user: { deleteMany },
  } as unknown as PrismaService;
  return { prisma, findMany, deleteMany };
}

describe('DemoCleanupService', () => {
  let errorLog: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    errorLog = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('the timer', () => {
    it('is OFF when the interval is 0', () => {
      const { prisma } = fakePrisma();
      const service = new DemoCleanupService(
        prisma,
        testConfig({ DEMO_PURGE_INTERVAL_MINUTES: '0' }),
      );
      service.onModuleInit();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('runs a purge every N minutes, and stops when the app shuts down', async () => {
      const { prisma, findMany } = fakePrisma();
      const service = new DemoCleanupService(
        prisma,
        testConfig({ DEMO_PURGE_INTERVAL_MINUTES: '5' }),
      );
      service.onModuleInit();
      expect(findMany).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(findMany).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(findMany).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(findMany).toHaveBeenCalledTimes(2);

      await service.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(findMany).toHaveBeenCalledTimes(2); // nothing after shutdown
      expect(vi.getTimerCount()).toBe(0);
    });

    it('never keeps the process alive by itself (the timer is unref’d)', () => {
      const { prisma } = fakePrisma();
      const service = new DemoCleanupService(
        prisma,
        testConfig({ DEMO_PURGE_INTERVAL_MINUTES: '5' }),
      );
      service.onModuleInit();
      const timer = (service as unknown as { timer: { hasRef: () => boolean } })
        .timer;
      expect(timer.hasRef()).toBe(false);
      void service.onModuleDestroy();
    });
  });

  describe('runOnce', () => {
    it('never lets a failure escape into the timer, logs it, and works again afterwards', async () => {
      let fail = true;
      const { prisma, findMany } = fakePrisma({
        findMany: () =>
          fail ? Promise.reject(new Error('db down')) : Promise.resolve([]),
      });
      const service = new DemoCleanupService(prisma, testConfig());

      await expect(service.runOnce()).resolves.toEqual({
        organizations: 0,
        users: 0,
      });
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('db down'));

      fail = false;
      await expect(service.runOnce()).resolves.toEqual({
        organizations: 0,
        users: 0,
      });
      expect(findMany).toHaveBeenCalledTimes(2);
    });

    it('never overlaps itself: callers during a run share it', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { prisma, findMany } = fakePrisma({
        findMany: () => gate.then(() => []),
      });
      const service = new DemoCleanupService(prisma, testConfig());

      const first = service.runOnce();
      const second = service.runOnce();
      expect(second).toBe(first);
      release();
      await first;
      expect(findMany).toHaveBeenCalledTimes(1);

      await service.runOnce(); // a later run is a new run
      expect(findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('purgeExpired', () => {
    it('only looks at demo organisations past their expiry, oldest first, never the sample, one batch at a time', async () => {
      const { prisma, findMany } = fakePrisma();
      const service = new DemoCleanupService(
        prisma,
        testConfig({ DEMO_PURGE_BATCH_SIZE: '7' }),
      );
      const now = new Date('2026-01-01T12:00:00Z');
      await service.purgeExpired(now);
      expect(findMany).toHaveBeenCalledWith({
        where: {
          isDemo: true,
          demoExpiresAt: { lte: now },
          slug: { not: 'acme-studio-template' },
        },
        orderBy: { demoExpiresAt: 'asc' },
        take: 7,
        select: { slug: true },
      });
    });

    it('sweeps only DEMO users with no organisation that are older than a sandbox’s lifetime', async () => {
      const { prisma, deleteMany } = fakePrisma();
      const service = new DemoCleanupService(
        prisma,
        testConfig({ DEMO_TTL_HOURS: '6' }),
      );
      const now = new Date('2026-01-01T12:00:00Z');
      await service.purgeExpired(now);
      expect(deleteMany).toHaveBeenCalledWith({
        where: {
          isDemo: true,
          memberships: { none: {} },
          createdAt: { lte: new Date('2026-01-01T06:00:00Z') },
        },
      });
    });
  });
});
