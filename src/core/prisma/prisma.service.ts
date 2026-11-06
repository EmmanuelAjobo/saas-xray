import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { AppConfigService } from '../config/config.service.js';

/**
 * The one database client.
 *
 * Fails fast: at boot it runs a real query, so a wrong DATABASE_URL or an unreachable
 * database stops the app from starting (the host then restarts it and alerts) instead of
 * booting "healthy" and failing every request. `$connect()` alone is not enough: with the
 * driver adapter it is lazy and succeeds without touching the network.
 *
 * Milestone 5 extends this client with the tenant-scoping extension.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: AppConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL'),
        connectionTimeoutMillis: config.get('DATABASE_CONNECTION_TIMEOUT_MS'),
        max: config.get('DATABASE_POOL_MAX'),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$queryRaw`SELECT 1`;
    } catch (error) {
      throw new Error(
        `Cannot reach the database (check DATABASE_URL and that Postgres is running): ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
