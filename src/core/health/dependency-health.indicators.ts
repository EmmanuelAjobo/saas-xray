import { Injectable, Logger } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { AppConfigService } from '../config/config.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

/**
 * Readiness checks for backing services.
 *
 * On failure the response says only "unavailable". The real error (which may contain
 * hostnames and ports) goes to the logs: /health/ready is public and must not leak topology.
 */
@Injectable()
export class DependencyHealthIndicators {
  private readonly logger = new Logger(DependencyHealthIndicators.name);

  constructor(
    private readonly indicator: HealthIndicatorService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
  ) {}

  postgres(key = 'postgres') {
    return this.indicator
      .check(key)
      .attempt(async () => {
        try {
          await this.prisma.$queryRaw`SELECT 1`;
        } catch (error) {
          this.logger.error(`Postgres health check failed: ${describe(error)}`);
          throw new Error('unavailable');
        }
      })
      .withTimeout(this.config.get('HEALTH_CHECK_TIMEOUT_MS'));
  }

  redisPing(key = 'redis') {
    return this.indicator
      .check(key)
      .attempt(async () => {
        try {
          const reply = await this.redis.client.ping();
          if (reply !== 'PONG') {
            throw new Error(`unexpected PING reply: ${String(reply)}`);
          }
        } catch (error) {
          this.logger.error(`Redis health check failed: ${describe(error)}`);
          throw new Error('unavailable');
        }
      })
      .withTimeout(this.config.get('HEALTH_CHECK_TIMEOUT_MS'));
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
