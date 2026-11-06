import { testConfig } from '../../../test/support/test-config.js';
import { PrismaService } from './prisma.service.js';

// Port 1 is reserved and nothing listens there: the connection is refused immediately.
const unreachable = testConfig({
  DATABASE_URL: 'postgresql://postgres:supersecretpw@127.0.0.1:1/nope',
});

describe('PrismaService (database unreachable)', () => {
  it('fails fast at boot with an actionable message', async () => {
    const prisma = new PrismaService(unreachable);
    try {
      await expect(prisma.onModuleInit()).rejects.toThrow(
        /Cannot reach the database/,
      );
    } finally {
      await prisma.onModuleDestroy();
    }
  });

  it('does not leak the password in the startup error', async () => {
    const prisma = new PrismaService(unreachable);
    try {
      const error = await prisma.onModuleInit().then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(`${error?.message}\n${error?.stack}`).not.toContain(
        'supersecretpw',
      );
    } finally {
      await prisma.onModuleDestroy();
    }
  });

  it('shuts down cleanly even though it never connected', async () => {
    const prisma = new PrismaService(unreachable);
    await expect(prisma.onModuleDestroy()).resolves.toBeUndefined();
  });
});
