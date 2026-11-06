import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { envSchema } from '../core/config/env.schema.js';
import { loadDotEnv } from '../core/config/load-env.js';
import {
  removeDemoOrganization,
  seedDemoOrganization,
} from './demo-template.js';

/**
 * `npm run db:seed`: (re)creates the local sample organisation. Safe to run repeatedly: it
 * removes the previous sample first, so you always end up with exactly one fresh copy.
 */
async function main(): Promise<void> {
  loadDotEnv();

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV is production.');
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set (copy .env.example to .env).');
  }

  // Same defaults and validation as the app, read from the same variables.
  const { shape } = envSchema;
  const connectionTimeoutMillis = shape.DATABASE_CONNECTION_TIMEOUT_MS.parse(
    process.env.DATABASE_CONNECTION_TIMEOUT_MS || undefined,
  );
  const ttlHours = shape.DEMO_TTL_HOURS.parse(
    process.env.DEMO_TTL_HOURS || undefined,
  );

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString, connectionTimeoutMillis }),
  });
  try {
    const replaced = await removeDemoOrganization(prisma);
    const result = await seedDemoOrganization(prisma, { ttlHours });
    console.log(
      `${replaced ? 'Replaced' : 'Created'} sample organisation "${result.slug}" ` +
        `(${result.counts.users} people, ${result.counts.tasks} tasks, ` +
        `${result.counts.clients} clients, ${result.counts.invoices} invoices).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
