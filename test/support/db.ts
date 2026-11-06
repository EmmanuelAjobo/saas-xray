import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { testDatabaseUrl } from './test-database-url.js';

export function createTestDb(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: testDatabaseUrl() }),
  });
}

/**
 * Empties every table (but keeps the schema and Prisma's migration history).
 *
 * Deletes from the three "root" tables and lets the foreign-key cascades remove the rest.
 * That is ~1000x faster than TRUNCATE here (TRUNCATE rewrites 18 table files and fsyncs
 * each: ~6 s per call on Docker Desktop, versus ~5 ms), and it exercises the same
 * cascade rules production relies on.
 *
 * Safety net: if a table is added that no root cascades to, this throws and names it,
 * instead of silently leaking rows from one test into the next.
 */
export async function resetDb(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe('DELETE FROM "Organization"');
  await db.$executeRawUnsafe('DELETE FROM "User"');
  await db.$executeRawUnsafe('DELETE FROM "StripeEvent"');

  const tables = await db.$queryRaw<
    { tablename: string }[]
  >`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const counts = await db.$queryRawUnsafe<{ tablename: string }[]>(
    tables
      .map(
        ({ tablename }) =>
          `(SELECT '${tablename}'::text AS tablename FROM "${tablename}" LIMIT 1)`,
      )
      .join(' UNION ALL '),
  );
  if (counts.length > 0) {
    throw new Error(
      `resetDb left rows in: ${counts.map((c) => c.tablename).join(', ')}. ` +
        'A new table is not covered by the root deletes; add it to resetDb().',
    );
  }
}

// ── Small factories: just enough valid rows to build scenarios ──

export const createOrg = (db: PrismaClient, slug = 'org-a') =>
  db.organization.create({ data: { name: slug, slug } });

export const createUser = (db: PrismaClient, email = 'ada@example.com') =>
  db.user.create({ data: { email, name: email } });

export const createClient = (
  db: PrismaClient,
  organizationId: string,
  email = 'client@example.com',
) => db.client.create({ data: { organizationId, name: email, email } });

export const createInvoice = (
  db: PrismaClient,
  organizationId: string,
  clientId: string,
  number = 'INV-0001',
) =>
  db.invoice.create({
    data: { organizationId, clientId, number, totalCents: 1000 },
  });
