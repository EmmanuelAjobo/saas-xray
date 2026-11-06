import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createOrg, createTestDb, resetDb } from './support/db.js';
import { testDatabaseUrl } from './support/test-database-url.js';

/** The test harness itself: its safety nets must be seen to fire, not just assumed. */
describe('integration test harness', () => {
  let db: PrismaClient;

  beforeAll(() => {
    db = createTestDb();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it('resetDb empties the database', async () => {
    await createOrg(db, 'will-be-wiped');
    await resetDb(db);
    expect(await db.organization.count()).toBe(0);
  });

  it('resetDb fails loudly if a table is not covered by the root deletes', async () => {
    await db.$executeRawUnsafe(
      'CREATE TABLE "HarnessProbe" (id int PRIMARY KEY)',
    );
    try {
      await db.$executeRawUnsafe('INSERT INTO "HarnessProbe" VALUES (1)');
      await expect(resetDb(db)).rejects.toThrow(/HarnessProbe/);
    } finally {
      await db.$executeRawUnsafe('DROP TABLE "HarnessProbe"');
    }
    await expect(resetDb(db)).resolves.toBeUndefined(); // healthy again once it is gone
  });

  describe('test database safety guard', () => {
    const original = process.env.TEST_DATABASE_URL;
    afterEach(() => {
      if (original === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = original;
    });

    it.each(['saas_xray', 'postgres', 'production', 'saas_xray_test_backup'])(
      'refuses to wipe a database named "%s"',
      (name) => {
        process.env.TEST_DATABASE_URL = `postgresql://u:p@localhost:5433/${name}`;
        expect(() => testDatabaseUrl()).toThrow(/must end with "_test"/);
      },
    );

    it('accepts a database whose name ends in _test', () => {
      process.env.TEST_DATABASE_URL =
        'postgresql://u:p@localhost:5433/other_test';
      expect(testDatabaseUrl()).toContain('other_test');
    });
  });
});
